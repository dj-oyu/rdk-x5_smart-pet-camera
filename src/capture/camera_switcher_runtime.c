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
  int frames_until_check = 0; // Start at 0 to check immediately on first frame
  uint64_t total_frames = 0;
  uint64_t checked_frames = 0;
  int check_interval = rt->cfg.brightness_check_interval_frames_day > 0
                           ? rt->cfg.brightness_check_interval_frames_day
                           : 3;

  LOG_INFO("ActiveThread", "Started with countdown-based brightness checking");

  while (!rt->stop_flag) {
    // Wait for new frame notification (blocks until camera_daemon writes new
    // frame) This is called every frame to consume semaphore and prevent
    // buildup
    if (rt->ops.wait_for_new_frame &&
        rt->ops.wait_for_new_frame(rt->ops.user_data) != 0) {
      if (!rt->stop_flag) {
        usleep(1000); // 1ms sleep on error
      }
      continue;
    }

    total_frames++;

    // Countdown until next brightness check
    frames_until_check--;
    if (frames_until_check < 0) {
      frames_until_check =
          0; // Keep at 0 minimum to prevent NIGHT camera checks
    }

    // Only capture and check brightness when countdown reaches zero
    // NIGHT camera (camera_index=1) is never checked as frames_until_check
    // stays at 0 DAY: frames_until_check + 0 <= 0 → true when
    // frames_until_check == 0 NIGHT: frames_until_check + 1 <= 0 → false (0 + 1
    // = 1 > 0, never true)
    if (frames_until_check + rt->active_camera <= 0) {
      // This block only executes for DAY camera
      // Day camera: check every 3 frames (10fps) for quick dark detection

      // Capture frame
      Frame frame = {0};
      frame.camera_id = rt->active_camera;

      if (!rt->ops.capture_active_frame ||
          rt->ops.capture_active_frame(rt->active_camera, &frame,
                                       rt->ops.user_data) != 0) {
        // Reset countdown on error to retry on next frame
        frames_until_check = 1;
        continue;
      }

      checked_frames++;

      if (checked_frames % 100 == 0) {
        LOG_INFO("ActiveThread", "Checked %lu/%lu frames (skip ratio: %.1f%%)",
                 checked_frames, total_frames,
                 100.0 * (total_frames - checked_frames) / total_frames);
      }

      // Check brightness and make switch decision
      CameraSwitchDecision decision = camera_switcher_handle_frame(
          &rt->controller, &frame, rt->active_camera, true,
          rt->ops.publish_frame, rt->ops.user_data);

      if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
        do_switch(rt, CAMERA_MODE_DAY, "auto-day");
      } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
        do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
      }

      // Refill countdown for next check
      frames_until_check = check_interval;
    }
  }

  LOG_INFO("ActiveThread",
           "Stopped. Total frames: %lu, Checked: %lu (%.1f%% skip rate)",
           total_frames, checked_frames,
           100.0 * (total_frames - checked_frames) / total_frames);

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
        LOG_ERROR("ProbeThread", "capture_frame failed with result=%d",
                  capture_result);
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
