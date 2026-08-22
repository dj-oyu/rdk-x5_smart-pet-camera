/**
 * switch_signal.c - Day/night switch signal source
 */

#include "switch_signal.h"

#include "rotating_log.h"

#include <stdio.h>
#include <time.h>

#define EXPOSURE_PROBE_LOG_PREFIX "isp_exposure_probe"

static rotating_log_t g_probe_log = ROTATING_LOG_INITIALIZER;

int switch_signal_read(hbn_vnode_handle_t isp_handle, switch_signal_sample_t* out) {
    if (!out) {
        return -1;
    }
    out->valid = false;
    out->value = 0.0;

    isp_get_brightness(isp_handle, &out->brightness);
    isp_get_exposure_info(isp_handle, &out->exposure);

    if (!out->brightness.valid) {
        return -1;
    }

    // Signal v2: gain-normalized scene luminance (see switch_signal.h).
    // An unusable exposure snapshot invalidates the sample; the switcher
    // simply skips this poll (observed failure rate: 0 in 80k samples).
    out->value = switch_signal_compute((double)out->brightness.brightness_avg, &out->exposure);
    if (out->value < 0.0) {
        return -1;
    }
    out->valid = true;
    return 0;
}

void switch_signal_probe_log(const switch_signal_sample_t* sample, int active_camera,
                             const char* event) {
    if (!sample) {
        return;
    }
    rotating_log_configure(&g_probe_log, EXPOSURE_PROBE_LOG_PREFIX, SWITCH_PROBE_RETENTION_DAYS);

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);

    const char* active = (active_camera == 0) ? "DAY" : "NIGHT";
    const char* tag = event ? event : "poll";

    if (!sample->valid || !sample->exposure.valid) {
        rotating_log_printf(
            &g_probe_log,
            "%04d/%02d/%02d %02d:%02d:%02d.%03ld active=%s event=%s brightness=%.1f err=1\n",
            tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec,
            ts.tv_nsec / 1000000, active, tag, sample->brightness.brightness_avg);
        return;
    }

    const isp_exposure_info_t* e = &sample->exposure;
    rotating_log_printf(
        &g_probe_log,
        "%04d/%02d/%02d %02d:%02d:%02d.%03ld active=%s event=%s signal=%.1f brightness=%.1f "
        "cur_lux=%u exp_time=%.6f again=%.3f dgain=%.3f ispgain=%.3f ae_exp=%.1f lock=%u "
        "frame=%u\n",
        tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec,
        ts.tv_nsec / 1000000, active, tag, sample->value, sample->brightness.brightness_avg,
        e->cur_lux, e->exp_time, e->again, e->dgain, e->ispgain, e->ae_exp, e->lock_state,
        e->frame_id);
}
