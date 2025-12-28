/**
 * camera_switcher_daemon.c
 *
 * Reference daemon wiring CameraSwitchRuntime to the existing capture daemon
 * binary.
 * - Starts both cameras (day/night) with dedicated shared memory
 * - Both cameras run at constant 30fps for optimal performance
 * - Reads frames from camera-specific shared memory and feeds brightness to the
 * switcher
 * - Republishes frames back to main shared memory with warmup + double
 * buffering
 */

#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "camera_switcher.h"
#include "camera_switcher_runtime.h"
#include "logger.h"
#include "shared_memory.h"

// CAPTURE_BIN_PATH is defined at compile time via -DCAPTURE_BIN_PATH="..."
// Fallback to relative path if not defined (for backward compatibility)
#ifndef CAPTURE_BIN_PATH
#define CAPTURE_BIN_PATH "../../build/camera_daemon_drobotics"
#endif

#define CAPTURE_BIN CAPTURE_BIN_PATH

typedef struct {
  pid_t day_pid;            // PID of day camera daemon (always running)
  pid_t night_pid;          // PID of night camera daemon (always running)
  CameraMode active_camera; // Currently active camera
  SharedFrameBuffer
      *probe_shm_nv12; // Probe frame shared memory (for brightness reading)
  SharedFrameBuffer *
      active_shm_nv12; // Active frame shared memory (for active thread reading)
} DaemonContext;

static int spawn_daemon(CameraMode camera) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return -1;
  }
  if (pid == 0) {
    char camera_arg[16];
    snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);

    // No environment variables needed - camera_daemon uses fixed shm names
    // Enable verbose logging to see debug messages
    execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-W", "640", "-H", "480",
          "-v", NULL);
    perror("execl");
    _exit(1);
  }
  LOG_INFO("SwitcherDaemon", "Spawned %s (PID=%d) camera=%d (30fps constant)",
           CAPTURE_BIN, pid, (int)camera);
  return pid;
}

static void kill_daemon(pid_t pid) {
  if (pid <= 0) {
    return;
  }
  kill(pid, SIGTERM);
  waitpid(pid, NULL, 0);
}

// Wait for shared memory to be created by camera daemon
static SharedFrameBuffer *wait_for_shm(const char *name, int max_retries) {
  SharedFrameBuffer *shm = NULL;
  int retries = 0;

  while (retries < max_retries && !shm) {
    shm = shm_frame_buffer_open_named(name);
    if (!shm) {
      if (retries == 0) {
        LOG_INFO("SwitcherDaemon", "Waiting for %s to be created...", name);
      }
      usleep(100000); // 100ms
      retries++;
    }
  }

  if (shm) {
    LOG_INFO("SwitcherDaemon", "Opened %s", name);
  } else {
    LOG_ERROR("SwitcherDaemon", "Timeout waiting for %s", name);
  }

  return shm;
}

