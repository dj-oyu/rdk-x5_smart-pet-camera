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

#include "camera_switcher.h"
#include "camera_switcher_runtime.h"
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
  SharedFrameBuffer *main_shm_nv12;  // Active NV12 shared memory
  SharedFrameBuffer *main_shm_h264;  // Active H.264 shared memory
  SharedFrameBuffer *day_shm_nv12;   // Day camera NV12 shared memory
  SharedFrameBuffer *night_shm_nv12; // Night camera NV12 shared memory
  SharedFrameBuffer *day_shm_h264;   // Day camera H.264 shared memory
  SharedFrameBuffer *night_shm_h264; // Night camera H.264 shared memory
} DaemonContext;

static int spawn_daemon_with_shm(CameraMode camera, const char *nv12_name,
                                 const char *h264_name, int frame_interval_ms) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return -1;
  }
  if (pid == 0) {
    char *envp[5];
    char env_vals[4][64];
    size_t env_cnt = 0;

    // Set custom shared memory names
    if (nv12_name) {
      // setenv("SHM_NAME_NV12", nv12_name, 1);
      snprintf(env_vals[env_cnt], sizeof(env_vals[0]), "SHM_NAME_NV12=%s",
               nv12_name);
      envp[env_cnt] = env_vals[env_cnt];
      env_cnt++;
    }
    if (h264_name) {
      // setenv("SHM_NAME_H264", h264_name, 1);
      snprintf(env_vals[env_cnt], sizeof(env_vals[0]), "SHM_NAME_H264=%s",
               h264_name);
      envp[env_cnt] = env_vals[env_cnt];
      env_cnt++;
    }

    // Set frame interval for low-rate capture (inactive camera)
    if (frame_interval_ms > 0) {
      snprintf(env_vals[env_cnt], sizeof(env_vals[0]), "FRAME_INTERVAL_MS=%d",
               frame_interval_ms);
      // setenv("FRAME_INTERVAL_MS", interval_str, 1);
      envp[env_cnt] = env_vals[env_cnt];
      env_cnt++;
    }

    char camera_arg[16];
    snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);

    envp[env_cnt] = NULL;
    printf("[ENVIRONMENT]");
    for (int env_i = 0; envp[env_i] != NULL; env_i++) {
      printf("env[%d]: %s ", env_i, envp[env_i]);
    }
    printf("\n");

    execle(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-P", "1", "--daemon",
           NULL, envp);
    perror("execle");
    _exit(1);
  }
  printf(
      "[switcher-daemon] spawned %s (PID=%d) camera=%d nv12=%s h264=%s "
      "interval=%dms\n",
      CAPTURE_BIN, pid, (int)camera,
      nv12_name ? nv12_name : "(default)", h264_name ? h264_name : "(none)",
      frame_interval_ms);
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
        printf("[switcher-daemon] waiting for %s to be created...\n", name);
      }
      usleep(100000); // 100ms
      retries++;
    }
  }

  if (shm) {
    printf("[switcher-daemon] opened %s\n", name);
  } else {
    fprintf(stderr, "[switcher-daemon] timeout waiting for %s\n", name);
  }

  return shm;
}

