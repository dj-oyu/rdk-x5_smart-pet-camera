/**
 * switch_signal.h - Day/night switch signal source
 *
 * Single point of truth for "how bright is the scene" as consumed by the
 * camera switcher. The switcher thread reads one sample per poll and feeds
 * sample.value into the camera_switcher hysteresis state machine.
 *
 * Swapping the illuminance calculation (e.g. from AE-statistics average to
 * gain-normalized scene luminance) only requires changing
 * switch_signal_read() and the thresholds passed to camera_switcher_init();
 * no other code needs to know the signal's definition.
 *
 * Current signal: AE-statistics brightness average (0-255). Known weakness:
 * AE keeps this near its target (~65 in daylight), so it sits next to the
 * 50/60 hysteresis band. See /tmp/isp_exposure_probe.log analysis.
 */

#ifndef SWITCH_SIGNAL_H
#define SWITCH_SIGNAL_H

#include "isp_brightness.h"

#include <stdbool.h>

/**
 * One switch-signal sample: the value fed to the hysteresis state machine
 * plus the raw ISP readings it was derived from (kept for probe logging
 * and offline threshold analysis).
 */
typedef struct {
    bool valid;   // True if the signal could be computed this poll
    double value; // Signal consumed by camera_switcher (currently 0-255)
    isp_brightness_result_t brightness; // Raw AE-statistics reading
    isp_exposure_info_t exposure;       // Raw exposure snapshot (may be invalid)
} switch_signal_sample_t;

/**
 * Read ISP state and compute the day/night switch signal.
 *
 * Reads AE statistics and exposure attributes from the DAY camera ISP
 * (read-only, no settings modified). Designed for the switcher thread's
 * poll cadence (250ms-5s); not for per-frame use.
 *
 * Returns 0 and out->valid=true on success; -1 otherwise.
 */
int switch_signal_read(hbn_vnode_handle_t isp_handle, switch_signal_sample_t* out);

/**
 * Append one probe record to /tmp/isp_exposure_probe.log
 *
 * Verification data for the switch-signal redesign: correlates the signal
 * value with raw exposure state. Line-buffered append; safe to call from
 * the switcher thread only (not thread-safe).
 *
 * Args:
 *   sample: Sample from switch_signal_read (invalid samples log err=1)
 *   active_camera: 0=DAY, 1=NIGHT
 *   event: Record tag, e.g. "poll", "switch-to-night", "switch-to-day"
 */
void switch_signal_probe_log(const switch_signal_sample_t* sample, int active_camera,
                             const char* event);

#endif // SWITCH_SIGNAL_H
