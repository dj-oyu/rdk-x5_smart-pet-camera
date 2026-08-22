/**
 * test_camera_switcher.c - Unit tests for the day/night switch state machine
 *
 * Pure-logic tests, no hardware required. Hold times are real-time based
 * (CLOCK_MONOTONIC inside camera_switcher.c), so tests use short holds and
 * usleep to cross them.
 *
 * Build & run: make test
 */

#include "camera_switcher.h"
#include "switch_signal.h" // switch_signal_compute is header-inline (no ISP link needed)

#include <stdio.h>
#include <unistd.h>

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                         \
    do {                                                                    \
        g_checks++;                                                         \
        if (!(cond)) {                                                      \
            g_failures++;                                                   \
            fprintf(stderr, "FAIL %s:%d: %s\n", __func__, __LINE__, #cond); \
        }                                                                   \
    } while (0)

// Short holds so tests run fast: 50ms day->night, 80ms night->day
static CameraSwitchConfig test_config(void) {
    CameraSwitchConfig cfg = {
        .day_to_night_threshold = 50.0,
        .night_to_day_threshold = 60.0,
        .day_to_night_hold_seconds = 0.05,
        .night_to_day_hold_seconds = 0.08,
        .warmup_frames = 0,
    };
    return cfg;
}

static void test_init_defaults(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    SwitchMode mode;
    CameraMode active;
    char reason[64];
    camera_switcher_get_status(&ctrl, &mode, &active, NULL, reason, sizeof(reason));
    CHECK(mode == SWITCH_MODE_AUTO);
    CHECK(active == CAMERA_MODE_DAY);
}

static void test_day_stays_day_when_bright(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    for (int i = 0; i < 5; i++) {
        CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 65.0) ==
              CAMERA_SWITCH_DECISION_NONE);
        usleep(20 * 1000);
    }
}

static void test_day_to_night_requires_hold(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    // First sample below threshold starts the timer, no decision yet
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    // Still inside hold window
    usleep(10 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    // Past the 50ms hold
    usleep(60 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_TO_NIGHT);
}

static void test_day_recovery_resets_hold_timer(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(30 * 1000);
    // Brightness recovers: timer must reset
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 70.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(30 * 1000);
    // Below again: 30ms+30ms elapsed in total but timer restarted, so no switch
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(60 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_TO_NIGHT);
}

static void test_night_to_day_requires_hold(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);
    camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_NIGHT, "test");

    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 70.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(90 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 70.0) ==
          CAMERA_SWITCH_DECISION_TO_DAY);
}

static void test_hysteresis_band_is_stable(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    // In-band value (between 50 and 60) must never switch, in either state
    for (int i = 0; i < 4; i++) {
        CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 55.0) ==
              CAMERA_SWITCH_DECISION_NONE);
        usleep(30 * 1000);
    }
    camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_NIGHT, "test");
    for (int i = 0; i < 4; i++) {
        CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 55.0) ==
              CAMERA_SWITCH_DECISION_NONE);
        usleep(30 * 1000);
    }
}

static void test_night_camera_samples_are_ignored(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    // Active DAY: night-camera brightness must not trigger anything
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_NIGHT, 10.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(60 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_NIGHT, 10.0) ==
          CAMERA_SWITCH_DECISION_NONE);

    // Active NIGHT: same
    camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_NIGHT, "test");
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_NIGHT, 200.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(90 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_NIGHT, 200.0) ==
          CAMERA_SWITCH_DECISION_NONE);
}

static void test_manual_mode_blocks_decisions(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);
    camera_switcher_force_manual(&ctrl, CAMERA_MODE_DAY);

    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 10.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(60 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 10.0) ==
          CAMERA_SWITCH_DECISION_NONE);

    // Resume auto: decisions work again (fresh hold)
    camera_switcher_resume_auto(&ctrl);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 10.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(60 * 1000);
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 10.0) ==
          CAMERA_SWITCH_DECISION_TO_NIGHT);
}

