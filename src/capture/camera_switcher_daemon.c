/**
 * camera_switcher_daemon.c
 *
 * Reference daemon wiring CameraSwitchRuntime to the existing capture daemon binary.
 * - Starts/stops camera_daemon_drobotics with -C <camera_id> on switches
 * - Reads frames from shared memory and feeds brightness to the switcher
 * - Republishes frames back to shared memory with warmup + double buffering
 *
 * NOTE: This is a reference orchestration. It assumes:
 *   - ../../build/camera_daemon_drobotics is built and accessible
 *   - camera_daemon_drobotics writes to the default shared memory defined in shared_memory.h
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
    pid_t current_pid;
    SharedFrameBuffer* shm;
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
        execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-P", "1", "--daemon", NULL);
        perror("execl");
        _exit(1);
    }
    printf("[switcher-daemon] spawned %s (PID=%d) camera=%d\n", CAPTURE_BIN, pid, (int)camera);
    return pid;
}

static void kill_daemon(pid_t pid) {
    if (pid <= 0) {
        return;
    }
    kill(pid, SIGTERM);
    waitpid(pid, NULL, 0);
}

static int switch_camera_cb(CameraMode camera, void* user_data) {
    DaemonContext* ctx = (DaemonContext*)user_data;
    kill_daemon(ctx->current_pid);
    ctx->current_pid = spawn_daemon(camera);
    return ctx->current_pid > 0 ? 0 : -1;
}

static int capture_frame_cb(CameraMode camera, Frame* out_frame, void* user_data) {
    DaemonContext* ctx = (DaemonContext*)user_data;
    if (!ctx->shm) {
        ctx->shm = shm_frame_buffer_open();
        if (!ctx->shm) {
            fprintf(stderr, "[switcher-daemon] failed to open shared memory\n");
            return -1;
        }
    }

    // Poll for a frame belonging to the requested camera
    for (int attempt = 0; attempt < 5; ++attempt) {
        if (shm_frame_buffer_read_latest(ctx->shm, out_frame) >= 0 &&
            out_frame->camera_id == (int)camera) {
            return 0;
        }
        usleep(1000 * 10);  // 10ms
    }
    return -1;
}

static int publish_frame_cb(const Frame* frame, void* user_data) {
    DaemonContext* ctx = (DaemonContext*)user_data;
    if (!ctx->shm) {
        ctx->shm = shm_frame_buffer_open();
        if (!ctx->shm) {
            fprintf(stderr, "[switcher-daemon] failed to open shared memory for publish\n");
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
        .night_to_day_threshold = 70.0,
        .day_to_night_hold_seconds = 10.0,
        .night_to_day_hold_seconds = 10.0,
        .warmup_frames = 3,
    };

    CameraSwitchRuntimeConfig rt_cfg = {
        .probe_interval_sec = 2.0,
        .active_interval_sec = 1.0 / 30.0,
    };

    DaemonContext ctx = {.current_pid = -1, .shm = NULL};

    CameraCaptureOps ops = {
        .switch_camera = switch_camera_cb,
        .capture_frame = capture_frame_cb,
        .publish_frame = publish_frame_cb,
        .user_data = &ctx,
    };

    CameraSwitchRuntime rt;
    camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, CAMERA_MODE_DAY);

    // Start initial daemon
    ctx.current_pid = spawn_daemon(CAMERA_MODE_DAY);
    if (ctx.current_pid <= 0) {
        return 1;
    }

    if (camera_switch_runtime_start(&rt) != 0) {
        fprintf(stderr, "[switcher-daemon] failed to start runtime threads\n");
        kill_daemon(ctx.current_pid);
        return 1;
    }

    printf("[switcher-daemon] running. Press Ctrl+C to stop.\n");
    while (!g_stop) {
        sleep(1);
    }

    printf("[switcher-daemon] stopping...\n");
    camera_switch_runtime_stop(&rt);
    kill_daemon(ctx.current_pid);
    if (ctx.shm) {
        shm_frame_buffer_close(ctx.shm);
    }
    return 0;
}
