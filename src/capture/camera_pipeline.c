/*
 * camera_pipeline.c - Camera Pipeline Implementation
 */

#include "camera_pipeline.h"
#include "hb_mem_mgr.h"
#include "isp_brightness.h"
#include "logger.h"
#include <hbn_isp_api.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

_Static_assert(sizeof(hb_mem_graphic_buf_t) == HB_MEM_GRAPHIC_BUF_SIZE,
    "HB_MEM_GRAPHIC_BUF_SIZE must match sizeof(hb_mem_graphic_buf_t)");

char Pipeline_log_header[16];

int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height, int output_width,
                    int output_height, int fps, int bitrate,
                    volatile int *active_camera) {
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

  // Active camera pointer (shared variable in same process, no SHM)
  pipeline->active_camera = active_camera;

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

  // H.265 zero-copy SHM (share_id based, no bitstream memcpy)
  pipeline->shm_h265_zc = shm_h265_zc_create(SHM_NAME_H265_ZC);
  if (!pipeline->shm_h265_zc) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to create H.265 zero-copy SHM: %s", SHM_NAME_H265_ZC);
    ret = -1;
    goto error_cleanup;
  }

  // Brightness: read directly from ISP by switcher thread (no SHM needed)

  // Zero-copy YOLO input (share_id based, no memcpy)
  // Phase 2: per-camera ZeroCopy SHM (zc_0 for DAY, zc_1 for NIGHT)
  pipeline->shm_yolo_zerocopy = shm_zerocopy_create(SHM_NAME_YOLO_ZC);
  if (!pipeline->shm_yolo_zerocopy) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to create zero-copy shared memory: %s",
              SHM_NAME_YOLO_ZC);
    ret = -1;
    goto error_cleanup;
  }
  LOG_INFO(Pipeline_log_header, "Zero-copy shared memory created: %s",
           SHM_NAME_YOLO_ZC);

  // MJPEG input NV12 (768x432 from VSE Channel 2, always written when active, writable by web_monitor)
  pipeline->shm_mjpeg_zc = shm_zerocopy_create(SHM_NAME_MJPEG_ZC);
  if (!pipeline->shm_mjpeg_zc) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create MJPEG frame shared memory: %s",
              SHM_NAME_MJPEG_ZC);
    ret = -1;
    goto error_cleanup;
  }

  // Create encoder thread (writes to active H.264 shm)
  ret = encoder_thread_create(&pipeline->encoder_thread, &pipeline->encoder,
                              pipeline->shm_h265_zc,
                              output_width, output_height,
                              pipeline->vio.vse_handle);
  if (ret != 0) {
    LOG_ERROR(Pipeline_log_header, "encoder_thread_create failed: %d", ret);
    goto error_cleanup;
  }

  // Initialize low-light correction state (Phase 2)
  isp_lowlight_state_init(&pipeline->lowlight_state);

  // Night camera 3DNR is set after first frame in pipeline_run

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

  uint64_t frame_number = 0; // Per-pipeline frame counter
  struct timespec start_time, current_time, frame_timestamp;
  clock_gettime(CLOCK_MONOTONIC, &start_time);

  hbn_vnode_image_t vio_frame = {0};

  // Zero-copy: track pending frames for deferred release
  // The frame must not be released until consumer finishes processing
  hbn_vnode_image_t pending_yolo_frame = {0};
  bool has_pending_yolo_frame = false;
  hbn_vnode_image_t pending_mjpeg_frame = {0};
  bool has_pending_mjpeg_frame = false;

  // Night camera AWB flag: set after ISP has processed enough frames to
  // fully initialize its AWB algorithm. Setting too early gets overwritten.
  bool night_awb_applied = (pipeline->camera_index != 1);

  LOG_INFO(Pipeline_log_header,
           "Starting capture loop (threaded encoder, 30fps NV12+H.264)...");

  // Per-pipeline state (not static — each thread has its own pipeline)
  isp_brightness_result_t cached_brightness = {.valid = false};
  bool prev_active = false;

  while (*running_flag) {
    int ret;

    // Non-active pipeline: sleep and skip everything
    bool write_active = pipeline->active_camera &&
                        *pipeline->active_camera == pipeline->camera_index;
    if (!write_active) {
      usleep(100000); // 100ms
      continue;
    }

    // Get NV12 frame from VIO
    ret = vio_get_frame(&pipeline->vio, &vio_frame, 2000);
    if (ret != 0) {
      // Error -43 (HBN_STATUS_NODE_DEQUE_ERROR) is transient during camera
      // switches - the VIO buffer isn't ready yet. Use DEBUG level to avoid log
      // spam. Non-active cameras may also fail to get frames.
      bool is_active = pipeline->active_camera &&
                       *pipeline->active_camera == pipeline->camera_index;
      if (is_active && ret != -43) {
        LOG_WARN(Pipeline_log_header, "vio_get_frame failed: %d", ret);
      } else {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame failed: %d (active=%d)",
                  ret, is_active);
      }
      continue;
    }

    // Night camera: set 3DNR after first frame (ISP needs to be running)
    if (frame_number == 1 && pipeline->camera_index == 1) {
      hbn_isp_3dnr_attr_t tnr_attr = {0};
      tnr_attr.mode = HBN_ISP_MODE_MANUAL;
      tnr_attr.manual_attr.tnr_strength = 128;
      int nr_ret = hbn_isp_set_3dnr_attr(pipeline->vio.isp_handle, &tnr_attr);
      if (nr_ret != 0) {
        LOG_WARN(Pipeline_log_header, "Night 3DNR setup failed: %d (retrying at frame 30)", nr_ret);
      } else {
        LOG_INFO(Pipeline_log_header, "Night camera 3DNR set to 128 (max)");
      }
    }
    // Retry 3DNR at frame 30 if first attempt failed
    if (frame_number == 30 && pipeline->camera_index == 1) {
      hbn_isp_3dnr_attr_t tnr_attr = {0};
      tnr_attr.mode = HBN_ISP_MODE_MANUAL;
      tnr_attr.manual_attr.tnr_strength = 128;
      hbn_isp_set_3dnr_attr(pipeline->vio.isp_handle, &tnr_attr);
    }

    // write_active already checked at loop top

    // Get ISP brightness statistics with throttling (using power-of-2 masks for fast bitwise AND)
    // - DAY camera active: every 8 frames (~3.75Hz) for fast DAY→NIGHT detection
    // - DAY camera inactive: every 64 frames (~2.1 sec) for NIGHT→DAY detection
    // - NIGHT camera: every 128 frames (~4.3 sec) for CLAHE decision in YOLO
    // NOTE: ISP lowlight correction is DISABLED - using CLAHE on YOLO side instead
    #define ISP_BRIGHTNESS_MASK_DAY_ACTIVE 7      // 8 frames when active (2^3 - 1)
    #define ISP_BRIGHTNESS_MASK_DAY_INACTIVE 63   // 64 frames when inactive (2^6 - 1)
    #define ISP_BRIGHTNESS_MASK_NIGHT 127         // 128 frames (~4.3 sec, 2^7 - 1)

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
    bool is_brightness_frame = (frame_number & brightness_mask) == 0;

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
    if (frame_number % 30 == 0) {
      LOG_DEBUG(
          Pipeline_log_header,
          "Flags: is_active=%d, brightness=%.1f lux=%u zone=%d",
          write_active,
          brightness_result.brightness_avg, brightness_result.brightness_lux,
          brightness_result.zone);
    }

    if (write_active) {
      clock_gettime(CLOCK_REALTIME, &frame_timestamp);
    }

    // Brightness: switcher thread reads ISP directly (no SHM write needed)

    // Push VSE Ch0 frame to encoder thread (zero-copy via phys_addr)
    // On success, encoder thread owns the VSE buffer and will release it.
    // On failure (queue full) or inactive camera, we must release it here.
    bool frame_owned_by_encoder = false;
    if (write_active) {
      ret = encoder_thread_push_frame(
          &pipeline->encoder_thread, &vio_frame,
          frame_number, pipeline->camera_index, frame_timestamp);

      if (ret == 0) {
        frame_owned_by_encoder = true;
      } else {
        LOG_WARN(Pipeline_log_header, "Encoder queue full, frame %d dropped",
                 frame_number);
      }
    }

    // Release main VIO frame only if encoder thread did not take ownership
    if (!frame_owned_by_encoder) {
      vio_release_frame(&pipeline->vio, &vio_frame);
    }

    // Get YOLO input frame from VSE Channel 1 (1280x720 for ROI detection)
    // Zero-copy: share VIO buffer via share_id, consumer imports via hb_mem
    if (write_active) {
      hbn_vnode_image_t yolo_frame = {0};
      ret = vio_get_frame_ch1(&pipeline->vio, &yolo_frame, 10);
      if (ret == 0) {
        // Build zero-copy frame metadata
        // VSE Ch1 resolution depends on camera:
        // - Day camera (index 0): 640x360
        // - Night camera (index 1): 1280x720 (for ROI-based detection)
        int yolo_width = (pipeline->camera_index == 1) ? 1280 : 640;
        int yolo_height = (pipeline->camera_index == 1) ? 720 : 360;
        ZeroCopyFrame zc_frame = {0};
        zc_frame.frame_number = frame_number;
        zc_frame.timestamp = frame_timestamp;
        zc_frame.camera_id = pipeline->camera_index;
        zc_frame.width = yolo_width;
        zc_frame.height = yolo_height;
        zc_frame.brightness_avg = brightness_result.brightness_avg;

        // Copy share_id and plane info from VIO buffer
        zc_frame.plane_cnt = yolo_frame.buffer.plane_cnt;
        for (int i = 0; i < yolo_frame.buffer.plane_cnt && i < ZEROCOPY_MAX_PLANES; i++) {
          zc_frame.share_id[i] = yolo_frame.buffer.share_id[i];
          zc_frame.plane_size[i] = yolo_frame.buffer.size[i];
        }

        // Copy full hb_mem_graphic_buf_t as raw bytes for import API
        memcpy(zc_frame.hb_mem_buf_data, &yolo_frame.buffer, sizeof(yolo_frame.buffer));

        // shm_zerocopy_write overwrites unconditionally (H.265 pattern)
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

          if (frame_number == 0) {
            // === DIAGNOSTIC: Dump ALL fields of hb_mem_graphic_buf_t ===
            // This is critical for diagnosing hb_mem_import failures on the consumer side.
            const hb_mem_graphic_buf_t *gb = &yolo_frame.buffer;

            LOG_DEBUG(Pipeline_log_header,
                     "=== hb_mem_graphic_buf_t DUMP (sizeof=%zu) ===",
                     sizeof(hb_mem_graphic_buf_t));
            LOG_DEBUG(Pipeline_log_header,
                     "  fd[3]          = {%d, %d, %d}",
                     gb->fd[0], gb->fd[1], gb->fd[2]);
            LOG_DEBUG(Pipeline_log_header,
                     "  plane_cnt      = %d", gb->plane_cnt);
            LOG_DEBUG(Pipeline_log_header,
                     "  format         = %d", gb->format);
            LOG_DEBUG(Pipeline_log_header,
                     "  width          = %d", gb->width);
            LOG_DEBUG(Pipeline_log_header,
                     "  height         = %d", gb->height);
            LOG_DEBUG(Pipeline_log_header,
                     "  stride         = %d", gb->stride);
            LOG_DEBUG(Pipeline_log_header,
                     "  vstride        = %d", gb->vstride);
            LOG_DEBUG(Pipeline_log_header,
                     "  is_contig      = %d", gb->is_contig);
            LOG_DEBUG(Pipeline_log_header,
                     "  share_id[3]    = {%d, %d, %d}",
                     gb->share_id[0], gb->share_id[1], gb->share_id[2]);
            LOG_DEBUG(Pipeline_log_header,
                     "  flags          = %ld", (long)gb->flags);
            LOG_DEBUG(Pipeline_log_header,
                     "  size[3]        = {%lu, %lu, %lu}",
                     (unsigned long)gb->size[0],
                     (unsigned long)gb->size[1],
                     (unsigned long)gb->size[2]);
            LOG_DEBUG(Pipeline_log_header,
                     "  virt_addr[3]   = {0x%lx, 0x%lx, 0x%lx}",
                     (unsigned long)gb->virt_addr[0],
                     (unsigned long)gb->virt_addr[1],
                     (unsigned long)gb->virt_addr[2]);
            LOG_DEBUG(Pipeline_log_header,
                     "  phys_addr[3]   = {0x%lx, 0x%lx, 0x%lx}",
                     (unsigned long)gb->phys_addr[0],
                     (unsigned long)gb->phys_addr[1],
                     (unsigned long)gb->phys_addr[2]);
            LOG_DEBUG(Pipeline_log_header,
                     "  offset[3]      = {%lu, %lu, %lu}",
                     (unsigned long)gb->offset[0],
                     (unsigned long)gb->offset[1],
                     (unsigned long)gb->offset[2]);

            // Also dump raw hex of first 64 bytes for cross-checking with Python side
            const uint8_t *raw = (const uint8_t *)gb;
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[0..15]     = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
                     raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[16..31]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[16], raw[17], raw[18], raw[19], raw[20], raw[21], raw[22], raw[23],
                     raw[24], raw[25], raw[26], raw[27], raw[28], raw[29], raw[30], raw[31]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[32..47]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[32], raw[33], raw[34], raw[35], raw[36], raw[37], raw[38], raw[39],
                     raw[40], raw[41], raw[42], raw[43], raw[44], raw[45], raw[46], raw[47]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[48..63]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[48], raw[49], raw[50], raw[51], raw[52], raw[53], raw[54], raw[55],
                     raw[56], raw[57], raw[58], raw[59], raw[60], raw[61], raw[62], raw[63]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[64..79]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[64], raw[65], raw[66], raw[67], raw[68], raw[69], raw[70], raw[71],
                     raw[72], raw[73], raw[74], raw[75], raw[76], raw[77], raw[78], raw[79]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[80..95]    = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[80], raw[81], raw[82], raw[83], raw[84], raw[85], raw[86], raw[87],
                     raw[88], raw[89], raw[90], raw[91], raw[92], raw[93], raw[94], raw[95]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[96..111]   = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[96], raw[97], raw[98], raw[99], raw[100], raw[101], raw[102], raw[103],
                     raw[104], raw[105], raw[106], raw[107], raw[108], raw[109], raw[110], raw[111]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[112..127]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[112], raw[113], raw[114], raw[115], raw[116], raw[117], raw[118], raw[119],
                     raw[120], raw[121], raw[122], raw[123], raw[124], raw[125], raw[126], raw[127]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[128..143]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[128], raw[129], raw[130], raw[131], raw[132], raw[133], raw[134], raw[135],
                     raw[136], raw[137], raw[138], raw[139], raw[140], raw[141], raw[142], raw[143]);
            LOG_DEBUG(Pipeline_log_header,
                     "  raw[144..159]  = %02x %02x %02x %02x %02x %02x %02x %02x "
                     "%02x %02x %02x %02x %02x %02x %02x %02x",
                     raw[144], raw[145], raw[146], raw[147], raw[148], raw[149], raw[150], raw[151],
                     raw[152], raw[153], raw[154], raw[155], raw[156], raw[157], raw[158], raw[159]);
            LOG_DEBUG(Pipeline_log_header, "=== END hb_mem_graphic_buf_t DUMP ===");
          }
        } else {
          // Consumer busy (timeout) - release current frame, keep pending as-is
          vio_release_frame_ch1(&pipeline->vio, &yolo_frame);
        }
      } else if (frame_number % 30 == 0) {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame_ch1 failed: %d", ret);
      }
    }

    // Get MJPEG frame from VSE Channel 2 (768x432, 16:9)
    // This frame is writable by web_monitor for overlay drawing (zero-copy)
    if (write_active) {
      hbn_vnode_image_t mjpeg_frame = {0};
      ret = vio_get_frame_ch2(&pipeline->vio, &mjpeg_frame, 10);
      if (ret == 0) {
        // Write MJPEG frame to shared memory
        // Zero-copy: share VSE Ch2 buffer via share_id
        ZeroCopyFrame mjpeg_zc = {0};
        mjpeg_zc.frame_number = frame_number;
        mjpeg_zc.timestamp = frame_timestamp;
        mjpeg_zc.camera_id = pipeline->camera_index;
        mjpeg_zc.width = mjpeg_frame.buffer.width;
        mjpeg_zc.height = mjpeg_frame.buffer.height;
        mjpeg_zc.brightness_avg = brightness_result.brightness_avg;
        mjpeg_zc.plane_cnt = mjpeg_frame.buffer.plane_cnt;
        for (int i = 0; i < mjpeg_frame.buffer.plane_cnt; i++) {
          mjpeg_zc.share_id[i] = mjpeg_frame.buffer.share_id[i];
          mjpeg_zc.plane_size[i] = mjpeg_frame.buffer.size[i];
        }
        memcpy(mjpeg_zc.hb_mem_buf_data, &mjpeg_frame.buffer,
               sizeof(mjpeg_frame.buffer));

        int write_ret = shm_zerocopy_write(pipeline->shm_mjpeg_zc, &mjpeg_zc);
        if (write_ret == 0) {
          if (frame_number == 0) {
            LOG_INFO(Pipeline_log_header,
                     "VSE Ch2 output: %dx%d (zero-copy, share_id=%d)",
                     mjpeg_zc.width, mjpeg_zc.height, mjpeg_zc.share_id[0]);
          }
          // Consumer finished with previous frame - safe to release it now
          if (has_pending_mjpeg_frame) {
            vio_release_frame_ch2(&pipeline->vio, &pending_mjpeg_frame);
          }
          pending_mjpeg_frame = mjpeg_frame;
          has_pending_mjpeg_frame = true;
        } else {
          // Consumer busy (timeout) - release current frame, keep pending as-is
          vio_release_frame_ch2(&pipeline->vio, &mjpeg_frame);
        }
      } else if (frame_number % 30 == 0) {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame_ch2 failed: %d", ret);
      }
    }

    if (write_active) {
      frame_number++;
    }

    // Night camera: fix AWB to Manual after ISP has stabilized (~1 sec).
    // Auto AWB cannot converge on IR scenes and causes purple/blue drift.
    // See docs/awb_tuning_report.md for test results and tuning tool usage.
    if (!night_awb_applied && frame_number == 30) {
      hbn_isp_awb_attr_t awb_attr = {0};
      int awb_ret = hbn_isp_get_awb_attr(pipeline->vio.isp_handle, &awb_attr);
      if (awb_ret == 0) {
        awb_attr.mode = HBN_ISP_MODE_MANUAL;
        awb_attr.manual_attr.gain.rgain  = 1.8f;
        awb_attr.manual_attr.gain.grgain = 1.8f;
        awb_attr.manual_attr.gain.gbgain = 1.8f;
        awb_attr.manual_attr.gain.bgain  = 2.34f;
        awb_ret = hbn_isp_set_awb_attr(pipeline->vio.isp_handle, &awb_attr);
      }
      if (awb_ret != 0) {
        LOG_WARN(Pipeline_log_header, "Failed to set night AWB: %d", awb_ret);
      } else {
        LOG_INFO(Pipeline_log_header, "Night camera AWB fixed: R=1.8 G=1.8 B=2.34 (frame %d)", frame_number);
      }
      night_awb_applied = true;
    }

    // Print FPS every 30 frames
    if (frame_number % 30 == 0) {
      clock_gettime(CLOCK_MONOTONIC, &current_time);
      double elapsed = (current_time.tv_sec - start_time.tv_sec) +
                       (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
      double fps = frame_number / elapsed;
      LOG_DEBUG(Pipeline_log_header,
                "Frame %d, FPS: %.2f, H.264 encoded: %lu, dropped: %lu",
                frame_number, fps, pipeline->encoder_thread.frames_encoded,
                pipeline->encoder_thread.frames_dropped);
    }
  }

  // Release any pending zero-copy frames on exit
  if (has_pending_yolo_frame) {
    vio_release_frame_ch1(&pipeline->vio, &pending_yolo_frame);
    has_pending_yolo_frame = false;
  }
  if (has_pending_mjpeg_frame) {
    vio_release_frame_ch2(&pipeline->vio, &pending_mjpeg_frame);
    has_pending_mjpeg_frame = false;
  }

  // Final statistics
  clock_gettime(CLOCK_MONOTONIC, &current_time);
  double total_elapsed = (current_time.tv_sec - start_time.tv_sec) +
                         (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
  double avg_fps = frame_number / total_elapsed;
  LOG_INFO(Pipeline_log_header,
           "Completed: %d frames in %.2f seconds (avg FPS: %.2f)", frame_number,
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

  if (pipeline->shm_h265_zc) {
    shm_h265_zc_close(pipeline->shm_h265_zc);
    pipeline->shm_h265_zc = NULL;
  }

  if (pipeline->shm_yolo_zerocopy) {
    shm_zerocopy_close(pipeline->shm_yolo_zerocopy);
    pipeline->shm_yolo_zerocopy = NULL;
  }

  if (pipeline->shm_mjpeg_zc) {
    shm_zerocopy_close(pipeline->shm_mjpeg_zc);
    pipeline->shm_mjpeg_zc = NULL;
  }

  // Close memory manager
  hb_mem_module_close();

  memset(pipeline, 0, sizeof(camera_pipeline_t));
  LOG_INFO(Pipeline_log_header, "Pipeline destroyed");
}
