/**
 * camera_switcher.h - Signal-based camera switch controller (C implementation)
 *
 * - Manages day/night camera selection from a scalar switch signal with
 *   hysteresis (signal definition lives in switch_signal.h)
 * - Supports manual override (debug) and automatic mode
 *
 * Typical usage (switcher thread):
 *   1. Initialize with thresholds/hold times
 *   2. Periodically feed switch-signal samples via
 *      camera_switcher_record_brightness()
 *   3. When a TO_DAY/TO_NIGHT decision is returned, reconfigure hardware and
 *      call camera_switcher_notify_active_camera()
 *
 * This module is pure logic (no vendor SDK or SHM dependencies) and is unit
 * tested by test_camera_switcher.c (make test).
 */

#ifndef CAMERA_SWITCHER_H
#define CAMERA_SWITCHER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { CAMERA_MODE_DAY = 0, CAMERA_MODE_NIGHT = 1 } CameraMode;

typedef enum { SWITCH_MODE_AUTO = 0, SWITCH_MODE_MANUAL = 1 } SwitchMode;

typedef enum {
    CAMERA_SWITCH_DECISION_NONE = 0,
    CAMERA_SWITCH_DECISION_TO_DAY = 1,
    CAMERA_SWITCH_DECISION_TO_NIGHT = 2
} CameraSwitchDecision;

typedef struct {
    double day_to_night_threshold;    // brightness threshold (mean 0-255) to go night
    double night_to_day_threshold;    // brightness threshold (mean 0-255) to go day
    double day_to_night_hold_seconds; // required duration below threshold to switch
    double night_to_day_hold_seconds; // required duration above threshold to switch
    unsigned int warmup_frames;       // frames to drop after switching
} CameraSwitchConfig;

typedef struct {
    double latest_value;
    double avg;
    int samples;
    struct timespec timestamp;
} BrightnessStat;

typedef struct {
    CameraSwitchConfig cfg;
    SwitchMode mode;
    CameraMode active_camera;
    int manual_target;            // -1 when auto, otherwise 0/1
    BrightnessStat brightness[2]; // [0]=day, [1]=night
    double below_threshold_since; // seconds (CLOCK_MONOTONIC), or -1
    double above_threshold_since; // seconds (CLOCK_MONOTONIC), or -1
    char last_switch_reason[64];
} CameraSwitchController;

/**
 * Initialize controller with defaults.
 */
void camera_switcher_init(CameraSwitchController* ctrl, const CameraSwitchConfig* cfg);

/**
 * Free internal buffers.
 */
void camera_switcher_destroy(CameraSwitchController* ctrl);

/**
 * Force manual mode and target camera (debug).
 */
void camera_switcher_force_manual(CameraSwitchController* ctrl, CameraMode camera);

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
                                                       CameraMode camera, double brightness);

/**
 * Notify controller that hardware has switched to a camera.
 * Resets warmup/drop counters.
 */
void camera_switcher_notify_active_camera(CameraSwitchController* ctrl, CameraMode camera,
                                          const char* reason);

/**
 * Snapshot current status (lightweight helper).
 */
void camera_switcher_get_status(const CameraSwitchController* ctrl, SwitchMode* mode,
                                CameraMode* active, BrightnessStat out_stats[2], char* reason_buf,
                                size_t reason_buf_len);

#ifdef __cplusplus
}
#endif

#endif // CAMERA_SWITCHER_H
