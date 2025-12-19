/**
 * camera_switcher.h - Brightness-based camera switch controller (C implementation)
 *
 * - Manages day/night camera selection based on brightness thresholds with hysteresis
 * - Supports manual override (debug) and automatic mode
 * - Provides warmup + double-buffered publishing to shared memory to avoid frame drops
 *
 * Typical usage (within a capture daemon loop):
 *   1. Initialize with thresholds/hold times and warmup frames
 *   2. Periodically feed brightness samples for both cameras (active + probe)
 *   3. When a switch decision is returned, reconfigure hardware to the new camera
 *      and call camera_switcher_notify_active_camera()
 *   4. For each captured frame from the active camera, call
 *      camera_switcher_publish_frame() to gate warmup frames and write to shared memory
 *
 * This module is self-contained (no vendor SDK dependencies) and focuses on
 * switch policy + double-buffering around shared memory publication.
 */

#ifndef CAMERA_SWITCHER_H
#define CAMERA_SWITCHER_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <time.h>

#include "shared_memory.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CAMERA_MODE_DAY = 0,
    CAMERA_MODE_NIGHT = 1
} CameraMode;

typedef enum {
    SWITCH_MODE_AUTO = 0,
    SWITCH_MODE_MANUAL = 1
} SwitchMode;

typedef enum {
    CAMERA_SWITCH_DECISION_NONE = 0,
    CAMERA_SWITCH_DECISION_TO_DAY = 1,
    CAMERA_SWITCH_DECISION_TO_NIGHT = 2
} CameraSwitchDecision;

typedef struct {
    double day_to_night_threshold;      // brightness threshold (mean 0-255) to go night
    double night_to_day_threshold;      // brightness threshold (mean 0-255) to go day
    double day_to_night_hold_seconds;   // required duration below threshold to switch
    double night_to_day_hold_seconds;   // required duration above threshold to switch
    unsigned int warmup_frames;         // frames to drop after switching
} CameraSwitchConfig;

typedef struct {
    double latest_value;
    double avg;
    int samples;
    struct timespec timestamp;
} BrightnessStat;

typedef struct {
    Frame* buffers[2];      // double buffer for publication (heap-allocated)
    int active_slot;        // 0 or 1
    unsigned int warmup_remaining;
} FrameDoubleBuffer;

typedef struct {
    CameraSwitchConfig cfg;
    SwitchMode mode;
    CameraMode active_camera;
    int manual_target;  // -1 when auto, otherwise 0/1
    FrameDoubleBuffer publisher;

    BrightnessStat brightness[2];  // [0]=day, [1]=night
    double below_threshold_since;  // seconds (CLOCK_MONOTONIC), or -1
    double above_threshold_since;  // seconds (CLOCK_MONOTONIC), or -1
    char last_switch_reason[64];
} CameraSwitchController;

typedef int (*camera_publish_fn)(const Frame* frame, void* user_data);

/**
 * Initialize controller with defaults.
 */
void camera_switcher_init(CameraSwitchController* ctrl,
                          const CameraSwitchConfig* cfg);

/**
 * Free internal buffers.
 */
void camera_switcher_destroy(CameraSwitchController* ctrl);

/**
 * Force manual mode and target camera (debug).
 */
void camera_switcher_force_manual(CameraSwitchController* ctrl,
                                  CameraMode camera);

/**
 * Resume automatic switching.
 */
void camera_switcher_resume_auto(CameraSwitchController* ctrl);

/**
 * Record a brightness sample for a camera (active or probed).
 *
 * Returns a switch decision (for AUTO mode only). Callers should react by
 * reconfiguring hardware when a TO_DAY/TO_NIGHT decision is returned.
 */
CameraSwitchDecision camera_switcher_record_brightness(CameraSwitchController* ctrl,
                                                       CameraMode camera,
                                                       double brightness);

/**
 * Calculate mean luma (0-255) from a Frame.
 * Supports JPEG (format=0), NV12 (format=1), and RGB (format=2).
 * Returns negative value on error.
 */
double frame_calculate_mean_luma(const Frame* frame);

/**
 * Convenience: process a frame, record brightness, and (optionally) publish if active.
 *
 * Returns switch decision (NONE/TO_DAY/TO_NIGHT). Caller is responsible for
 * invoking camera_switcher_notify_active_camera() after reconfiguring hardware.
 */
CameraSwitchDecision camera_switcher_handle_frame(CameraSwitchController* ctrl,
                                                  const Frame* frame,
                                                  CameraMode camera,
                                                  bool is_active_camera,
                                                  camera_publish_fn publish_cb,
                                                  void* user_data);

/**
 * Notify controller that hardware has switched to a camera.
 * Resets warmup/drop counters.
 */
void camera_switcher_notify_active_camera(CameraSwitchController* ctrl,
                                          CameraMode camera,
                                          const char* reason);

/**
 * Publish a captured frame with double-buffering and warmup gating.
 *
 * The frame is copied into an internal double buffer before publishing to
 * avoid readers observing partially written data during camera switches.
 * Returns 0 on success, -1 on error (e.g., null callback).
 */
int camera_switcher_publish_frame(CameraSwitchController* ctrl,
                                  const Frame* frame,
                                  camera_publish_fn publish_cb,
                                  void* user_data);

/**
 * Snapshot current status (lightweight helper).
 */
void camera_switcher_get_status(const CameraSwitchController* ctrl,
                                SwitchMode* mode,
                                CameraMode* active,
                                BrightnessStat out_stats[2],
                                char* reason_buf,
                                size_t reason_buf_len);

#ifdef __cplusplus
}
#endif

#endif  // CAMERA_SWITCHER_H
