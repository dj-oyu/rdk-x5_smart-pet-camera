/**
 * camera_switcher_daemon.c
 *
 * Single-threaded polling daemon for brightness-based day/night camera switching.
 *
 * Architecture (Phase 3):
 * - Spawns both DAY and NIGHT camera daemons (constant 30fps each)
 * - Reads DAY camera brightness from ZeroCopy SHM (/pet_camera_zc_0)
 * - Writes active camera index to CameraControl SHM (/pet_camera_control)
 * - camera_daemons poll CameraControl to decide H.264 encoding
 * - No threads, no callbacks, no signals to child daemons
 */

#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "camera_switcher.h"
#include "logger.h"
#include "shared_memory.h"

// CAPTURE_BIN_PATH is defined at compile time via -DCAPTURE_BIN_PATH="..."
// Fallback to relative path if not defined (for backward compatibility)
#ifndef CAPTURE_BIN_PATH
#define CAPTURE_BIN_PATH "../../build/camera_daemon_drobotics"
#endif

#define CAPTURE_BIN CAPTURE_BIN_PATH

// Polling intervals (milliseconds)
#define POLL_INTERVAL_DAY_MS 250   // 4Hz when DAY active (fast dark detection)
#define POLL_INTERVAL_NIGHT_MS 5000 // 0.2Hz when NIGHT active (slow bright detection)

typedef struct {
  pid_t day_pid;
  pid_t night_pid;
  CameraMode active_camera;
  CameraControl *control_shm;
  ZeroCopyFrameBuffer *shm_day;
  CameraSwitchController switcher;
} SwitcherContext;

static volatile sig_atomic_t g_stop = 0;
static volatile sig_atomic_t g_force_day = 0;
static volatile sig_atomic_t g_force_night = 0;

static void handle_signal(int sig) {
  if (sig == SIGUSR1) {
    g_force_day = 1;
  } else if (sig == SIGUSR2) {
    g_force_night = 1;
  } else {
    g_stop = 1;
  }
}

static int spawn_daemon(CameraMode camera) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return -1;
  }
  if (pid == 0) {
    char camera_arg[16];
    snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);

    execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-W", "640", "-H", "480",
          NULL);
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

static ZeroCopyFrameBuffer *wait_for_zerocopy_shm(const char *name,
                                                   int max_retries) {
  ZeroCopyFrameBuffer *shm = NULL;
  int retries = 0;

  while (retries < max_retries && !shm) {
    shm = shm_zerocopy_open(name);
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

static void do_switch(SwitcherContext *ctx, CameraMode target,
                      const char *reason) {
  if (ctx->active_camera == target) {
    return;
  }

  shm_control_set_active(ctx->control_shm, (int)target);
  camera_switcher_notify_active_camera(&ctx->switcher, target, reason);
  ctx->active_camera = target;

  LOG_INFO("SwitcherDaemon", "Switched to %s camera (%s)",
           target == CAMERA_MODE_DAY ? "DAY" : "NIGHT", reason);
}

static int switcher_loop(SwitcherContext *ctx) {
  LOG_INFO("SwitcherDaemon",
           "Switcher loop started (poll: %dms DAY / %dms NIGHT)",
           POLL_INTERVAL_DAY_MS, POLL_INTERVAL_NIGHT_MS);

  while (!g_stop) {
    // Handle force-switch signals (SIGUSR1=DAY, SIGUSR2=NIGHT)
    if (g_force_day) {
      g_force_day = 0;
      do_switch(ctx, CAMERA_MODE_DAY, "forced");
    }
    if (g_force_night) {
      g_force_night = 0;
      do_switch(ctx, CAMERA_MODE_NIGHT, "forced");
    }

    // Read DAY camera brightness directly from ZeroCopy SHM
    float brightness = ctx->shm_day->frame.brightness_avg;

    // Make switch decision using existing hysteresis logic
    CameraSwitchDecision decision = camera_switcher_record_brightness(
        &ctx->switcher, CAMERA_MODE_DAY, (double)brightness);

    if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
      do_switch(ctx, CAMERA_MODE_NIGHT, "auto-night");
    } else if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
      do_switch(ctx, CAMERA_MODE_DAY, "auto-day");
    }

    // Adaptive sleep: fast polling when DAY (quick dark detection),
    // slow polling when NIGHT (brightness recovery is gradual)
    int interval_ms = (ctx->active_camera == CAMERA_MODE_DAY)
                          ? POLL_INTERVAL_DAY_MS
                          : POLL_INTERVAL_NIGHT_MS;
    usleep(interval_ms * 1000);
  }

  LOG_INFO("SwitcherDaemon", "Switcher loop stopped");
  return 0;
}

