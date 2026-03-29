/**
 * camera_switcher.c - Brightness-based camera switch controller (C)
 */

#include "camera_switcher.h"
#include "logger.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void reset_stats(BrightnessStat* stat) {
    memset(stat, 0, sizeof(BrightnessStat));
    stat->latest_value = 0.0;
    stat->avg = 0.0;
    stat->samples = 0;
    stat->timestamp.tv_sec = 0;
    stat->timestamp.tv_nsec = 0;
}

void camera_switcher_init(CameraSwitchController* ctrl, const CameraSwitchConfig* cfg) {
    if (!ctrl) {
        return;
    }
    memset(ctrl, 0, sizeof(*ctrl));
    ctrl->cfg = *cfg;
    ctrl->mode = SWITCH_MODE_AUTO;
    ctrl->active_camera = CAMERA_MODE_DAY;
    ctrl->manual_target = -1;
    reset_stats(&ctrl->brightness[0]);
    reset_stats(&ctrl->brightness[1]);
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason), "init");
}

void camera_switcher_destroy(CameraSwitchController* ctrl) {
    if (!ctrl) {
        return;
    }
}

void camera_switcher_force_manual(CameraSwitchController* ctrl, CameraMode camera) {
    if (!ctrl) {
        return;
    }
    ctrl->mode = SWITCH_MODE_MANUAL;
    ctrl->manual_target = (camera == CAMERA_MODE_DAY) ? 0 : 1;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason), "manual-%s",
             camera == CAMERA_MODE_DAY ? "day" : "night");
}

void camera_switcher_resume_auto(CameraSwitchController* ctrl) {
    if (!ctrl) {
        return;
    }
    ctrl->mode = SWITCH_MODE_AUTO;
    ctrl->manual_target = -1;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason), "resume-auto");
}

static void update_brightness_stat(BrightnessStat* stat, double value) {
    const double ts = now_seconds();
    struct timespec tval;
    tval.tv_sec = (time_t)ts;
    tval.tv_nsec = (long)((ts - tval.tv_sec) * 1e9);
    stat->latest_value = value;
    stat->samples += 1;
    if (stat->samples == 1) {
        stat->avg = value;
    } else {
        stat->avg = ((stat->avg * (stat->samples - 1)) + value) / stat->samples;
    }
    stat->timestamp = tval;
}

CameraSwitchDecision camera_switcher_record_brightness(CameraSwitchController* ctrl,
                                                       CameraMode camera, double brightness) {
    if (!ctrl) {
        return CAMERA_SWITCH_DECISION_NONE;
    }

    update_brightness_stat(&ctrl->brightness[camera], brightness);

    if (ctrl->mode == SWITCH_MODE_MANUAL) {
        return CAMERA_SWITCH_DECISION_NONE;
    }

    const double now = now_seconds();
    CameraSwitchDecision decision = CAMERA_SWITCH_DECISION_NONE;

    if (ctrl->active_camera == CAMERA_MODE_DAY) {
        // Active camera is DAY: check if we should switch to NIGHT
        // Only consider brightness from the DAY camera itself
        if (camera != CAMERA_MODE_DAY) {
            return CAMERA_SWITCH_DECISION_NONE; // Ignore probe from night camera
        }
        LOG_DEBUG("Switcher", "active=DAY, camera=%d, brightness=%.1f, threshold=%.1f", (int)camera,
                  brightness, ctrl->cfg.day_to_night_threshold);
        if (brightness < ctrl->cfg.day_to_night_threshold) {
            if (ctrl->below_threshold_since < 0) {
                ctrl->below_threshold_since = now;
                LOG_DEBUG("Switcher", "Started timer for DAY->NIGHT");
            }
            double elapsed = now - ctrl->below_threshold_since;
            if (elapsed >= ctrl->cfg.day_to_night_hold_seconds) {
                decision = CAMERA_SWITCH_DECISION_TO_NIGHT;
                LOG_INFO("Switcher", "Switch to NIGHT (elapsed=%.1fs)", elapsed);
            }
        } else {
            ctrl->below_threshold_since = -1.0;
        }
    } else { // active is night
        // Active camera is NIGHT: check if we should switch to DAY
        // Only consider brightness from the DAY camera (probe)
        if (camera != CAMERA_MODE_DAY) {
            return CAMERA_SWITCH_DECISION_NONE; // Ignore night camera brightness
        }
        LOG_DEBUG("Switcher",
                  "active=NIGHT, probing DAY camera=%d, brightness=%.1f, threshold=%.1f",
                  (int)camera, brightness, ctrl->cfg.night_to_day_threshold);
        if (brightness > ctrl->cfg.night_to_day_threshold) {
            if (ctrl->above_threshold_since < 0) {
                ctrl->above_threshold_since = now;
                LOG_DEBUG("Switcher", "Started timer for NIGHT->DAY");
            }
            double elapsed = now - ctrl->above_threshold_since;
            if (elapsed >= ctrl->cfg.night_to_day_hold_seconds) {
                decision = CAMERA_SWITCH_DECISION_TO_DAY;
                LOG_INFO("Switcher", "Switch to DAY (elapsed=%.1fs)", elapsed);
            }
        } else {
            ctrl->above_threshold_since = -1.0;
        }
    }

    return decision;
}

void camera_switcher_notify_active_camera(CameraSwitchController* ctrl, CameraMode camera,
                                          const char* reason) {
    if (!ctrl) {
        return;
    }
    ctrl->active_camera = camera;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason), "%s",
             reason ? reason : "switch");
}

void camera_switcher_get_status(const CameraSwitchController* ctrl, SwitchMode* mode,
                                CameraMode* active, BrightnessStat out_stats[2], char* reason_buf,
                                size_t reason_buf_len) {
    if (!ctrl) {
        return;
    }
    if (mode) {
        *mode = ctrl->mode;
    }
    if (active) {
        *active = ctrl->active_camera;
    }
    if (out_stats) {
        out_stats[0] = ctrl->brightness[0];
        out_stats[1] = ctrl->brightness[1];
    }
    if (reason_buf && reason_buf_len > 0) {
        snprintf(reason_buf, reason_buf_len, "%s", ctrl->last_switch_reason);
    }
}