static int switch_camera_cb(CameraMode camera, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  printf("[switcher-daemon] switching to camera=%d\n", (int)camera);

  // Open shared memory segments if not already opened (with retry)
  if (!ctx->day_shm_nv12) {
    ctx->day_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_DAY, 10); // 1 second max
  }
  if (!ctx->night_shm_nv12) {
    ctx->night_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_NIGHT, 10);
  }
  if (!ctx->day_shm_h264) {
    ctx->day_shm_h264 = wait_for_shm(SHM_NAME_STREAM_DAY, 10);
  }
  if (!ctx->night_shm_h264) {
    ctx->night_shm_h264 = wait_for_shm(SHM_NAME_STREAM_NIGHT, 10);
  }

  // Update frame intervals dynamically via shared memory + signal notification
  // Active camera: 30fps (interval=0), Inactive camera: ~2fps (interval=500ms)

  if (camera == CAMERA_MODE_DAY) {
    // DAY becomes active (30fps), NIGHT becomes inactive (2fps)
    if (ctx->day_shm_nv12) {
      __atomic_store_n(&ctx->day_shm_nv12->frame_interval_ms, 0,
                       __ATOMIC_RELEASE);
      kill(ctx->day_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] DAY camera -> 30fps\n");
    }
    if (ctx->night_shm_nv12) {
      __atomic_store_n(&ctx->night_shm_nv12->frame_interval_ms, 500,
                       __ATOMIC_RELEASE);
      kill(ctx->night_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] NIGHT camera -> 2fps\n");
    }
  } else {
    // NIGHT becomes active (30fps), DAY becomes inactive (2fps)
    if (ctx->night_shm_nv12) {
      __atomic_store_n(&ctx->night_shm_nv12->frame_interval_ms, 0,
                       __ATOMIC_RELEASE);
      kill(ctx->night_pid, SIGUSR1); // Push notification
      printf("[switcher-daemon] NIGHT camera -> 30fps\n");
    }
    if (ctx->day_shm_nv12) {
      __atomic_store_n(&ctx->day_shm_nv12->frame_interval_ms, 500,
                       __ATOMIC_RELEASE);
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

  // Initialize shared memory pointers on first use (with retry)
  if (camera == CAMERA_MODE_DAY && !ctx->day_shm_nv12) {
    ctx->day_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_DAY, 10);
    if (!ctx->day_shm_nv12) {
      return -1; // Timeout
    }
  } else if (camera == CAMERA_MODE_NIGHT && !ctx->night_shm_nv12) {
    ctx->night_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_NIGHT, 10);
    if (!ctx->night_shm_nv12) {
      return -1; // Timeout
    }
  }

  // Read from the requested camera's shared memory
  SharedFrameBuffer *target_shm =
      (camera == CAMERA_MODE_DAY) ? ctx->day_shm_nv12 : ctx->night_shm_nv12;
  int ret = shm_frame_buffer_read_latest(target_shm, out_frame);

  return (ret >= 0) ? 0 : -1;
}

