/*
 * camera_daemon_main.c - Unified Camera Daemon
 *
 * Single process managing both DAY and NIGHT camera pipelines
 * with an integrated brightness-based switcher thread.
 *
 * Architecture:
 *   - 2 camera pipelines (DAY=0, NIGHT=1) running at 30fps
 *   - Switcher thread reads ISP brightness directly (no SHM)
 *   - Active camera index is a shared variable (no CameraControl SHM)
 *   - Each pipeline maintains its own frame_number counter
 *   - Only 2 SHMs: yolo_zc (detector) + h265_zc (Go streaming)
 */

#define _POSIX_C_SOURCE 200809L

#include "camera_pipeline.h"
#include "camera_switcher.h"
#include "logger.h"
#include "isp_brightness.h"
#include "tcp_relay.h"
#include <getopt.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#define DEFAULT_FPS           30
#define DEFAULT_BITRATE       600000
#define DEFAULT_OUTPUT_WIDTH  1280
#define DEFAULT_OUTPUT_HEIGHT 720

// Shared state (no SHM needed — same process)
static volatile bool g_running = true;
static volatile int g_active_camera = 0; // 0=DAY, 1=NIGHT

// Pipelines
static camera_pipeline_t g_pipelines[2];

static void signal_handler(int signum) {
    (void)signum;
    g_running = false;
}

// Pipeline thread wrapper
typedef struct {
    camera_pipeline_t* pipeline;
    volatile bool* running;
} pipeline_run_arg_t;
static void* pipeline_thread_fn(void* arg) {
    pipeline_run_arg_t* a = (pipeline_run_arg_t*)arg;
    pipeline_run(a->pipeline, a->running);
    return NULL;
}

// Switcher thread: reads ISP brightness directly, switches active camera
typedef struct {
    CameraSwitchController switcher;
    int poll_interval_day_ms;
    int poll_interval_night_ms;
} switcher_thread_ctx_t;

static void* switcher_thread(void* arg) {
    switcher_thread_ctx_t* ctx = (switcher_thread_ctx_t*)arg;

    LOG_INFO("Switcher", "Thread started");

    while (g_running) {
        // Read brightness directly from DAY camera ISP handle
        isp_brightness_result_t brightness = {.valid = false};
        if (g_pipelines[0].vio.isp_handle > 0) {
            isp_get_brightness(g_pipelines[0].vio.isp_handle, &brightness);
        }

        if (brightness.valid) {
            CameraSwitchDecision decision = camera_switcher_record_brightness(
                &ctx->switcher, CAMERA_MODE_DAY, (double)brightness.brightness_avg);

            if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
                int prev = g_active_camera;
                g_active_camera = 1;
                if (prev != 1) {
                    camera_switcher_notify_active_camera(&ctx->switcher, CAMERA_MODE_NIGHT,
                                                         "auto-night");
                    LOG_INFO("Switcher", "Switch: DAY -> NIGHT (brightness=%.1f)",
                             brightness.brightness_avg);
                    // Wake inactive pipeline threads immediately
                    pthread_cond_broadcast(&g_pipelines[0].switch_cond);
                    pthread_cond_broadcast(&g_pipelines[1].switch_cond);
                }
            } else if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
                int prev = g_active_camera;
                g_active_camera = 0;
                if (prev != 0) {
                    camera_switcher_notify_active_camera(&ctx->switcher, CAMERA_MODE_DAY,
                                                         "auto-day");
                    LOG_INFO("Switcher", "Switch: NIGHT -> DAY (brightness=%.1f)",
                             brightness.brightness_avg);
                    // Wake inactive pipeline threads immediately
                    pthread_cond_broadcast(&g_pipelines[0].switch_cond);
                    pthread_cond_broadcast(&g_pipelines[1].switch_cond);
                }
            }
        }

        const int interval_ms =
            (g_active_camera == 0) ? ctx->poll_interval_day_ms : ctx->poll_interval_night_ms;
        usleep(interval_ms * 1000);
    }

    LOG_INFO("Switcher", "Thread stopped");
    return NULL;
}