static void test_notify_resets_timers(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    // Build up a below-threshold timer, then notify a switch: timer must clear
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);
    usleep(60 * 1000);
    camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_DAY, "test-reset");
    // Timer was reset, so the next below-threshold sample starts a new hold
    CHECK(camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 40.0) ==
          CAMERA_SWITCH_DECISION_NONE);

    char reason[64];
    camera_switcher_get_status(&ctrl, NULL, NULL, NULL, reason, sizeof(reason));
    CHECK(reason[0] != '\0');
}

static void test_status_reports_brightness_stats(void) {
    CameraSwitchController ctrl;
    CameraSwitchConfig cfg = test_config();
    camera_switcher_init(&ctrl, &cfg);

    camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 100.0);
    camera_switcher_record_brightness(&ctrl, CAMERA_MODE_DAY, 200.0);

    BrightnessStat stats[2];
    camera_switcher_get_status(&ctrl, NULL, NULL, stats, NULL, 0);
    CHECK(stats[CAMERA_MODE_DAY].samples == 2);
    CHECK(stats[CAMERA_MODE_DAY].latest_value == 200.0);
    CHECK(stats[CAMERA_MODE_DAY].avg == 150.0);
    CHECK(stats[CAMERA_MODE_NIGHT].samples == 0);
}

// Values below are real samples from /tmp/isp_exposure_probe.log (2026-06-10..13).
// Default thresholds: DAY->NIGHT at L<40, NIGHT->DAY at L>80.
static void test_signal_compute_scene_ordering(void) {
    isp_exposure_info_t e = {.valid = true, .dgain = 1.0f};

    // Midday: brightness 62 at low gain -> bright scene, far above both thresholds
    e.exp_time = 0.019989f;
    e.again = 5.657f;
    e.ispgain = 1.004f;
    double midday = switch_signal_compute(62.0, &e);
    CHECK(midday > 500.0 && midday < 600.0);

    // Morning daylight through curtains: brightness 37 at high gain.
    // Old signal (37 < 60) stayed stuck in NIGHT; L=128 correctly reads as day.
    e.again = 9.935f;
    e.ispgain = 1.453f;
    double morning = switch_signal_compute(37.0, &e);
    CHECK(morning > 80.0 && morning < 200.0);

    // True darkness: brightness ~1 with gain maxed out
    e.again = 15.99f;
    e.ispgain = 4.0f;
    double dark = switch_signal_compute(1.0, &e);
    CHECK(dark >= 0.0 && dark < 40.0);

    CHECK(midday > morning && morning > dark);
}

static void test_signal_compute_dip_resistance(void) {
    // Pet near lens at midday: brightness drops 62->43 but the AE gain state
    // still reflects the bright scene (gain rises only slightly with damping).
    // L must stay far above the 40 NIGHT threshold.
    isp_exposure_info_t e = {
        .valid = true, .exp_time = 0.019989f, .again = 7.83f, .dgain = 1.0f, .ispgain = 1.004f};
    double dip = switch_signal_compute(43.0, &e);
    CHECK(dip > 200.0);
}

static void test_signal_compute_invalid_inputs(void) {
    isp_exposure_info_t e = {.valid = false};
    CHECK(switch_signal_compute(62.0, &e) < 0.0);
    CHECK(switch_signal_compute(62.0, NULL) < 0.0);

    // Zero gain product (ISP not ready) must not divide by zero
    isp_exposure_info_t zero = {.valid = true, .exp_time = 0.0f, .again = 0.0f};
    CHECK(switch_signal_compute(62.0, &zero) < 0.0);
}

// ============================================================================
// Probe log write policy (switch_signal_probe_should_log)
// ============================================================================

static void test_probe_events_always_log(void) {
    switch_probe_throttle_t st = {0};
    switch_signal_probe_mark(&st, 100.0, 1000);

    // A switch event must never be throttled, however recent the last record
    CHECK(switch_signal_probe_should_log(&st, 100.0, false, "switch-to-night", 1001));
    CHECK(switch_signal_probe_should_log(&st, 100.0, true, "switch-to-day", 1001));
}