static int publish_frame_cb(const Frame *frame, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;
  if (!ctx->main_shm_nv12) {
    ctx->main_shm_nv12 = wait_for_shm(SHM_NAME_ACTIVE_FRAME, 10);
    if (!ctx->main_shm_nv12) {
      return -1; // Timeout
    }
  }
  if (shm_frame_buffer_write(ctx->main_shm_nv12, frame) < 0) {
    return -1;
  }

  if (!ctx->main_shm_h264) {
    ctx->main_shm_h264 = wait_for_shm(SHM_NAME_STREAM, 10);
  }
  if (ctx->main_shm_h264) {
    SharedFrameBuffer *source_h264 = (ctx->active_camera == CAMERA_MODE_DAY)
                                         ? ctx->day_shm_h264
                                         : ctx->night_shm_h264;
    if (source_h264) {
      Frame h264_frame = {0};
      if (shm_frame_buffer_read_latest(source_h264, &h264_frame) >= 0) {
        shm_frame_buffer_write(ctx->main_shm_h264, &h264_frame);
      }
    }
  }

  return 0;
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
      .day_to_night_hold_seconds = 0.5, // Back to original for testing
      .night_to_day_hold_seconds = 3.0, // Reduced from 10.0 for faster response
      .warmup_frames = 15,
  };

  CameraSwitchRuntimeConfig rt_cfg = {
      .probe_interval_sec = 2.0,
      .active_interval_sec =
          0.5, // Check brightness every 500ms for quick response
  };

  DaemonContext ctx = {.day_pid = -1,
                       .night_pid = -1,
                       .active_camera = CAMERA_MODE_DAY,
                       .main_shm_nv12 = NULL,
                       .main_shm_h264 = NULL,
                       .day_shm_nv12 = NULL,
                       .night_shm_nv12 = NULL,
                       .day_shm_h264 = NULL,
                       .night_shm_h264 = NULL};

  CameraCaptureOps ops = {
      .switch_camera = switch_camera_cb,
      .capture_frame = capture_frame_cb,
      .publish_frame = publish_frame_cb,
      .user_data = &ctx,
  };

  // Create main shared memory for publishing to web/detection/stream
  ctx.main_shm_nv12 = shm_frame_buffer_create_named(SHM_NAME_ACTIVE_FRAME);
  if (!ctx.main_shm_nv12) {
    fprintf(stderr, "[switcher-daemon] failed to create NV12 shared memory\n");
    return 1;
  }
  ctx.main_shm_h264 = shm_frame_buffer_create_named(SHM_NAME_STREAM);
  if (!ctx.main_shm_h264) {
    fprintf(stderr, "[switcher-daemon] failed to create H.264 shared memory\n");
    return 1;
  }
  printf("[switcher-daemon] created main shared memory: %s, %s\n",
         SHM_NAME_ACTIVE_FRAME, SHM_NAME_STREAM);

  // Start camera daemons
  // Active camera: 30fps, Inactive camera: ~2fps
  // Frame interval is dynamically controlled via shared memory

  // Check if SINGLE_CAMERA_MODE is enabled (for testing with one camera)
  const char *single_camera_mode = getenv("SINGLE_CAMERA_MODE");
  int use_single_camera = (single_camera_mode && atoi(single_camera_mode) == 1);

  if (use_single_camera) {
    printf("[switcher-daemon] SINGLE_CAMERA_MODE: using camera 0 for both "
           "DAY/NIGHT\n");

    // Use camera 0 for both DAY and NIGHT (shared camera, different shared
    // memory)
    ctx.day_pid =
        spawn_daemon_with_shm(0, SHM_NAME_FRAMES_DAY, SHM_NAME_STREAM_DAY, 0);
    if (ctx.day_pid <= 0) {
      fprintf(stderr, "[switcher-daemon] failed to start day camera daemon\n");
      return 1;
    }

    // For single camera mode, don't start a second daemon
    // The runtime will just read from the same camera's shared memory
    ctx.night_pid = -1; // No night camera daemon in single camera mode
    printf("[switcher-daemon] Single camera started (DAY mode only)\n");
  } else {
    // Dual camera mode (original behavior)
    printf("[switcher-daemon] DUAL_CAMERA_MODE: starting both cameras\n");

    // Day camera: 30fps (active initially)
    ctx.day_pid = spawn_daemon_with_shm(CAMERA_MODE_DAY, SHM_NAME_FRAMES_DAY,
                                        SHM_NAME_STREAM_DAY, 0);
    if (ctx.day_pid <= 0) {
      fprintf(stderr, "[switcher-daemon] failed to start day camera daemon\n");
      return 1;
    }

    // Night camera: ~2fps (inactive initially)
    ctx.night_pid = spawn_daemon_with_shm(
        CAMERA_MODE_NIGHT, SHM_NAME_FRAMES_NIGHT, SHM_NAME_STREAM_NIGHT, 500);
    if (ctx.night_pid <= 0) {
      fprintf(stderr,
              "[switcher-daemon] failed to start night camera daemon\n");
      kill_daemon(ctx.day_pid);
      return 1;
    }

    printf("[switcher-daemon] both cameras started\n");
  }

  // Wait for camera daemons to create their shared memory (max 5 seconds)
  printf("[switcher-daemon] waiting for camera daemons to initialize...\n");
  ctx.day_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_DAY, 50); // 50 * 100ms = 5s
  ctx.day_shm_h264 = wait_for_shm(SHM_NAME_STREAM_DAY, 50);

  if (!use_single_camera) {
    ctx.night_shm_nv12 = wait_for_shm(SHM_NAME_FRAMES_NIGHT, 50);
    ctx.night_shm_h264 = wait_for_shm(SHM_NAME_STREAM_NIGHT, 50);
  } else {
    // In single camera mode, use DAY camera's shared memory for both
    ctx.night_shm_nv12 = ctx.day_shm_nv12;
    ctx.night_shm_h264 = ctx.day_shm_h264;
    printf("[switcher-daemon] Single camera mode: using DAY camera for both "
           "modes\n");
  }

  uint32_t day_index =
      ctx.day_shm_nv12 ? shm_frame_buffer_get_write_index(ctx.day_shm_nv12) : 0;
  uint32_t night_index =
      ctx.night_shm_nv12 ? shm_frame_buffer_get_write_index(ctx.night_shm_nv12)
                         : 0;

  CameraMode initial_camera = CAMERA_MODE_DAY;
  if (day_index == 0 && night_index > 0) {
    initial_camera = CAMERA_MODE_NIGHT;
  }

  if (switch_camera_cb(initial_camera, &ctx) != 0) {
    fprintf(stderr, "[switcher-daemon] failed to apply initial camera\n");
  }

  CameraSwitchRuntime rt;
  camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, initial_camera);

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
  if (ctx.day_shm_nv12) {
    shm_frame_buffer_close(ctx.day_shm_nv12);
  }
  if (ctx.night_shm_nv12) {
    shm_frame_buffer_close(ctx.night_shm_nv12);
  }
  if (ctx.day_shm_h264) {
    shm_frame_buffer_close(ctx.day_shm_h264);
  }
  if (ctx.night_shm_h264) {
    shm_frame_buffer_close(ctx.night_shm_h264);
  }

  // Destroy main shared memory (we created it)
  if (ctx.main_shm_nv12) {
    shm_frame_buffer_destroy(ctx.main_shm_nv12);
  }
  if (ctx.main_shm_h264) {
    shm_frame_buffer_destroy(ctx.main_shm_h264);
  }

  return 0;
}
