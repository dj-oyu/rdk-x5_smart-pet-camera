/*
 * camera_pipeline.c - Camera Pipeline Implementation
 */

#include "camera_pipeline.h"
#include "hb_mem_mgr.h"
#include "isp_brightness.h"
#include "logger.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(hb_mem_graphic_buf_t) == HB_MEM_GRAPHIC_BUF_SIZE,
    "HB_MEM_GRAPHIC_BUF_SIZE must match sizeof(hb_mem_graphic_buf_t)");

char Pipeline_log_header[16];

int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height, int output_width,
                    int output_height, int fps, int bitrate) {
  int ret = 0;

  snprintf(Pipeline_log_header, sizeof(Pipeline_log_header), "Pipeline %d",
           camera_index);

  if (!pipeline)
    return -1;

  memset(pipeline, 0, sizeof(camera_pipeline_t));

  pipeline->camera_index = camera_index;
  pipeline->sensor_width = sensor_width;
  pipeline->sensor_height = sensor_height;
  pipeline->output_width = output_width;
  pipeline->output_height = output_height;
  pipeline->fps = fps;
  pipeline->bitrate = bitrate;

  LOG_INFO(Pipeline_log_header,
           "Creating pipeline for Camera %d (%dx%d@%dfps, %dkbps)",
           camera_index, output_width, output_height, fps, bitrate / 1000);

  // Open CameraControl shared memory (Phase 2: SHM-based activation)
  // Retry for up to 5 seconds since switcher_daemon may not have created it yet
  for (int i = 0; i < 50; i++) {
    pipeline->control_shm = shm_control_open();
    if (pipeline->control_shm) {
      break;
    }
    if (i == 0) {
      LOG_INFO(Pipeline_log_header, "Waiting for CameraControl SHM (%s)...",
               SHM_NAME_CONTROL);
    }
    usleep(100000); // 100ms
  }
  if (!pipeline->control_shm) {
    LOG_WARN(Pipeline_log_header,
             "CameraControl SHM not available, defaulting to inactive");
  } else {
    LOG_INFO(Pipeline_log_header, "CameraControl SHM opened: %s",
             SHM_NAME_CONTROL);
  }

  // Initialize memory manager
  ret = hb_mem_module_open();
  if (ret != 0) {
    LOG_ERROR(Pipeline_log_header, "hb_mem_module_open failed: %d", ret);
    return ret;
  }

  // Create VIO context
  ret = vio_create(&pipeline->vio, camera_index, sensor_width, sensor_height,
                   output_width, output_height, fps);
  if (ret != 0) {
    LOG_ERROR("Pipeline", "vio_create failed: %d", ret);
    goto error_cleanup;
  }

  // Create Encoder context
  ret = encoder_create(&pipeline->encoder, camera_index, output_width,
                       output_height, fps, bitrate);
  if (ret != 0) {
    LOG_ERROR("Pipeline", "encoder_create failed: %d", ret);
    goto error_cleanup;
  }

  // Open or create shared memory with fixed names (new design)
  // create_named() will open existing shared memory if already created by
  // camera_switcher_daemon Active camera NV12 (written only when active)
  pipeline->shm_active_nv12 =
      shm_frame_buffer_create_named(SHM_NAME_ACTIVE_FRAME);
  if (!pipeline->shm_active_nv12) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create active NV12 shared memory: %s",
              SHM_NAME_ACTIVE_FRAME);
    ret = -1;
    goto error_cleanup;
  }

  // Active camera H.264 (written only when active)
  pipeline->shm_active_h264 = shm_frame_buffer_create_named(SHM_NAME_STREAM);
  if (!pipeline->shm_active_h264) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create active H.264 shared memory: %s",
              SHM_NAME_STREAM);
    ret = -1;
    goto error_cleanup;
  }

  // Lightweight brightness shared memory (updated every brightness check)
  pipeline->shm_brightness = shm_brightness_create();
  if (!pipeline->shm_brightness) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create brightness shared memory: %s",
              SHM_NAME_BRIGHTNESS);
    ret = -1;
    goto error_cleanup;
  }

  // Zero-copy YOLO input (share_id based, no memcpy)
  // Phase 2: per-camera ZeroCopy SHM (zc_0 for DAY, zc_1 for NIGHT)
  const char *zerocopy_name = (camera_index == 0)
                                  ? SHM_NAME_ZEROCOPY_DAY
                                  : SHM_NAME_ZEROCOPY_NIGHT;
  pipeline->shm_yolo_zerocopy = shm_zerocopy_create(zerocopy_name);
  if (!pipeline->shm_yolo_zerocopy) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to create zero-copy shared memory: %s",
              zerocopy_name);
    ret = -1;
    goto error_cleanup;
  }
  LOG_INFO(Pipeline_log_header, "Zero-copy shared memory created: %s",
           zerocopy_name);

  // MJPEG input NV12 (640x480 from VSE Channel 2, always written when active, writable by web_monitor)
  pipeline->shm_mjpeg_frame =
      shm_frame_buffer_create_named(SHM_NAME_MJPEG_FRAME);
  if (!pipeline->shm_mjpeg_frame) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create MJPEG frame shared memory: %s",
              SHM_NAME_MJPEG_FRAME);
    ret = -1;
    goto error_cleanup;
  }

  // Create encoder thread (writes to active H.264 shm)
  ret = encoder_thread_create(&pipeline->encoder_thread, &pipeline->encoder,
                              pipeline->shm_active_h264, SHM_NAME_STREAM,
                              output_width, output_height);
  if (ret != 0) {
    LOG_ERROR(Pipeline_log_header, "encoder_thread_create failed: %d", ret);
    goto error_cleanup;
  }

  // Initialize low-light correction state (Phase 2)
  isp_lowlight_state_init(&pipeline->lowlight_state);

  LOG_INFO(Pipeline_log_header, "Pipeline created successfully");
  return 0;