static void test_probe_first_sample_logs(void) {
    switch_probe_throttle_t st = {0};
    CHECK(switch_signal_probe_should_log(&st, 100.0, false, NULL, 0));
    CHECK(switch_signal_probe_should_log(NULL, 100.0, false, NULL, 0));
}

static void test_probe_flat_signal_uses_heartbeat(void) {
    switch_probe_throttle_t st = {0};
    switch_signal_probe_mark(&st, 100.0, 0);

    // A flat DAY signal is silent until the heartbeat elapses
    CHECK(!switch_signal_probe_should_log(&st, 100.0, false, NULL, 1000));
    CHECK(!switch_signal_probe_should_log(&st, 100.0, false, NULL,
                                          SWITCH_PROBE_HEARTBEAT_DAY_MS - 1));
    CHECK(switch_signal_probe_should_log(&st, 100.0, false, NULL, SWITCH_PROBE_HEARTBEAT_DAY_MS));

    // NIGHT is quieter still: the DAY heartbeat must not fire it
    CHECK(!switch_signal_probe_should_log(&st, 100.0, true, NULL, SWITCH_PROBE_HEARTBEAT_DAY_MS));
    CHECK(switch_signal_probe_should_log(&st, 100.0, true, NULL, SWITCH_PROBE_HEARTBEAT_NIGHT_MS));
}

static void test_probe_change_triggers_record(void) {
    switch_probe_throttle_t st = {0};
    switch_signal_probe_mark(&st, 100.0, 0);

    // Below the delta ratio: still throttled
    CHECK(!switch_signal_probe_should_log(&st, 110.0, false, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));

    // At or above the delta ratio, in both directions
    CHECK(switch_signal_probe_should_log(&st, 115.0, false, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));
    CHECK(switch_signal_probe_should_log(&st, 85.0, false, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));
}

static void test_probe_min_interval_caps_rate(void) {
    switch_probe_throttle_t st = {0};
    switch_signal_probe_mark(&st, 100.0, 0);

    // A large swing inside the minimum interval is held back: this is the
    // bound that keeps a rapidly oscillating signal from reproducing the
    // old every-poll write rate.
    CHECK(
        !switch_signal_probe_should_log(&st, 500.0, false, NULL, SWITCH_PROBE_MIN_INTERVAL_MS - 1));
    CHECK(switch_signal_probe_should_log(&st, 500.0, false, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));
}

static void test_probe_near_zero_signal_is_stable(void) {
    switch_probe_throttle_t st = {0};

    // True darkness (L < 15) must not divide by a tiny base and fire on
    // every poll; the base clamps at 1.0.
    switch_signal_probe_mark(&st, 0.0, 0);
    CHECK(!switch_signal_probe_should_log(&st, 0.1, true, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));
    CHECK(switch_signal_probe_should_log(&st, 1.0, true, NULL, SWITCH_PROBE_MIN_INTERVAL_MS));
}

int main(void) {
    test_init_defaults();
    test_day_stays_day_when_bright();
    test_day_to_night_requires_hold();
    test_day_recovery_resets_hold_timer();
    test_night_to_day_requires_hold();
    test_hysteresis_band_is_stable();
    test_night_camera_samples_are_ignored();
    test_manual_mode_blocks_decisions();
    test_notify_resets_timers();
    test_status_reports_brightness_stats();
    test_signal_compute_scene_ordering();
    test_signal_compute_dip_resistance();
    test_signal_compute_invalid_inputs();
    test_probe_events_always_log();
    test_probe_first_sample_logs();
    test_probe_flat_signal_uses_heartbeat();
    test_probe_change_triggers_record();
    test_probe_min_interval_caps_rate();
    test_probe_near_zero_signal_is_stable();

    printf("camera_switcher tests: %d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