int main(int argc, char* argv[]) {
    int output_width = DEFAULT_OUTPUT_WIDTH;
    int output_height = DEFAULT_OUTPUT_HEIGHT;
    int fps = DEFAULT_FPS;
    int bitrate = DEFAULT_BITRATE;
    log_level_t log_level = LOG_LEVEL_INFO;
    int single_camera = -1; // -1 = dual, 0 = day only, 1 = night only

    static const struct option long_options[] = {
        {"width", required_argument, 0, 'W'},  {"height", required_argument, 0, 'H'},
        {"fps", required_argument, 0, 'f'},    {"bitrate", required_argument, 0, 'b'},
        {"camera", required_argument, 0, 'C'}, {"verbose", no_argument, 0, 'v'},
        {"help", no_argument, 0, 'h'},         {0, 0, 0, 0}};

    int opt;
    while ((opt = getopt_long(argc, argv, "W:H:f:b:C:vh", long_options, NULL)) != -1) {
        switch (opt) {
        case 'W':
            output_width = atoi(optarg);
            break;
        case 'H':
            output_height = atoi(optarg);
            break;
        case 'f':
            fps = atoi(optarg);
            break;
        case 'b':
            bitrate = atoi(optarg);
            break;
        case 'C':
            single_camera = atoi(optarg);
            break;
        case 'v':
            log_level = LOG_LEVEL_DEBUG;
            break;
        case 'h':
            printf("Usage: %s [-W width] [-H height] [-f fps] [-b bitrate] [-C camera] [-v]\n",
                   argv[0]);
            printf("  -C N   Single camera mode (0=day, 1=night). Default: dual mode\n");
            return 0;
        default:
            return 1;
        }
    }

    log_init(log_level, stdout, 0);
    LOG_INFO("Main", "Unified Camera Daemon Starting");

    struct sigaction sa = {0};
    sa.sa_handler = signal_handler;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    // Create detection SHM (needed by detector)
    shm_unlink(SHM_NAME_DETECTIONS);
    LatestDetectionResult* detection_shm = shm_detection_create();
    if (!detection_shm) {
        LOG_ERROR("Main", "Failed to create detection SHM");
        return 1;
    }

    // Create pipelines
    const int num_cameras = (single_camera >= 0) ? 1 : 2;
    int camera_indices[2] = {0, 1};
    if (single_camera >= 0) {
        camera_indices[0] = single_camera;
    }

    bool any_failed = false;
    for (int i = 0; i < num_cameras; i++) {
        int cam = camera_indices[i];
        LOG_INFO("Main", "Creating pipeline for camera %d (%dx%d@%dfps)", cam, output_width,
                 output_height, fps);

        int ret = pipeline_create(&g_pipelines[cam], cam, 1920, 1080, // sensor
                                  output_width, output_height, fps, bitrate, &g_active_camera);
        if (ret != 0) {
            LOG_ERROR("Main", "Failed to create pipeline for camera %d: %d", cam, ret);
            any_failed = true;
            continue;
        }

        ret = pipeline_start(&g_pipelines[cam]);
        if (ret != 0) {
            LOG_ERROR("Main", "Failed to start pipeline for camera %d: %d", cam, ret);
            pipeline_destroy(&g_pipelines[cam]);
            any_failed = true;
            continue;
        }
    }

    // In dual-camera mode, all pipelines must succeed.
    // Exit so systemd (Restart=on-failure) retries — VIO init failures are often transient.
    if (any_failed && single_camera < 0) {
        LOG_ERROR("Main", "One or more pipelines failed in dual-camera mode, exiting for restart");
        for (int i = 0; i < num_cameras; i++) {
            pipeline_stop(&g_pipelines[camera_indices[i]]);
            pipeline_destroy(&g_pipelines[camera_indices[i]]);
        }
        shm_detection_destroy(detection_shm);
        return 1;
    }

    // TCP relay for night-assist: stream NIGHT camera H.265 to ai-pyramid (port 9265)
    // Only when NIGHT camera (index 1) pipeline is active
    TcpRelay* relay = NULL;
    if (single_camera < 0 || single_camera == 1) {
        relay = tcp_relay_create(9265);
        if (relay) {
            g_pipelines[1].encoder_thread.tcp_relay = relay;
            LOG_INFO("Main", "TCP relay enabled on port 9265");
        }
    }

    // Start switcher thread (only in dual camera mode)
    pthread_t switcher_tid = 0;
    switcher_thread_ctx_t switcher_ctx = {0};
    if (num_cameras == 2) {
        CameraSwitchConfig cfg = {
            .day_to_night_threshold = 50.0,
            .night_to_day_threshold = 60.0,
            .day_to_night_hold_seconds = 0.5,
            .night_to_day_hold_seconds = 3.0,
            .warmup_frames = 15,
        };
        camera_switcher_init(&switcher_ctx.switcher, &cfg);
        switcher_ctx.poll_interval_day_ms = 250;
        switcher_ctx.poll_interval_night_ms = 5000;

        // Initial state: DAY active
        g_active_camera = 0;
        camera_switcher_notify_active_camera(&switcher_ctx.switcher, CAMERA_MODE_DAY, "init");

        pthread_create(&switcher_tid, NULL, switcher_thread, &switcher_ctx);
        LOG_INFO("Main", "Switcher thread started (dual camera mode)");
    } else {
        g_active_camera = camera_indices[0];
        LOG_INFO("Main", "Single camera mode: camera %d", g_active_camera);
    }

    // Run pipelines (each in current thread context, checking active state)
    // Both pipelines run their capture loops, but only active one encodes
    // We use pipeline_run which checks write_active internally

    // Run pipelines in threads
    pthread_t pipeline_tids[2] = {0};
    pipeline_run_arg_t pipeline_args[2] = {0};

    for (int i = 0; i < num_cameras; i++) {
        int cam = camera_indices[i];
        pipeline_args[i].pipeline = &g_pipelines[cam];
        pipeline_args[i].running = &g_running;
        pthread_create(&pipeline_tids[i], NULL, pipeline_thread_fn, &pipeline_args[i]);
        LOG_INFO("Main", "Pipeline thread started for camera %d", cam);
    }

    // Wait for all pipeline threads
    for (int i = 0; i < num_cameras; i++) {
        pthread_join(pipeline_tids[i], NULL);
    }

    // Cleanup
    g_running = false;

    if (switcher_tid) {
        pthread_join(switcher_tid, NULL);
        camera_switcher_destroy(&switcher_ctx.switcher);
    }

    if (relay) {
        tcp_relay_destroy(relay);
        g_pipelines[1].encoder_thread.tcp_relay = NULL;
    }

    for (int i = 0; i < num_cameras; i++) {
        int cam = camera_indices[i];
        pipeline_stop(&g_pipelines[cam]);
        pipeline_destroy(&g_pipelines[cam]);
    }

    shm_detection_destroy(detection_shm);
    LOG_INFO("Main", "Unified Camera Daemon Stopped");
    return 0;
}
