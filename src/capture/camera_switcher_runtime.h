/**
 * camera_switcher_runtime.h
 *
 * Wiring of CameraSwitchController into a capture daemon style runtime.
 * - Manages probe timing and active capture timing
 * - Invokes user-provided callbacks to switch hardware, capture frames, and publish
 * - Uses CameraSwitchController for hysteresis and warmup-aware publication
 *
 * This is a thin orchestration layer; it does not know about vendor SDKs.
 * Integrators provide callbacks that operate the real capture daemon.
 */

#ifndef CAMERA_SWITCHER_RUNTIME_H
#define CAMERA_SWITCHER_RUNTIME_H

#include <stdbool.h>
#include <pthread.h>

#include "camera_switcher.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int (*switch_camera)(CameraMode camera, void* user_data);
    int (*wait_for_new_frame)(void* user_data);  // Wait for new frame signal (sem_wait) - called every frame
    int (*capture_active_frame)(CameraMode camera, Frame* out_frame, void* user_data);  // Read active camera frames (after sem_wait)
    int (*capture_probe_frame)(CameraMode camera, Frame* out_frame, void* user_data);   // Read probe frames (send signal)
    int (*publish_frame)(const Frame* frame, void* user_data);
    void* user_data;
} CameraCaptureOps;

typedef struct {
    double probe_interval_sec;                    // how often to probe inactive camera brightness
    double active_interval_sec;                   // target interval for active camera capture (unused)
    int brightness_check_interval_frames_day;     // day camera: check every N frames (e.g., 3 = 10fps at 30fps)
    int brightness_check_interval_frames_night;   // night camera: check every N frames (e.g., 30 = 1fps at 30fps)
} CameraSwitchRuntimeConfig;

typedef struct {
    CameraSwitchController controller;
    CameraCaptureOps ops;
    CameraSwitchRuntimeConfig cfg;

    volatile bool stop_flag;
    CameraMode active_camera;

    pthread_t active_thread;
    pthread_t probe_thread;
} CameraSwitchRuntime;

/**
 * Initialize runtime with controller config and runtime timing.
 */
void camera_switch_runtime_init(CameraSwitchRuntime* rt,
                                const CameraSwitchConfig* ctrl_cfg,
                                const CameraSwitchRuntimeConfig* rt_cfg,
                                const CameraCaptureOps* ops,
                                CameraMode initial_camera);

/**
 * Start background threads (active capture + probe).
 */
int camera_switch_runtime_start(CameraSwitchRuntime* rt);

/**
 * Stop threads and free controller buffers.
 */
void camera_switch_runtime_stop(CameraSwitchRuntime* rt);

#ifdef __cplusplus
}
#endif

#endif  // CAMERA_SWITCHER_RUNTIME_H
