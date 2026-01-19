/*
 * camera_pipeline.c - Camera Pipeline Implementation
 */

#define _POSIX_C_SOURCE 200809L

#include "camera_pipeline.h"
#include "hb_mem_mgr.h"
#include "isp_brightness.h"
#include "logger.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

char Pipeline_log_header[16];

int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height, int output_width,
                    int output_height, int fps, int bitrate,
                    volatile sig_atomic_t *is_active_flag,
                    volatile sig_atomic_t *probe_requested_flag) {
  int ret = 0;

  snprintf(Pipeline_log_header, sizeof(Pipeline_log_header), "Pipeline %d",
           camera_index);

  if (!pipeline || !is_active_flag || !probe_requested_flag)
    return -1;

  memset(pipeline, 0, sizeof(camera_pipeline_t));

  pipeline->camera_index = camera_index;
  pipeline->sensor_width = sensor_width;
  pipeline->sensor_height = sensor_height;
  pipeline->output_width = output_width;
  pipeline->output_height = output_height;
  pipeline->fps = fps;
  pipeline->bitrate = bitrate;
  pipeline->is_active_flag = is_active_flag;
  pipeline->probe_requested_flag = probe_requested_flag;

  LOG_INFO(Pipeline_log_header,
           "Creating pipeline for Camera %d (%dx%d@%dfps, %dkbps)",
           camera_index, output_width, output_height, fps, bitrate / 1000);

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

  // Probe NV12 (written only on probe request)
  pipeline->shm_probe_nv12 =
      shm_frame_buffer_create_named(SHM_NAME_PROBE_FRAME);
  if (!pipeline->shm_probe_nv12) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create probe NV12 shared memory: %s",
              SHM_NAME_PROBE_FRAME);
    ret = -1;
    goto error_cleanup;
  }

  // YOLO input NV12 (640x640 from VSE Channel 1, always written when active)
  pipeline->shm_yolo_input =
      shm_frame_buffer_create_named(SHM_NAME_YOLO_INPUT);
  if (!pipeline->shm_yolo_input) {
    LOG_ERROR(Pipeline_log_header,
              "Failed to open/create YOLO input shared memory: %s",
              SHM_NAME_YOLO_INPUT);
    ret = -1;
    goto error_cleanup;
  }

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

  LOG_INFO(Pipeline_log_header,
           "Starting capture loop (threaded encoder, 30fps NV12+H.264)...");

  while (*running_flag) {
    int ret;

    // Get NV12 frame from VIO
    ret = vio_get_frame(&pipeline->vio, &vio_frame, 2000);
    if (ret != 0) {
      // Error -43 (HBN_STATUS_NODE_DEQUE_ERROR) is transient during camera
      // switches - the VIO buffer isn't ready yet. Use DEBUG level to avoid log
      // spam. Non-active cameras may also fail to get frames during probe
      // (expected).
      if (*pipeline->is_active_flag == 1 && ret != -43) {
        LOG_WARN(Pipeline_log_header, "vio_get_frame failed: %d", ret);
      } else {
        LOG_DEBUG(Pipeline_log_header, "vio_get_frame failed: %d (active=%d)",
                  ret, *pipeline->is_active_flag);
      }
      continue;
    }

    // Conditional NV12 write based on active/probe flags
    bool write_active = *pipeline->is_active_flag == 1;
    bool write_probe = *pipeline->probe_requested_flag == 1;

    // Get ISP brightness statistics with throttling (every 8 frames = ~3.75Hz)
    // This reduces ISP API overhead and prevents video stuttering
    // Use bitmask for efficient modulo: (frame_count & 7) == 0
    #define ISP_BRIGHTNESS_MASK 7  // 8 frames interval (2^3 - 1)
    static isp_brightness_result_t cached_brightness = {0};
    bool is_brightness_frame = (frame_count & ISP_BRIGHTNESS_MASK) == 0;
    if (is_brightness_frame) {
      isp_get_brightness(pipeline->vio.isp_handle, &cached_brightness);
    }
    isp_brightness_result_t brightness_result = cached_brightness;

    // Update low-light correction based on brightness (Phase 2)
    // Only active camera should control ISP parameters to avoid conflicts
    // Also throttled to match brightness measurement interval
    // NOTE: Temporarily disabled - ISP parameter changes may cause H.264 stutter
    bool correction_active = pipeline->lowlight_state.correction_active;
#if 0  // Disabled for debugging H.264 stutter
    if (write_active && is_brightness_frame) {
      correction_active = isp_update_lowlight_correction(
          pipeline->vio.isp_handle, &pipeline->lowlight_state, &brightness_result);
    }
#endif

    // Debug: log flags every 30 frames
    if (frame_count % 30 == 0) {
      LOG_DEBUG(
          Pipeline_log_header,
          "Flags: is_active=%d, probe=%d, brightness=%.1f lux=%u zone=%d correction=%d",
          *pipeline->is_active_flag, *pipeline->probe_requested_flag,
          brightness_result.brightness_avg, brightness_result.brightness_lux,
          brightness_result.zone, correction_active);
    }

    if (write_active || write_probe) {
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
      nv12_frame.correction_applied = correction_active ? 1 : 0;

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

        // Write to probe shared memory if probe requested
        if (write_probe) {
          if (shm_frame_buffer_write(pipeline->shm_probe_nv12, &nv12_frame) <
              0) {
            LOG_WARN(Pipeline_log_header, "Failed to write NV12 to probe shm");
          }
          // Clear probe request flag after writing one frame
          *pipeline->probe_requested_flag = 0;
        }
      } else {
        LOG_WARN(Pipeline_log_header, "NV12 frame too large (%zu bytes)",
                 nv12_size);
      }
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
    } else {
      // Release VIO frame immediately
      vio_release_frame(&pipeline->vio, &vio_frame);
    }

    // Release VIO frame immediately
    vio_release_frame(&pipeline->vio, &vio_frame);

    // Get YOLO input frame from VSE Channel 1 (640x640)
    if (write_active) {
      hbn_vnode_image_t yolo_frame = {0};
      ret = vio_get_frame_ch1(&pipeline->vio, &yolo_frame, 10);
      if (ret == 0) {
        // Write YOLO frame to shared memory
        Frame yolo_nv12_frame = {0};
        // VSE Ch1 is configured for 640x640 (see vio_lowlevel.c:233-236)
        yolo_nv12_frame.width = 640;
        yolo_nv12_frame.height = 640;
        yolo_nv12_frame.format = 1; // NV12
        yolo_nv12_frame.frame_number = frame_count;
        yolo_nv12_frame.camera_id = pipeline->camera_index;
        yolo_nv12_frame.timestamp = frame_timestamp;

        // Apply brightness data from ISP (same for all channels)
        isp_fill_frame_brightness(&yolo_nv12_frame, &brightness_result);
        yolo_nv12_frame.correction_applied = correction_active ? 1 : 0;

        // Calculate NV12 size for 640x640
        size_t yolo_size = 0;
        for (int i = 0; i < yolo_frame.buffer.plane_cnt; i++) {
          yolo_size += yolo_frame.buffer.size[i];
        }
        yolo_nv12_frame.data_size = yolo_size;

        // Copy YOLO NV12 data
        if (yolo_size <= sizeof(yolo_nv12_frame.data)) {
          size_t offset = 0;
          for (int i = 0; i < yolo_frame.buffer.plane_cnt; i++) {
            memcpy(yolo_nv12_frame.data + offset, yolo_frame.buffer.virt_addr[i],
                   yolo_frame.buffer.size[i]);
            offset += yolo_frame.buffer.size[i];
          }

          int write_ret = shm_frame_buffer_write(pipeline->shm_yolo_input, &yolo_nv12_frame);
          if (write_ret < 0) {
            LOG_WARN(Pipeline_log_header, "Failed to write YOLO input to shm");
          } else if (frame_count == 0 || frame_count % 30 == 0) {
            // Log first frame and every 30 frames to verify VSE Ch1 size
            if (frame_count == 0) {
              LOG_INFO(Pipeline_log_header,
                       "VSE Ch1 output: %dx%d, %zu bytes (expected 640x640, ~614KB)",
                       yolo_nv12_frame.width, yolo_nv12_frame.height, yolo_size);
            } else {
              LOG_DEBUG(Pipeline_log_header,
                        "Wrote YOLO %dx%d frame#%d to shm (idx=%d)",
                        yolo_nv12_frame.width, yolo_nv12_frame.height, frame_count, write_ret);
            }
          }
        }

        vio_release_frame_ch1(&pipeline->vio, &yolo_frame);
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
        mjpeg_nv12_frame.correction_applied = correction_active ? 1 : 0;

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

  // Close shared memory (do not destroy - owned by camera_switcher_daemon)
  if (pipeline->shm_active_nv12) {
    shm_frame_buffer_close(pipeline->shm_active_nv12);
    pipeline->shm_active_nv12 = NULL;
  }

  if (pipeline->shm_active_h264) {
    shm_frame_buffer_close(pipeline->shm_active_h264);
    pipeline->shm_active_h264 = NULL;
  }

  if (pipeline->shm_probe_nv12) {
    shm_frame_buffer_close(pipeline->shm_probe_nv12);
    pipeline->shm_probe_nv12 = NULL;
  }

  if (pipeline->shm_yolo_input) {
    shm_frame_buffer_close(pipeline->shm_yolo_input);
    pipeline->shm_yolo_input = NULL;
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