static int switch_camera_cb(CameraMode camera, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  if (ctx->active_camera == camera) {
    return 0; // Already active
  }

  LOG_INFO("SwitcherDaemon", "Switching to %s camera",
           camera == CAMERA_MODE_DAY ? "DAY" : "NIGHT");

  // Deactivate old camera (SIGUSR2)
  pid_t old_pid =
      (ctx->active_camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  if (old_pid > 0) {
    kill(old_pid, SIGUSR2);
    LOG_DEBUG("SwitcherDaemon", "Sent SIGUSR2 to PID %d (deactivate)", old_pid);
  }

  // Activate new camera (SIGUSR1)
  pid_t new_pid = (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  if (new_pid > 0) {
    kill(new_pid, SIGUSR1);
    LOG_DEBUG("SwitcherDaemon", "Sent SIGUSR1 to PID %d (activate)", new_pid);
  }

  ctx->active_camera = camera;
  return 0;
}

// Capture frame for ActiveThread - reads directly from active shared memory (no
// signal)
static int capture_active_frame_cb(CameraMode camera, Frame *out_frame,
                                   void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;
  (void)camera; // Unused - we always read from active_frame

  // Open active shared memory on first use
  if (!ctx->active_shm_nv12) {
    ctx->active_shm_nv12 = wait_for_shm(SHM_NAME_ACTIVE_FRAME, 10);
    if (!ctx->active_shm_nv12) {
      LOG_ERROR("SwitcherDaemon", "Failed to open active frame shared memory");
      return -1;
    }
  }

  // Read directly from active shared memory (written by active camera daemon)
  int ret = shm_frame_buffer_read_latest(ctx->active_shm_nv12, out_frame);
  return (ret >= 0) ? 0 : -1;
}

// Capture frame for ProbeThread - sends signal and reads from probe shared
// memory
static int capture_probe_frame_cb(CameraMode camera, Frame *out_frame,
                                  void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  // Open probe shared memory on first use
  if (!ctx->probe_shm_nv12) {
    ctx->probe_shm_nv12 = wait_for_shm(SHM_NAME_PROBE_FRAME, 10);
    if (!ctx->probe_shm_nv12) {
      LOG_ERROR("SwitcherDaemon", "Failed to open probe shared memory");
      return -1;
    }
  }

  // Send probe request signal to the target camera (non-active camera)
  pid_t target_pid =
      (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  if (target_pid > 0) {
    kill(target_pid, SIGRTMIN);
    LOG_DEBUG("SwitcherDaemon", "Sent SIGRTMIN to PID %d (probe request)",
              target_pid);
  }

  // Read from probe shared memory
  int ret = shm_frame_buffer_read_latest(ctx->probe_shm_nv12, out_frame);
  return (ret >= 0) ? 0 : -1;
}

// publish_frame_cb removed - camera_daemon writes directly to
// active_frame/stream

static volatile sig_atomic_t g_stop = 0;
static volatile sig_atomic_t g_force_day = 0; // SIGUSR1: Force switch to DAY
static volatile sig_atomic_t g_force_night =
    0; // SIGUSR2: Force switch to NIGHT

static void handle_signal(int sig) {
  if (sig == SIGUSR1) {
    g_force_day = 1;
    LOG_INFO("SwitcherDaemon", "SIGUSR1: Force switch to DAY requested");
  } else if (sig == SIGUSR2) {
    g_force_night = 1;
    LOG_INFO("SwitcherDaemon", "SIGUSR2: Force switch to NIGHT requested");
  } else {
    g_stop = 1;
  }
}

int main(void) {
  // Initialize logger
  log_init(LOG_LEVEL_INFO, stdout, 0);

  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);
  signal(SIGUSR1, handle_signal); // Force switch to DAY
  signal(SIGUSR2, handle_signal); // Force switch to NIGHT

  CameraSwitchConfig cfg = {
      .day_to_night_threshold = 40.0,
      .night_to_day_threshold =
          60.0, // Lowered from 70.0 to match typical indoor brightness
      .day_to_night_hold_seconds = 0.5, // Back to original for testing
      .night_to_day_hold_seconds = 3.0, // Reduced from 10.0 for faster response
      .warmup_frames = 15,
  };

  CameraSwitchRuntimeConfig rt_cfg = {
      .probe_interval_sec = 2.0,
      .active_interval_sec = 0.5, // Unused
      .brightness_check_interval_frames_day =
          3, // Day: every 3 frames = 10fps (fast dark detection)
      .brightness_check_interval_frames_night =
          30, // Night: every 30 frames = 1fps (slow bright detection)
  };

  DaemonContext ctx = {
      .day_pid = -1,
      .night_pid = -1,
      .active_camera =
          -1, // No active camera initially (will be set by first switch)
      .probe_shm_nv12 = NULL,
      .active_shm_nv12 = NULL,
  };

  CameraCaptureOps ops = {
      .switch_camera = switch_camera_cb,
      .capture_active_frame =
          capture_active_frame_cb, // Read from active_frame (no signal)
      .capture_probe_frame =
          capture_probe_frame_cb, // Read from probe_frame (send signal)
      .publish_frame = NULL, // No frame copying - camera_daemon writes directly
      .user_data = &ctx,
  };

  // Start camera daemons
  // Both cameras run at constant 30fps for optimal performance

  // Check if SINGLE_CAMERA_MODE is enabled (for testing with one camera)
  const char *single_camera_mode = getenv("SINGLE_CAMERA_MODE");
  int use_single_camera = (single_camera_mode && atoi(single_camera_mode) == 1);

  if (use_single_camera) {
    LOG_INFO("SwitcherDaemon",
             "SINGLE_CAMERA_MODE: using camera 0 for both DAY/NIGHT");
    ctx.day_pid = spawn_daemon(0);
    if (ctx.day_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start day camera daemon");
      return 1;
    }
    ctx.night_pid = -1; // No night camera daemon in single camera mode
    LOG_INFO("SwitcherDaemon", "Single camera started (DAY mode only)");
  } else {
    // Dual camera mode: both cameras run at 30fps
    LOG_INFO("SwitcherDaemon",
             "DUAL_CAMERA_MODE: starting both cameras at 30fps");

    ctx.day_pid = spawn_daemon(CAMERA_MODE_DAY);
    if (ctx.day_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start day camera daemon");
      return 1;
    }

    ctx.night_pid = spawn_daemon(CAMERA_MODE_NIGHT);
    if (ctx.night_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start night camera daemon");
      kill_daemon(ctx.day_pid);
      return 1;
    }

    LOG_INFO("SwitcherDaemon", "Both cameras started at 30fps");
  }

  // Wait for camera daemons to initialize (simple sleep)
  LOG_INFO("SwitcherDaemon", "Waiting for camera daemons to initialize...");
  sleep(2);

  // Activate initial camera (DAY by default)
  CameraMode initial_camera = CAMERA_MODE_DAY;
  if (switch_camera_cb(initial_camera, &ctx) != 0) {
    LOG_ERROR("SwitcherDaemon", "Failed to activate initial camera");
  }

  CameraSwitchRuntime rt;
  camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, initial_camera);

  if (camera_switch_runtime_start(&rt) != 0) {
    LOG_ERROR("SwitcherDaemon", "Failed to start runtime threads");
    kill_daemon(ctx.day_pid);
    kill_daemon(ctx.night_pid);
    return 1;
  }

  LOG_INFO("SwitcherDaemon", "Running. Press Ctrl+C to stop.");
  LOG_INFO("SwitcherDaemon",
           "Send SIGUSR1 to force DAY, SIGUSR2 to force NIGHT");
  while (!g_stop) {
    // Check for force switch signals
    if (g_force_day) {
      g_force_day = 0;
      LOG_INFO("SwitcherDaemon", "Force switching to DAY camera");
      switch_camera_cb(CAMERA_MODE_DAY, &ctx);
      camera_switcher_notify_active_camera(&rt.controller, CAMERA_MODE_DAY,
                                           "forced");
    }
    if (g_force_night) {
      g_force_night = 0;
      LOG_INFO("SwitcherDaemon", "Force switching to NIGHT camera");
      switch_camera_cb(CAMERA_MODE_NIGHT, &ctx);
      camera_switcher_notify_active_camera(&rt.controller, CAMERA_MODE_NIGHT,
                                           "forced");
    }
    sleep(1);
  }

  LOG_INFO("SwitcherDaemon", "Stopping...");
  camera_switch_runtime_stop(&rt);

  // Stop both daemons (they will destroy their own shared memory)
  kill_daemon(ctx.day_pid);
  kill_daemon(ctx.night_pid);

  // Close shared memory
  if (ctx.probe_shm_nv12) {
    shm_frame_buffer_close(ctx.probe_shm_nv12);
  }
  if (ctx.active_shm_nv12) {
    shm_frame_buffer_close(ctx.active_shm_nv12);
  }

  return 0;
}
