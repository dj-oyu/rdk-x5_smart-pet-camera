/**
 * camera_switcher_runtime.c
 *
 * Orchestrates brightness-based camera switching with real capture callbacks.
 * - Active thread captures frames from the current camera at target interval
 * - Probe thread periodically samples the inactive camera for brightness
 * - Switch decisions call back into user-provided hardware switch routine
 */

#include "camera_switcher_runtime.h"
#include "logger.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void sleep_seconds(double sec) {
  struct timespec ts;
  ts.tv_sec = (time_t)sec;
  ts.tv_nsec = (long)((sec - ts.tv_sec) * 1e9);
  nanosleep(&ts, NULL);
}

static int do_switch(CameraSwitchRuntime *rt, CameraMode target,
                     const char *reason) {
  if (rt->active_camera == target) {
    return 0;
  }
  if (rt->ops.switch_camera) {
    rt->ops.switch_camera(target, rt->ops.user_data);
  }
  camera_switcher_notify_active_camera(&rt->controller, target, reason);
  rt->active_camera = target;
  return 0;
}

static void *active_thread_main(void *arg) {
  CameraSwitchRuntime *rt = (CameraSwitchRuntime *)arg;
  uint_fast32_t frame_count = 0;
  uint64_t last_frame_number = 0;
  uint64_t processed_count = 0;
  uint64_t skipped_count = 0;

  while (!rt->stop_flag) {
    Frame frame = {0};
    frame.camera_id = rt->active_camera;

    if (!rt->ops.capture_active_frame ||
        rt->ops.capture_active_frame(rt->active_camera, &frame, rt->ops.user_data) !=
            0) {
      usleep(1000); // 1ms sleep on error
      continue;
    }

    // Skip if this is the same frame as last time
    // Sleep briefly to avoid busy loop (active_frame is non-blocking)
    if (frame.frame_number == last_frame_number) {
      skipped_count++;
      usleep(100); // 100us = 0.1ms (allows up to 10000 checks/sec)
      continue;
    }
    last_frame_number = frame.frame_number;
    processed_count++;

    if (processed_count % 100 == 0) {
      LOG_INFO("ActiveThread", "Processed %lu frames, skipped %lu (frame#%lu)",
               processed_count, skipped_count, frame.frame_number);
    }

    // Use different check intervals based on active camera
    // Day camera: faster checks (default 3 frames = 10fps) for quick dark detection
    // Night camera: slower checks (default 30 frames = 1fps) as brightness changes slowly
    int check_interval;
    if (rt->active_camera == CAMERA_MODE_DAY) {
      check_interval = rt->cfg.brightness_check_interval_frames_day > 0
                           ? rt->cfg.brightness_check_interval_frames_day
                           : 3;
    } else {
      check_interval = rt->cfg.brightness_check_interval_frames_night > 0
                           ? rt->cfg.brightness_check_interval_frames_night
                           : 30;
    }

    // Check brightness every N frames
    if (frame_count % check_interval == 0) {
      CameraSwitchDecision decision = camera_switcher_handle_frame(
          &rt->controller, &frame, rt->active_camera, true,
          rt->ops.publish_frame, rt->ops.user_data);

      if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
        do_switch(rt, CAMERA_MODE_DAY, "auto-day");
      } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
        do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
      }
    } else {
      camera_switcher_publish_frame(&rt->controller, &frame,
                                    rt->ops.publish_frame, rt->ops.user_data);
    }

    frame_count++;
  }

  return NULL;
}

static void *probe_thread_main(void *arg) {
  CameraSwitchRuntime *rt = (CameraSwitchRuntime *)arg;

  while (!rt->stop_flag) {
    // Always probe the DAY camera for brightness checking
    // Skip if DAY camera is already active (handled by active_thread)
    if (rt->active_camera != CAMERA_MODE_DAY) {
      Frame probe_frame;
      memset(&probe_frame, 0, sizeof(Frame));
      probe_frame.camera_id = CAMERA_MODE_DAY;

      int capture_result =
          rt->ops.capture_probe_frame
              ? rt->ops.capture_probe_frame(CAMERA_MODE_DAY, &probe_frame,
                                            rt->ops.user_data)
              : -1;

      // printf("[probe] capture_frame result=%d, data_size=%u, format=%d\n",
      //        capture_result, probe_frame.data_size, probe_frame.format);

      if (capture_result == 0) {
        // Copy probe frame to FrameDoubleBuffer inactive slot to avoid
        // shared memory race with active camera writing at 30fps
        if (1) {
          rt->controller.frame_buf = &probe_frame;

          // Calculate brightness from inactive slot (safe from race conditions)
          CameraSwitchDecision decision = camera_switcher_handle_frame(
              &rt->controller, rt->controller.frame_buf, CAMERA_MODE_DAY, false,
              NULL, NULL);

          if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
            do_switch(rt, CAMERA_MODE_DAY, "auto-day");
          } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
            do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
          }
        } else {
          LOG_ERROR("ProbeThread", "Inactive slot buffer is NULL");
        }
      } else {
        LOG_ERROR("ProbeThread", "capture_frame failed with result=%d", capture_result);
      }
    }

    sleep_seconds(rt->cfg.probe_interval_sec);
  }

  return NULL;
}

void camera_switch_runtime_init(CameraSwitchRuntime *rt,
                                const CameraSwitchConfig *ctrl_cfg,
                                const CameraSwitchRuntimeConfig *rt_cfg,
                                const CameraCaptureOps *ops,
                                CameraMode initial_camera) {
  memset(rt, 0, sizeof(*rt));
  CameraSwitchConfig cfg = *ctrl_cfg;
  CameraSwitchRuntimeConfig runtime_cfg = *rt_cfg;

  camera_switcher_init(&rt->controller, &cfg);
  rt->ops = *ops;
  rt->cfg = runtime_cfg;
  rt->active_camera = initial_camera;
  camera_switcher_notify_active_camera(&rt->controller, initial_camera, "init");
}

int camera_switch_runtime_start(CameraSwitchRuntime *rt) {
  rt->stop_flag = false;
  if (pthread_create(&rt->active_thread, NULL, active_thread_main, rt) != 0) {
    return -1;
  }
  if (pthread_create(&rt->probe_thread, NULL, probe_thread_main, rt) != 0) {
    rt->stop_flag = true;
    pthread_join(rt->active_thread, NULL);
    return -1;
  }
  return 0;
}

void camera_switch_runtime_stop(CameraSwitchRuntime *rt) {
  rt->stop_flag = true;
  pthread_join(rt->active_thread, NULL);
  pthread_join(rt->probe_thread, NULL);
  camera_switcher_destroy(&rt->controller);
}
