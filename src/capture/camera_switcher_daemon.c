/**
 * camera_switcher_daemon.c
 *
 * Reference daemon wiring CameraSwitchRuntime to the existing capture daemon
 * binary.
 * - Starts both cameras (day/night) with dedicated shared memory
 * - Inactive camera runs at low FPS to minimize resource usage
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

#include "camera_switcher_runtime.h"
#include "shared_memory.h"

#define CAPTURE_BIN "../../build/camera_daemon_drobotics"

typedef struct {
  pid_t day_pid;            // PID of day camera daemon (always running)
  pid_t night_pid;          // PID of night camera daemon (always running)
  CameraMode active_camera; // Currently active camera
  SharedFrameBuffer
      *shm; // Main shared memory (for publishing to web/detection)
  SharedFrameBuffer *day_shm;   // Day camera shared memory
  SharedFrameBuffer *night_shm; // Night camera shared memory
} DaemonContext;

static int spawn_daemon_with_shm(CameraMode camera, const char *shm_name,
                                 int frame_interval_ms, bool use_nv12) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return -1;
  }
  if (pid == 0) {
    // Set custom shared memory name
    setenv("SHM_NAME", shm_name, 1);

    // Set frame interval for low-rate capture (inactive camera)
    if (frame_interval_ms > 0) {
      char interval_str[16];
      snprintf(interval_str, sizeof(interval_str), "%d", frame_interval_ms);
      setenv("FRAME_INTERVAL_MS", interval_str, 1);
    }

    // Use NV12 format for inactive camera (no JPEG encoding overhead)
    if (use_nv12) {
      setenv("USE_NV12", "1", 1);
    }

    char camera_arg[16];
    snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);
    execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-P", "1", "--daemon",
          NULL);
    perror("execl");
    _exit(1);
  }
  printf("[switcher-daemon] spawned %s (PID=%d) camera=%d shm=%s interval=%dms "
         "nv12=%d\n",
         CAPTURE_BIN, pid, (int)camera, shm_name, frame_interval_ms, use_nv12);
  return pid;
}

static void kill_daemon(pid_t pid) {
  if (pid <= 0) {
    return;
  }
  kill(pid, SIGTERM);
  waitpid(pid, NULL, 0);
}

static int switch_camera_cb(CameraMode camera, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  printf("[switcher-daemon] switching to camera=%d\n", (int)camera);

  // Open shared memory segments if not already opened
  if (!ctx->day_shm) {
    ctx->day_shm = shm_frame_buffer_open_named("/pet_camera_frames_day");
    if (!ctx->day_shm) {
      fprintf(stderr, "[switcher-daemon] failed to open day shared memory\n");
    }
  }
  if (!ctx->night_shm) {
    ctx->night_shm = shm_frame_buffer_open_named("/pet_camera_frames_night");
    if (!ctx->night_shm) {
      fprintf(stderr, "[switcher-daemon] failed to open night shared memory\n");
    }
  }

  // Update frame intervals dynamically via shared memory + signal notification
  // Active camera: 30fps (interval=0), Inactive camera: ~2fps (interval=500ms)

  if (camera == CAMERA_MODE_DAY) {
    // DAY becomes active (30fps), NIGHT becomes inactive (2fps)
    if (ctx->day_shm) {
      __atomic_store_n(&ctx->day_shm->frame_interval_ms, 0, __ATOMIC_RELEASE);
      kill(ctx->day_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] DAY camera -> 30fps\n");
    }
    if (ctx->night_shm) {
      __atomic_store_n(&ctx->night_shm->frame_interval_ms, 500,
                       __ATOMIC_RELEASE);
      kill(ctx->night_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] NIGHT camera -> 2fps\n");
    }
  } else {
    // NIGHT becomes active (30fps), DAY becomes inactive (2fps)
    if (ctx->night_shm) {
      __atomic_store_n(&ctx->night_shm->frame_interval_ms, 0, __ATOMIC_RELEASE);
      kill(ctx->night_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] NIGHT camera -> 30fps\n");
    }
    if (ctx->day_shm) {
      __atomic_store_n(&ctx->day_shm->frame_interval_ms, 500, __ATOMIC_RELEASE);
      kill(ctx->day_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] DAY camera -> 2fps\n");
    }
  }

  ctx->active_camera = camera;
  return 0;
}

static int capture_frame_cb(CameraMode camera, Frame *out_frame,
                            void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  // Initialize shared memory pointers on first use
  if (camera == CAMERA_MODE_DAY && !ctx->day_shm) {
    ctx->day_shm = shm_frame_buffer_open_named("/pet_camera_frames_day");
    if (!ctx->day_shm) {
      fprintf(stderr, "[switcher-daemon] failed to open day shared memory\n");
      return -1;
    }
  } else if (camera == CAMERA_MODE_NIGHT && !ctx->night_shm) {
    ctx->night_shm = shm_frame_buffer_open_named("/pet_camera_frames_night");
    if (!ctx->night_shm) {
      fprintf(stderr, "[switcher-daemon] failed to open night shared memory\n");
      return -1;
    }
  }

  // Read from the requested camera's shared memory
  SharedFrameBuffer *target_shm =
      (camera == CAMERA_MODE_DAY) ? ctx->day_shm : ctx->night_shm;
  int ret = shm_frame_buffer_read_latest(target_shm, out_frame);

  return (ret >= 0) ? 0 : -1;
}

static int publish_frame_cb(const Frame *frame, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;
  if (!ctx->shm) {
    ctx->shm = shm_frame_buffer_open();
    if (!ctx->shm) {
      fprintf(stderr,
              "[switcher-daemon] failed to open shared memory for publish\n");
      return -1;
    }
  }
  return shm_frame_buffer_write(ctx->shm, frame);
}

static volatile sig_atomic_t g_stop = 0;
static void handle_signal(int sig) {
  (void)sig;
  g_stop = 1;
}

int main(void) {
  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);

  CameraSwitchConfig cfg = {
      .day_to_night_threshold = 40.0,
      .night_to_day_threshold =
          60.0, // Lowered from 70.0 to match typical indoor brightness
      .day_to_night_hold_seconds = 0.5, // Reduced from 10.0 for faster response
      .night_to_day_hold_seconds = 3.0, // Reduced from 10.0 for faster response
      .warmup_frames = 3,
  };

  CameraSwitchRuntimeConfig rt_cfg = {
      .probe_interval_sec = 2.0,
      .active_interval_sec = 0.5,  // Check brightness every 500ms for quick response
  };

  DaemonContext ctx = {.day_pid = -1,
                       .night_pid = -1,
                       .active_camera = CAMERA_MODE_DAY,
                       .shm = NULL,
                       .day_shm = NULL,
                       .night_shm = NULL};

  CameraCaptureOps ops = {
      .switch_camera = switch_camera_cb,
      .capture_frame = capture_frame_cb,
      .publish_frame = publish_frame_cb,
      .user_data = &ctx,
  };

  CameraSwitchRuntime rt;
  camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, CAMERA_MODE_DAY);

  // Create main shared memory for publishing to web/detection
  ctx.shm = shm_frame_buffer_create();
  if (!ctx.shm) {
    fprintf(stderr, "[switcher-daemon] failed to create main shared memory\n");
    return 1;
  }
  printf("[switcher-daemon] created main shared memory: /pet_camera_frames\n");

  // Start both camera daemons
  // Active camera: 30fps, Inactive camera: ~2fps
  // Frame interval is dynamically controlled via shared memory

  // Day camera: 30fps (active initially), JPEG format
  ctx.day_pid = spawn_daemon_with_shm(CAMERA_MODE_DAY, "/pet_camera_frames_day",
                                      0, false);
  if (ctx.day_pid <= 0) {
    fprintf(stderr, "[switcher-daemon] failed to start day camera daemon\n");
    return 1;
  }

  // Night camera: ~2fps (inactive initially), JPEG format
  ctx.night_pid = spawn_daemon_with_shm(CAMERA_MODE_NIGHT,
                                        "/pet_camera_frames_night", 500, false);
  if (ctx.night_pid <= 0) {
    fprintf(stderr, "[switcher-daemon] failed to start night camera daemon\n");
    kill_daemon(ctx.day_pid);
    return 1;
  }

  printf("[switcher-daemon] both cameras started\n");

  if (camera_switch_runtime_start(&rt) != 0) {
    fprintf(stderr, "[switcher-daemon] failed to start runtime threads\n");
    kill_daemon(ctx.day_pid);
    kill_daemon(ctx.night_pid);
    return 1;
  }

  printf("[switcher-daemon] running. Press Ctrl+C to stop.\n");
  while (!g_stop) {
    sleep(1);
  }

  printf("[switcher-daemon] stopping...\n");
  camera_switch_runtime_stop(&rt);

  // Stop both daemons (they will destroy their own shared memory)
  kill_daemon(ctx.day_pid);
  kill_daemon(ctx.night_pid);

  // Close camera-specific shared memory
  if (ctx.day_shm) {
    shm_frame_buffer_close(ctx.day_shm);
  }
  if (ctx.night_shm) {
    shm_frame_buffer_close(ctx.night_shm);
  }

  // Destroy main shared memory (we created it)
  if (ctx.shm) {
    shm_frame_buffer_destroy(ctx.shm);
  }

  return 0;
}
