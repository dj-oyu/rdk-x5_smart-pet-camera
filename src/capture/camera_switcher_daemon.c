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
    pid_t current_pid;    // PID of currently active daemon
    CameraMode active_camera;  // Currently active camera
    SharedFrameBuffer* shm;
    SharedFrameBuffer* probe_shm;  // Dedicated shared memory for probe captures
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

static void kill_daemon(pid_t pid, bool preserve_shm) {
    if (pid <= 0) {
        return;
    }
    int sig = preserve_shm ? SIGUSR1 : SIGTERM;
    kill(pid, sig);
    waitpid(pid, NULL, 0);
}

static int switch_camera_cb(CameraMode camera, void* user_data) {
    DaemonContext* ctx = (DaemonContext*)user_data;
    // Preserve shared memory during camera swap; the daemon will close (not unlink)
    kill_daemon(ctx->current_pid, true);
    ctx->current_pid = spawn_daemon(camera);
    ctx->active_camera = camera;
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

    // If requested camera is inactive (probe), use dedicated shared memory
    if (camera != ctx->active_camera) {
        printf("[switcher-daemon] probing inactive camera=%d with dedicated shared memory\n", (int)camera);

        const char* probe_shm_name = "/pet_camera_frames_probe";

        // Initialize probe shared memory on first use
        if (!ctx->probe_shm) {
            ctx->probe_shm = shm_frame_buffer_open_named(probe_shm_name);
            if (!ctx->probe_shm) {
                // Create if it doesn't exist
                ctx->probe_shm = shm_frame_buffer_create_named(probe_shm_name);
                if (!ctx->probe_shm) {
                    fprintf(stderr, "[switcher-daemon] failed to create probe shared memory\n");
                    return -1;
                }
            }
        }

        // Clear probe shared memory before capture to avoid reading stale data
        memset(ctx->probe_shm, 0, sizeof(SharedFrameBuffer));

        // Spawn 1-shot daemon for probe with custom shared memory name
        pid_t probe_pid = fork();
        if (probe_pid < 0) {
            perror("fork");
            return -1;
        }
        if (probe_pid == 0) {
            // Set environment variable for custom shared memory name
            setenv("SHM_NAME", probe_shm_name, 1);

            // TODO: Enable logs temporarily for debugging
            // Suppress verbose logs from 1-shot probe by redirecting to /dev/null
            // freopen("/dev/null", "w", stdout);
            // freopen("/dev/null", "w", stderr);

            char camera_arg[16];
            snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);
            // Capture 5 frames to allow ISP to stabilize, then use the last frame
            execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-P", "1", "-c", "5", NULL);
            // If execl returns, it failed
            perror("[probe] execl failed");
            _exit(1);
        }

        // Wait for probe daemon to capture 1 frame and exit naturally
        // The daemon will automatically preserve custom-named shared memory
        int status;
        waitpid(probe_pid, &status, 0);

        // Check if probe daemon exited successfully
        if (WIFEXITED(status)) {
            int exit_code = WEXITSTATUS(status);
            printf("[switcher-daemon] 1-shot capture completed with exit code %d\n", exit_code);
            if (exit_code != 0) {
                fprintf(stderr, "[switcher-daemon] WARNING: probe daemon exited with error\n");
                return -1;
            }
        } else if (WIFSIGNALED(status)) {
            fprintf(stderr, "[switcher-daemon] WARNING: probe daemon killed by signal %d\n", WTERMSIG(status));
            return -1;
        }

        // Read the latest frame from probe shared memory
        int ret = shm_frame_buffer_read_latest(ctx->probe_shm, out_frame);

        printf("[switcher-daemon] probe frame read: ret=%d, camera=%d, %dx%d, format=%d, data_size=%zu, write_index=%u\n",
               ret, out_frame->camera_id, out_frame->width, out_frame->height,
               out_frame->format, out_frame->data_size,
               shm_frame_buffer_get_write_index(ctx->probe_shm));

        return (ret >= 0) ? 0 : -1;
    }

    // For active camera, just read latest frame from main shared memory
    // Active daemon only writes its own camera_id, so no need to check
    return shm_frame_buffer_read_latest(ctx->shm, out_frame) >= 0 ? 0 : -1;
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
        .night_to_day_threshold = 60.0,  // Lowered from 70.0 to match typical indoor brightness
        .day_to_night_hold_seconds = 3.0,  // Reduced from 10.0 for faster response
        .night_to_day_hold_seconds = 3.0,  // Reduced from 10.0 for faster response
        .warmup_frames = 3,
    };

    CameraSwitchRuntimeConfig rt_cfg = {
        .probe_interval_sec = 2.0,
        .active_interval_sec = 1.0 / 30.0,
    };

    DaemonContext ctx = {
        .current_pid = -1,
        .active_camera = CAMERA_MODE_DAY,
        .shm = NULL,
        .probe_shm = NULL
    };

    CameraCaptureOps ops = {
        .switch_camera = switch_camera_cb,
        .capture_frame = capture_frame_cb,
        .publish_frame = publish_frame_cb,
        .user_data = &ctx,
    };

    CameraSwitchRuntime rt;
    camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, CAMERA_MODE_DAY);

    // Start initial daemon (day camera)
    ctx.current_pid = spawn_daemon(CAMERA_MODE_DAY);
    if (ctx.current_pid <= 0) {
        fprintf(stderr, "[switcher-daemon] failed to start initial daemon\n");
        return 1;
    }

    if (camera_switch_runtime_start(&rt) != 0) {
        fprintf(stderr, "[switcher-daemon] failed to start runtime threads\n");
        kill_daemon(ctx.current_pid, false);
        return 1;
    }

    printf("[switcher-daemon] running. Press Ctrl+C to stop.\n");
    while (!g_stop) {
        sleep(1);
    }

    printf("[switcher-daemon] stopping...\n");
    camera_switch_runtime_stop(&rt);
    // Send SIGUSR1 to preserve shared memory when stopping the orchestrator
    kill_daemon(ctx.current_pid, true);
    if (ctx.shm) {
        shm_frame_buffer_close(ctx.shm);
    }
    if (ctx.probe_shm) {
        // Clean up probe shared memory on exit
        shm_frame_buffer_destroy_named(ctx.probe_shm, "/pet_camera_frames_probe");
    }
    return 0;
}
