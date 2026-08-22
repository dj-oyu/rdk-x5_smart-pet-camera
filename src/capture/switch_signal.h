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
#include <stddef.h>
#include <stdint.h>

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
 * Append one probe record to the rotating probe log.
 *
 * Verification data for the switch-signal redesign: correlates the signal
 * value with raw exposure state. Writes to
 * $PET_CAMERA_LOG_DIR/isp_exposure_probe-YYYYMMDD.log with a
 * SWITCH_PROBE_RETENTION_DAYS retention window (see rotating_log.h).
 * Thread-safe.
 *
 * Args:
 *   sample: Sample from switch_signal_read (invalid samples log err=1)
 *   active_camera: 0=DAY, 1=NIGHT
 *   event: Record tag, e.g. "poll", "switch-to-night", "switch-to-day"
 */
void switch_signal_probe_log(const switch_signal_sample_t* sample, int active_camera,
                             const char* event);

// ============================================================================
// Probe log write policy
// ============================================================================

/**
 * How long probe logs are kept before rotation deletes them.
 */
#define SWITCH_PROBE_RETENTION_DAYS 14

/**
 * Heartbeat: log at least this often even when the signal is flat.
 * The old policy logged every poll (DAY ~1/s, NIGHT 1/5s), which produced
 * ~15 MB/day of almost entirely redundant records.
 */
#define SWITCH_PROBE_HEARTBEAT_DAY_MS   10000
#define SWITCH_PROBE_HEARTBEAT_NIGHT_MS 60000

/**
 * Change-triggered records: when the signal moves by at least
 * SWITCH_PROBE_DELTA_RATIO relative to the last recorded value, log it —
 * but never more often than SWITCH_PROBE_MIN_INTERVAL_MS. Dawn and dusk
 * transitions, the interval the redesign actually cares about, therefore
 * keep sub-heartbeat resolution while a flat midday signal costs 6 lines
 * per minute.
 */
#define SWITCH_PROBE_MIN_INTERVAL_MS 2000
#define SWITCH_PROBE_DELTA_RATIO     0.15

/**
 * Rate-limit state for switch_signal_probe_should_log(). Zero-initialize.
 */
typedef struct {
    bool has_last;       // False until the first record is written
    double last_value;   // Signal value of the last written record
    int64_t last_log_ms; // Monotonic timestamp of the last written record
} switch_probe_throttle_t;

/**
 * Decide whether this sample deserves a probe record (pure function, unit
 * tested in test_camera_switcher.c).
 *
 * Always true for switch events and for the first sample. Otherwise true
 * when the heartbeat interval has elapsed, or when the signal moved by
 * SWITCH_PROBE_DELTA_RATIO and at least SWITCH_PROBE_MIN_INTERVAL_MS has
 * passed since the last record.
 *
 * The caller must pass the same now_ms clock every time (monotonic ms) and
 * must call switch_signal_probe_mark() when it writes the record.
 */
static inline bool switch_signal_probe_should_log(const switch_probe_throttle_t* st, double value,
                                                  bool night_active, const char* event,
                                                  int64_t now_ms) {
    if (event != NULL) {
        return true;
    }
    if (!st || !st->has_last) {
        return true;
    }

    const int64_t elapsed = now_ms - st->last_log_ms;
    const int64_t heartbeat =
        night_active ? SWITCH_PROBE_HEARTBEAT_NIGHT_MS : SWITCH_PROBE_HEARTBEAT_DAY_MS;
    if (elapsed >= heartbeat) {
        return true;
    }
    if (elapsed < SWITCH_PROBE_MIN_INTERVAL_MS) {
        return false;
    }

    const double base = (st->last_value > 1.0) ? st->last_value : 1.0;
    const double delta =
        (value > st->last_value) ? (value - st->last_value) : (st->last_value - value);
    return (delta / base) >= SWITCH_PROBE_DELTA_RATIO;
}

/**
 * Record that a probe line was written, so the next decision can rate-limit
 * against it.
 */
static inline void switch_signal_probe_mark(switch_probe_throttle_t* st, double value,
                                            int64_t now_ms) {
    if (!st) {
        return;
    }
    st->has_last = true;
    st->last_value = value;
    st->last_log_ms = now_ms;
}

#endif // SWITCH_SIGNAL_H