int main(void) {
  log_init(LOG_LEVEL_INFO, stdout, 0);

  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);
  signal(SIGUSR1, handle_signal);
  signal(SIGUSR2, handle_signal);

  // Initialize detection shared memory
  // Cleanup stale shared memory from previous runs first
  shm_unlink(SHM_NAME_DETECTIONS);

  LatestDetectionResult *detection_shm = shm_detection_create();
  if (detection_shm == NULL) {
    LOG_ERROR("SwitcherDaemon", "Failed to create detection shared memory");
    return 1;
  }
  LOG_INFO("SwitcherDaemon",
           "Detection shared memory initialized with semaphore");

  // Create CameraControl SHM (before spawning daemons so they can open it)
  CameraControl *control_shm = shm_control_create();
  if (!control_shm) {
    LOG_ERROR("SwitcherDaemon", "Failed to create CameraControl shared memory");
    shm_detection_destroy(detection_shm);
    return 1;
  }
  LOG_INFO("SwitcherDaemon", "CameraControl shared memory created: %s",
           SHM_NAME_CONTROL);

  // Initialize switcher config
  CameraSwitchConfig cfg = {
      .day_to_night_threshold = 50.0,
      .night_to_day_threshold = 60.0,
      .day_to_night_hold_seconds = 0.5,
      .night_to_day_hold_seconds = 3.0,
      .warmup_frames = 15,
  };

  SwitcherContext ctx = {
      .day_pid = -1,
      .night_pid = -1,
      .active_camera = CAMERA_MODE_DAY,
      .control_shm = control_shm,
      .shm_day = NULL,
  };
  camera_switcher_init(&ctx.switcher, &cfg);

  // Spawn camera daemons
  const char *single_camera_mode = getenv("SINGLE_CAMERA_MODE");
  int use_single_camera = (single_camera_mode && atoi(single_camera_mode) == 1);

  if (use_single_camera) {
    LOG_INFO("SwitcherDaemon",
             "SINGLE_CAMERA_MODE: using camera 0 for both DAY/NIGHT");
    ctx.day_pid = spawn_daemon(0);
    if (ctx.day_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start day camera daemon");
      shm_control_destroy(control_shm);
      shm_detection_destroy(detection_shm);
      return 1;
    }
    ctx.night_pid = -1;
    LOG_INFO("SwitcherDaemon", "Single camera started (DAY mode only)");
  } else {
    LOG_INFO("SwitcherDaemon",
             "DUAL_CAMERA_MODE: starting both cameras at 30fps");

    ctx.day_pid = spawn_daemon(CAMERA_MODE_DAY);
    if (ctx.day_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start day camera daemon");
      shm_control_destroy(control_shm);
      shm_detection_destroy(detection_shm);
      return 1;
    }

    ctx.night_pid = spawn_daemon(CAMERA_MODE_NIGHT);
    if (ctx.night_pid <= 0) {
      LOG_ERROR("SwitcherDaemon", "Failed to start night camera daemon");
      kill_daemon(ctx.day_pid);
      shm_control_destroy(control_shm);
      shm_detection_destroy(detection_shm);
      return 1;
    }

    LOG_INFO("SwitcherDaemon", "Both cameras started at 30fps");
  }

  // Wait for camera daemons to initialize
  LOG_INFO("SwitcherDaemon", "Waiting for camera daemons to initialize...");
  sleep(2);

  // Open DAY camera ZeroCopy SHM for brightness reading
  ctx.shm_day = wait_for_zerocopy_shm(SHM_NAME_ZEROCOPY_DAY, 50); // 5s timeout
  if (!ctx.shm_day) {
    LOG_ERROR("SwitcherDaemon", "Failed to open DAY ZeroCopy SHM");
    kill_daemon(ctx.day_pid);
    kill_daemon(ctx.night_pid);
    camera_switcher_destroy(&ctx.switcher);
    shm_control_destroy(control_shm);
    shm_detection_destroy(detection_shm);
    return 1;
  }

  // Set initial active camera
  shm_control_set_active(control_shm, (int)CAMERA_MODE_DAY);
  camera_switcher_notify_active_camera(&ctx.switcher, CAMERA_MODE_DAY, "init");
  LOG_INFO("SwitcherDaemon", "Initial camera: DAY");

  // Run main polling loop
  LOG_INFO("SwitcherDaemon",
           "Running. Press Ctrl+C to stop. SIGUSR1=DAY, SIGUSR2=NIGHT");
  switcher_loop(&ctx);

  // Shutdown
  LOG_INFO("SwitcherDaemon", "Stopping...");
  kill_daemon(ctx.day_pid);
  kill_daemon(ctx.night_pid);

  if (ctx.shm_day) {
    shm_zerocopy_close(ctx.shm_day);
  }
  camera_switcher_destroy(&ctx.switcher);

  if (control_shm) {
    shm_control_destroy(control_shm);
    LOG_INFO("SwitcherDaemon", "CameraControl shared memory destroyed");
  }

  if (detection_shm) {
    shm_detection_destroy(detection_shm);
    LOG_INFO("SwitcherDaemon", "Detection shared memory destroyed");
  }

  return 0;
}