error_cleanup:
  pipeline_destroy(pipeline);
  return ret;
}

int pipeline_start(camera_pipeline_t *pipeline) {
  if (!pipeline)
    return -1;

  // Start encoder thread first
  int ret = encoder_thread_start(&pipeline->encoder_thread);
  if (ret != 0) {
    LOG_ERROR(Pipeline_log_header, "encoder_thread_start failed: %d", ret);
    return ret;
  }

  // Start VIO
  ret = vio_start(&pipeline->vio);
  if (ret != 0) {
    LOG_ERROR(Pipeline_log_header, "vio_start failed: %d", ret);
    encoder_thread_stop(&pipeline->encoder_thread);
    return ret;
  }

  LOG_INFO(Pipeline_log_header, "Pipeline started (VIO + Encoder Thread)");
  return 0;
}

int pipeline_run(camera_pipeline_t *pipeline, volatile bool *running_flag) {
  if (!pipeline || !running_flag)
    return -1;

  pipeline->running_flag = running_flag;

  int frame_count = 0;
  struct timespec start_time, current_time, frame_timestamp;
  clock_gettime(CLOCK_MONOTONIC, &start_time);

  hbn_vnode_image_t vio_frame = {0};

  // Zero-copy: track pending YOLO frame for deferred release
  // The frame must not be released until consumer finishes processing
  hbn_vnode_image_t pending_yolo_frame = {0};
  bool has_pending_yolo_frame = false;

  LOG_INFO(Pipeline_log_header,
           "Starting capture loop (threaded encoder, 30fps NV12+H.264)...");

  while (*running_flag) {
    int ret;

    // Get NV12 frame from VIO
    ret = vio_get_frame(&pipeline->vio, &vio_frame, 2000);
    if (ret != 0) {
      // Error -43 (HBN_STATUS_NODE_DEQUE_ERROR) is transient during camera
      // switches - the VIO buffer isn't ready yet. Use DEBUG level to avoid log
      // spam. Non-active cameras may also fail to get frames.
      bool is_active = pipeline->control_shm &&
                       shm_control_get_active(pipeline->control_shm) == pipeline->camera_index;
      if (is_active && ret != -43) {
        LOG_WARN(Pipeline_log_header, "vio_get_frame failed: %d", ret);
      } else {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame failed: %d (active=%d)",
                  ret, is_active);
      }
      continue;
    }

    // Determine active state from CameraControl SHM (Phase 2)
    bool write_active = pipeline->control_shm &&
                        shm_control_get_active(pipeline->control_shm) == pipeline->camera_index;

    // Get ISP brightness statistics with throttling (using power-of-2 masks for fast bitwise AND)
    // - DAY camera active: every 8 frames (~3.75Hz) for fast DAY→NIGHT detection
    // - DAY camera inactive: every 64 frames (~2.1 sec) for NIGHT→DAY detection
    // - NIGHT camera: every 128 frames (~4.3 sec) for CLAHE decision in YOLO
    // NOTE: ISP lowlight correction is DISABLED - using CLAHE on YOLO side instead
    #define ISP_BRIGHTNESS_MASK_DAY_ACTIVE 7      // 8 frames when active (2^3 - 1)
    #define ISP_BRIGHTNESS_MASK_DAY_INACTIVE 63   // 64 frames when inactive (2^6 - 1)
    #define ISP_BRIGHTNESS_MASK_NIGHT 127         // 128 frames (~4.3 sec, 2^7 - 1)
    static isp_brightness_result_t cached_brightness = {.valid = false};
    static bool prev_active = false;

    // Detect camera switch: when this camera becomes active, reset brightness cache
    // and immediately fetch fresh brightness from ISP
    bool camera_just_activated = write_active && !prev_active;
    if (camera_just_activated) {
      cached_brightness.valid = false;
      LOG_INFO(Pipeline_log_header, "Camera activated, resetting brightness cache");
    }
    prev_active = write_active;

    // Determine brightness check interval based on camera type and state
    // Use bitwise AND for fast modulo with power-of-2 intervals
    bool is_day_camera = (pipeline->camera_index == 0);
    int brightness_mask;
    if (is_day_camera) {
      brightness_mask = write_active ? ISP_BRIGHTNESS_MASK_DAY_ACTIVE : ISP_BRIGHTNESS_MASK_DAY_INACTIVE;
    } else {
      brightness_mask = ISP_BRIGHTNESS_MASK_NIGHT;  // NIGHT camera: ~4.3 sec interval
    }
    bool is_brightness_frame = (frame_count & brightness_mask) == 0;

    // Both DAY and NIGHT cameras retrieve brightness
    // - DAY: used for camera switching decisions
    // - NIGHT: used for CLAHE decision in YOLO detector
    // Also fetch immediately when camera is just activated
    if (is_brightness_frame || camera_just_activated) {
      isp_get_brightness(pipeline->vio.isp_handle, &cached_brightness);
    }
    isp_brightness_result_t brightness_result = cached_brightness;

    // ISP lowlight correction is DISABLED to avoid frame drops
    // Image enhancement is now done via CLAHE preprocessing on the YOLO detector side

    // Debug: log flags every 30 frames
    if (frame_count % 30 == 0) {
      LOG_DEBUG(
          Pipeline_log_header,
          "Flags: is_active=%d, brightness=%.1f lux=%u zone=%d",
          write_active,
          brightness_result.brightness_avg, brightness_result.brightness_lux,
          brightness_result.zone);
    }

    if (write_active) {
      // Convert timeval to timespec
      clock_gettime(CLOCK_REALTIME, &frame_timestamp);

      Frame nv12_frame = {0};
      nv12_frame.width = pipeline->output_width;
      nv12_frame.height = pipeline->output_height;
      nv12_frame.format = 1; // NV12
      nv12_frame.frame_number = frame_count;
      nv12_frame.camera_id = pipeline->camera_index;
      nv12_frame.timestamp = frame_timestamp;

      // Apply brightness data from ISP
      isp_fill_frame_brightness(&nv12_frame, &brightness_result);
      nv12_frame.correction_applied = 0;

      // Calculate NV12 size from buffer metadata
      size_t nv12_size = 0;
      for (int i = 0; i < vio_frame.buffer.plane_cnt; i++) {
        nv12_size += vio_frame.buffer.size[i];
      }
      nv12_frame.data_size = nv12_size;

      // Copy NV12 data (Y plane + UV plane)
      if (nv12_size <= sizeof(nv12_frame.data)) {
        size_t offset = 0;
        for (int i = 0; i < vio_frame.buffer.plane_cnt; i++) {
          memcpy(nv12_frame.data + offset, vio_frame.buffer.virt_addr[i],
                 vio_frame.buffer.size[i]);
          offset += vio_frame.buffer.size[i];
        }

        // Write to active shared memory if camera is active
        if (write_active) {
          int write_ret =
              shm_frame_buffer_write(pipeline->shm_active_nv12, &nv12_frame);
          if (write_ret < 0) {
            LOG_WARN(Pipeline_log_header, "Failed to write NV12 to active shm");
          } else if (frame_count % 30 == 0) {
            LOG_DEBUG(Pipeline_log_header,
                      "Wrote NV12 frame#%d to active shm (idx=%d)", frame_count,
                      write_ret);
          }
        }

        // Probe mechanism removed (Phase 2) - brightness always available via SHM
      } else {
        LOG_WARN(Pipeline_log_header, "NV12 frame too large (%zu bytes)",
                 nv12_size);
      }
    }

    // Phase 2: Always update brightness in per-camera ZeroCopy SHM
    // Ensures switcher can read brightness from any camera's ZeroCopy (Phase 3)
    if (is_brightness_frame && brightness_result.valid &&
        pipeline->shm_yolo_zerocopy) {
      pipeline->shm_yolo_zerocopy->frame.brightness_avg =
          brightness_result.brightness_avg;
    }

    // Write brightness to lightweight shared memory
    // DAY camera (index 0) always writes - used for switching decisions
    // Frequency: active=~3.75Hz (8 frames), inactive=~0.47Hz (64 frames, ~2.1 sec)
    if (is_day_camera && is_brightness_frame && brightness_result.valid) {
      struct timespec now_ts;
      clock_gettime(CLOCK_REALTIME, &now_ts);
      CameraBrightness cam_brightness = {
          .frame_number = frame_count,
          .timestamp = now_ts,
          .brightness_avg = brightness_result.brightness_avg,
          .brightness_lux = brightness_result.brightness_lux,
          .brightness_zone = (uint8_t)brightness_result.zone,
          .correction_applied = pipeline->lowlight_state.correction_active ? 1 : 0,
      };
      shm_brightness_write(pipeline->shm_brightness, pipeline->camera_index,
                           &cam_brightness);
    }

    // Push frame to encoder thread only if camera is active
    if (write_active) {
      ret = encoder_thread_push_frame(
          &pipeline->encoder_thread,
          (uint8_t *)vio_frame.buffer.virt_addr[0], // Y plane
          (uint8_t *)vio_frame.buffer.virt_addr[1], // UV plane
          vio_frame.buffer.size[0],                 // Y size
          vio_frame.buffer.size[1],                 // UV size
          frame_count, pipeline->camera_index, frame_timestamp);

      if (ret != 0) {
        LOG_WARN(Pipeline_log_header, "Encoder queue full, frame %d dropped",
                 frame_count);
      }
    }

    // Release main VIO frame (always release after use)
    vio_release_frame(&pipeline->vio, &vio_frame);

    // Get YOLO input frame from VSE Channel 1 (1280x720 for ROI detection)
    // Zero-copy: share VIO buffer via share_id, consumer imports via hb_mem
    if (write_active) {
      hbn_vnode_image_t yolo_frame = {0};
      ret = vio_get_frame_ch1(&pipeline->vio, &yolo_frame, 10);
      if (ret == 0) {
        // Build zero-copy frame metadata
        ZeroCopyFrame zc_frame = {0};
        zc_frame.frame_number = frame_count;
        zc_frame.timestamp = frame_timestamp;
        zc_frame.camera_id = pipeline->camera_index;
        zc_frame.width = 1280;   // VSE Ch1 configured for 1280x720
        zc_frame.height = 720;
        zc_frame.format = 1;    // NV12
        zc_frame.brightness_avg = brightness_result.brightness_avg;
        zc_frame.correction_applied = 0;

        // Copy share_id and plane info from VIO buffer
        zc_frame.plane_cnt = yolo_frame.buffer.plane_cnt;
        for (int i = 0; i < yolo_frame.buffer.plane_cnt && i < ZEROCOPY_MAX_PLANES; i++) {
          zc_frame.share_id[i] = yolo_frame.buffer.share_id[i];
          zc_frame.plane_size[i] = yolo_frame.buffer.size[i];
        }

        // Copy full hb_mem_graphic_buf_t as raw bytes for import API
        memcpy(zc_frame.hb_mem_buf_data, &yolo_frame.buffer, sizeof(yolo_frame.buffer));

        // shm_zerocopy_write waits for consumer to signal consumed_sem
        // If it succeeds, consumer has finished with the PREVIOUS frame
        int zc_ret = shm_zerocopy_write(pipeline->shm_yolo_zerocopy, &zc_frame);
        if (zc_ret == 0) {
          // Consumer finished with previous frame - safe to release it now
          if (has_pending_yolo_frame) {
            vio_release_frame_ch1(&pipeline->vio, &pending_yolo_frame);
          }

          // Keep current frame as pending until consumer finishes
          pending_yolo_frame = yolo_frame;
          has_pending_yolo_frame = true;

          if (frame_count == 0) {
            // === DIAGNOSTIC: Dump ALL fields of hb_mem_graphic_buf_t ===
            // This is critical for diagnosing hb_mem_import failures on the consumer side.
            const hb_mem_graphic_buf_t *gb = &yolo_frame.buffer;

            LOG_INFO(Pipeline_log_header,
                     "=== hb_mem_graphic_buf_t DUMP (sizeof=%zu) ===",
                     sizeof(hb_mem_graphic_buf_t));
            LOG_INFO(Pipeline_log_header,
                     "  fd[3]          = {%d, %d, %d}",
                     gb->fd[0], gb->fd[1], gb->fd[2]);
            LOG_INFO(Pipeline_log_header,
                     "  plane_cnt      = %d", gb->plane_cnt);
            LOG_INFO(Pipeline_log_header,
                     "  format         = %d", gb->format);
            LOG_INFO(Pipeline_log_header,
                     "  width          = %d", gb->width);
            LOG_INFO(Pipeline_log_header,
                     "  height         = %d", gb->height);
            LOG_INFO(Pipeline_log_header,
                     "  stride         = %d", gb->stride);
            LOG_INFO(Pipeline_log_header,
                     "  vstride        = %d", gb->vstride);
            LOG_INFO(Pipeline_log_header,
                     "  is_contig      = %d", gb->is_contig);
            LOG_INFO(Pipeline_log_header,
                     "  share_id[3]    = {%d, %d, %d}",
                     gb->share_id[0], gb->share_id[1], gb->share_id[2]);
            LOG_INFO(Pipeline_log_header,
                     "  flags          = %ld", (long)gb->flags);
            LOG_INFO(Pipeline_log_header,
                     "  size[3]        = {%lu, %lu, %lu}",
                     (unsigned long)gb->size[0],
                     (unsigned long)gb->size[1],
                     (unsigned long)gb->size[2]);
            LOG_INFO(Pipeline_log_header,
                     "  virt_addr[3]   = {0x%lx, 0x%lx, 0x%lx}",
                     (unsigned long)gb->virt_addr[0],
                     (unsigned long)gb->virt_addr[1],
                     (unsigned long)gb->virt_addr[2]);
            LOG_INFO(Pipeline_log_header,
                     "  phys_addr[3]   = {0x%lx, 0x%lx, 0x%lx}",
                     (unsigned long)gb->phys_addr[0],
                     (unsigned long)gb->phys_addr[1],
                     (unsigned long)gb->phys_addr[2]);
            LOG_INFO(Pipeline_log_header,
                     "  offset[3]      = {%lu, %lu, %lu}",
                     (unsigned long)gb->offset[0],
                     (unsigned long)gb->offset[1],
                     (unsigned long)gb->offset[2]);

            // Also dump raw hex of first 64 bytes for cross-checking with Python side
            const uint8_t *raw = (const uint8_t *)gb;
            LOG_INFO(Pipeline_log_header,
                     "  raw[0..15]     = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
                     raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[16..31]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[16], raw[17], raw[18], raw[19], raw[20], raw[21], raw[22], raw[23],
                     raw[24], raw[25], raw[26], raw[27], raw[28], raw[29], raw[30], raw[31]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[32..47]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[32], raw[33], raw[34], raw[35], raw[36], raw[37], raw[38], raw[39],
                     raw[40], raw[41], raw[42], raw[43], raw[44], raw[45], raw[46], raw[47]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[48..63]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[48], raw[49], raw[50], raw[51], raw[52], raw[53], raw[54], raw[55],
                     raw[56], raw[57], raw[58], raw[59], raw[60], raw[61], raw[62], raw[63]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[64..79]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[64], raw[65], raw[66], raw[67], raw[68], raw[69], raw[70], raw[71],
                     raw[72], raw[73], raw[74], raw[75], raw[76], raw[77], raw[78], raw[79]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[80..95]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[80], raw[81], raw[82], raw[83], raw[84], raw[85], raw[86], raw[87],
                     raw[88], raw[89], raw[90], raw[91], raw[92], raw[93], raw[94], raw[95]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[96..111]   = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[96], raw[97], raw[98], raw[99], raw[100], raw[101], raw[102], raw[103],
                     raw[104], raw[105], raw[106], raw[107], raw[108], raw[109], raw[110], raw[111]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[112..127]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[112], raw[113], raw[114], raw[115], raw[116], raw[117], raw[118], raw[119],
                     raw[120], raw[121], raw[122], raw[123], raw[124], raw[125], raw[126], raw[127]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[128..143]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[128], raw[129], raw[130], raw[131], raw[132], raw[133], raw[134], raw[135],
                     raw[136], raw[137], raw[138], raw[139], raw[140], raw[141], raw[142], raw[143]);
            LOG_INFO(Pipeline_log_header,
                     "  raw[144..159]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[144], raw[145], raw[146], raw[147], raw[148], raw[149], raw[150], raw[151],
                     raw[152], raw[153], raw[154], raw[155], raw[156], raw[157], raw[158], raw[159]);
            LOG_INFO(Pipeline_log_header, "=== END hb_mem_graphic_buf_t DUMP ===");
          }
        } else {
          // Consumer busy (timeout) - release current frame, keep pending as-is
          vio_release_frame_ch1(&pipeline->vio, &yolo_frame);
        }
      } else if (frame_count % 30 == 0) {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame_ch1 failed: %d", ret);
      }
    }

    // Get MJPEG frame from VSE Channel 2 (640x480)
    // This frame is writable by web_monitor for overlay drawing (zero-copy)
    if (write_active) {
      hbn_vnode_image_t mjpeg_frame = {0};
      ret = vio_get_frame_ch2(&pipeline->vio, &mjpeg_frame, 10);
      if (ret == 0) {
        // Write MJPEG frame to shared memory
        Frame mjpeg_nv12_frame = {0};
        // VSE Ch2 is configured for 640x480 (see vio_lowlevel.c:240-252)
        mjpeg_nv12_frame.width = 640;
        mjpeg_nv12_frame.height = 480;
        mjpeg_nv12_frame.format = 1; // NV12
        mjpeg_nv12_frame.frame_number = frame_count;
        mjpeg_nv12_frame.camera_id = pipeline->camera_index;
        mjpeg_nv12_frame.timestamp = frame_timestamp;

        // Apply brightness data from ISP (same for all channels)
        isp_fill_frame_brightness(&mjpeg_nv12_frame, &brightness_result);
        mjpeg_nv12_frame.correction_applied = 0;

        // Calculate NV12 size for 640x480
        size_t mjpeg_size = 0;
        for (int i = 0; i < mjpeg_frame.buffer.plane_cnt; i++) {
          mjpeg_size += mjpeg_frame.buffer.size[i];
        }
        mjpeg_nv12_frame.data_size = mjpeg_size;

        // Copy MJPEG NV12 data
        if (mjpeg_size <= sizeof(mjpeg_nv12_frame.data)) {
          size_t offset = 0;
          for (int i = 0; i < mjpeg_frame.buffer.plane_cnt; i++) {
            memcpy(mjpeg_nv12_frame.data + offset, mjpeg_frame.buffer.virt_addr[i],
                   mjpeg_frame.buffer.size[i]);
            offset += mjpeg_frame.buffer.size[i];
          }

          int write_ret = shm_frame_buffer_write(pipeline->shm_mjpeg_frame, &mjpeg_nv12_frame);
          if (write_ret < 0) {
            LOG_WARN(Pipeline_log_header, "Failed to write MJPEG frame to shm");
          } else if (frame_count == 0 || frame_count % 30 == 0) {
            // Log first frame and every 30 frames to verify VSE Ch2 size
            if (frame_count == 0) {
              LOG_INFO(Pipeline_log_header,
                       "VSE Ch2 output: %dx%d, %zu bytes (expected 640x480, ~460KB)",
                       mjpeg_nv12_frame.width, mjpeg_nv12_frame.height, mjpeg_size);
            } else {
              LOG_DEBUG(Pipeline_log_header,
                        "Wrote MJPEG %dx%d frame#%d to shm (idx=%d)",
                        mjpeg_nv12_frame.width, mjpeg_nv12_frame.height, frame_count, write_ret);
            }
          }
        }

        vio_release_frame_ch2(&pipeline->vio, &mjpeg_frame);
      } else if (frame_count % 30 == 0) {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame_ch2 failed: %d", ret);
      }
    }

    frame_count++;

    // Print FPS every 30 frames
    if (frame_count % 30 == 0) {
      clock_gettime(CLOCK_MONOTONIC, &current_time);
      double elapsed = (current_time.tv_sec - start_time.tv_sec) +
                       (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
      double fps = frame_count / elapsed;
      LOG_DEBUG(Pipeline_log_header,
                "Frame %d, FPS: %.2f, H.264 encoded: %lu, dropped: %lu",
                frame_count, fps, pipeline->encoder_thread.frames_encoded,
                pipeline->encoder_thread.frames_dropped);
    }
  }

  // Release any pending zero-copy frame on exit
  if (has_pending_yolo_frame) {
    vio_release_frame_ch1(&pipeline->vio, &pending_yolo_frame);
    has_pending_yolo_frame = false;
  }

  // Final statistics
  clock_gettime(CLOCK_MONOTONIC, &current_time);
  double total_elapsed = (current_time.tv_sec - start_time.tv_sec) +
                         (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
  double avg_fps = frame_count / total_elapsed;
  LOG_INFO(Pipeline_log_header,
           "Completed: %d frames in %.2f seconds (avg FPS: %.2f)", frame_count,
           total_elapsed, avg_fps);
  LOG_INFO(Pipeline_log_header, "H.264 encoded: %lu, dropped: %lu",
           pipeline->encoder_thread.frames_encoded,
           pipeline->encoder_thread.frames_dropped);

  return 0;
}

void pipeline_stop(camera_pipeline_t *pipeline) {
  if (!pipeline)
    return;

  vio_stop(&pipeline->vio);
  encoder_thread_stop(&pipeline->encoder_thread);
  encoder_stop(&pipeline->encoder);

  LOG_INFO(Pipeline_log_header, "Pipeline stopped");
}

void pipeline_destroy(camera_pipeline_t *pipeline) {
  if (!pipeline)
    return;

  // Destroy encoder thread
  encoder_thread_destroy(&pipeline->encoder_thread);

  // Destroy encoder
  encoder_destroy(&pipeline->encoder);

  // Destroy VIO
  vio_destroy(&pipeline->vio);

  // Close CameraControl SHM (do not destroy - owned by camera_switcher_daemon)
  if (pipeline->control_shm) {
    shm_control_close(pipeline->control_shm);
    pipeline->control_shm = NULL;
  }

  // Close shared memory (do not destroy - owned by camera_switcher_daemon)
  if (pipeline->shm_active_nv12) {
    shm_frame_buffer_close(pipeline->shm_active_nv12);
    pipeline->shm_active_nv12 = NULL;
  }

  if (pipeline->shm_active_h264) {
    shm_frame_buffer_close(pipeline->shm_active_h264);
    pipeline->shm_active_h264 = NULL;
  }

  if (pipeline->shm_brightness) {
    shm_brightness_close(pipeline->shm_brightness);
    pipeline->shm_brightness = NULL;
  }

  if (pipeline->shm_yolo_zerocopy) {
    shm_zerocopy_close(pipeline->shm_yolo_zerocopy);
    pipeline->shm_yolo_zerocopy = NULL;
  }

  if (pipeline->shm_mjpeg_frame) {
    shm_frame_buffer_close(pipeline->shm_mjpeg_frame);
    pipeline->shm_mjpeg_frame = NULL;
  }

  // Close memory manager
  hb_mem_module_close();

  memset(pipeline, 0, sizeof(camera_pipeline_t));
  LOG_INFO(Pipeline_log_header, "Pipeline destroyed");
}
