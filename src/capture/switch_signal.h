/**
 * switch_signal.h - Day/night switch signal source
 *
 * Single point of truth for "how bright is the scene" as consumed by the
 * camera switcher. The switcher thread reads one sample per poll and feeds
 * sample.value into the camera_switcher hysteresis state machine.
 *
 * Swapping the illuminance calculation only requires changing
 * switch_signal_compute() and the thresholds passed to camera_switcher_init();
 * no other code needs to know the signal's definition.
 *
 * Current signal (v2): gain-normalized scene luminance
 *   L = brightness_avg / (exp_time * again * dgain * ispgain)
 * Unlike the raw AE-statistics average (v1), L is proportional to actual
 * scene illumination: the AE loop compensates dark scenes with gain, and
 * dividing by the gain product undoes that compensation. Probe-log analysis
 * (2026-06-10..13, 80k samples): true darkness L < 15, morning daylight
 * through curtains L 90-260, midday L 450-820, evening room light L 380-480.
 * Short dark-object dips (pet near lens) only reach L~260 because the AE
 * gain state still reflects the bright scene.
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
    bool valid;                         // True if the signal could be computed this poll
    double value;                       // Gain-normalized luminance L consumed by camera_switcher
    isp_brightness_result_t brightness; // Raw AE-statistics reading
    isp_exposure_info_t exposure;       // Raw exposure snapshot (may be invalid)
} switch_signal_sample_t;

/**
 * Compute the switch signal from raw ISP readings (pure function, unit
 * tested in test_camera_switcher.c).
 *
 * Returns the gain-normalized luminance L, or -1.0 if the exposure snapshot
 * is unusable (invalid or zero gain product).
 */
static inline double switch_signal_compute(double brightness_avg, const isp_exposure_info_t* e) {
    if (!e || !e->valid) {
        return -1.0;
    }
    const double gain = (double)e->exp_time * e->again * e->dgain * e->ispgain;
    if (gain <= 0.0) {
        return -1.0;
    }
    return brightness_avg / gain;
}

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
