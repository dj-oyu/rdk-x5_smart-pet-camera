/**
 * isp_brightness.c - ISP brightness statistics implementation
 *
 * Uses D-Robotics ISP API to get hardware-calculated brightness statistics
 * and applies low-light correction profiles.
 */

#include "isp_brightness.h"
#include "isp_lowlight_profile.h"
#include "logger.h"

#include <hbn_api.h>
#include <hbn_isp_api.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>

// ============================================================================
// ISP Lowlight dedicated file logging
// ============================================================================

#define ISP_LOWLIGHT_LOG_PATH "/tmp/isp_lowlight.log"

static FILE *g_lowlight_log_file = NULL;

static void lowlight_log_init(void) {
    if (g_lowlight_log_file == NULL) {
        g_lowlight_log_file = fopen(ISP_LOWLIGHT_LOG_PATH, "a");
        if (g_lowlight_log_file) {
            setvbuf(g_lowlight_log_file, NULL, _IOLBF, 0);  // Line buffered
        }
    }
}

static void lowlight_log(const char *level, const char *fmt, ...) {
    lowlight_log_init();

    // Get timestamp
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);

    // Format: YYYY/MM/DD HH:MM:SS.mmm [LEVEL] message
    char timestamp[64];
    snprintf(timestamp, sizeof(timestamp), "%04d/%02d/%02d %02d:%02d:%02d.%03ld",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec, ts.tv_nsec / 1000000);

    va_list args;
    va_start(args, fmt);

    // Write to file
    if (g_lowlight_log_file) {
        fprintf(g_lowlight_log_file, "%s [%s] ", timestamp, level);
        vfprintf(g_lowlight_log_file, fmt, args);
        fprintf(g_lowlight_log_file, "\n");
    }

    va_end(args);
}

#define LOWLIGHT_LOG_DEBUG(fmt, ...) lowlight_log("DEBUG", fmt, ##__VA_ARGS__)
#define LOWLIGHT_LOG_INFO(fmt, ...)  lowlight_log("INFO", fmt, ##__VA_ARGS__)
#define LOWLIGHT_LOG_WARN(fmt, ...)  lowlight_log("WARN", fmt, ##__VA_ARGS__)
#define LOWLIGHT_LOG_ERROR(fmt, ...) lowlight_log("ERROR", fmt, ##__VA_ARGS__)

// ISP AE statistics grid: 32x32 = 1024 zones, 4 channels each
#define AE_GRID_SIZE 32
#define AE_GRID_ITEMS (AE_GRID_SIZE * AE_GRID_SIZE)
#define AE_CHANNELS 4

// Brightness zone thresholds
#define THRESHOLD_DARK 50
#define THRESHOLD_DIM 70
#define THRESHOLD_BRIGHT 180
#define THRESHOLD_LUX_DARK 100

BrightnessZone isp_classify_brightness_zone(float brightness_avg, uint32_t cur_lux) {
    // Use both brightness_avg and cur_lux for classification
    // cur_lux provides environmental context even when image is artificially bright

    if (brightness_avg < THRESHOLD_DARK || cur_lux < THRESHOLD_LUX_DARK) {
        return BRIGHTNESS_ZONE_DARK;
    } else if (brightness_avg < THRESHOLD_DIM) {
        return BRIGHTNESS_ZONE_DIM;
    } else if (brightness_avg < THRESHOLD_BRIGHT) {
        return BRIGHTNESS_ZONE_NORMAL;
    } else {
        return BRIGHTNESS_ZONE_BRIGHT;
    }
}

int isp_get_brightness(hbn_vnode_handle_t isp_handle, isp_brightness_result_t *result) {
    if (!result) {
        return -1;
    }

    memset(result, 0, sizeof(*result));
    result->valid = false;

    if (isp_handle <= 0) {
        LOG_ERROR("ISP_Brightness", "Invalid ISP handle");
        return -1;
    }

    int ret;

    // 1. Get AE statistics (32x32 grid)
    hbn_isp_ae_statistics_t ae_stats = {0};
    ret = hbn_isp_get_ae_statistics(isp_handle, &ae_stats);
    if (ret != 0) {
        LOG_ERROR("ISP_Brightness", "Failed to get AE statistics: %d", ret);
        return -1;
    }

    // Calculate average brightness from AE statistics
    // The expStat array contains values for each grid zone
    // We use channel 0 (typically Y/luminance or R) for brightness estimation
    uint64_t sum = 0;
    int valid_zones = 0;
    uint32_t min_val = UINT32_MAX, max_val = 0;

    for (int i = 0; i < AE_GRID_ITEMS; i++) {
        // Each zone has AE_CHANNELS values, use first channel (index * 4)
        uint32_t zone_value = ae_stats.expStat[i * AE_CHANNELS];
        sum += zone_value;
        valid_zones++;
        if (zone_value < min_val) min_val = zone_value;
        if (zone_value > max_val) max_val = zone_value;
    }

    uint64_t raw_avg = 0;
    if (valid_zones > 0) {
        raw_avg = sum / valid_zones;

        // Debug: log raw values periodically
        static int debug_counter = 0;
        if (++debug_counter >= 30) {
            LOWLIGHT_LOG_DEBUG("AE raw: avg=%lu min=%u max=%u zones=%d",
                              (unsigned long)raw_avg, min_val, max_val, valid_zones);
            debug_counter = 0;
        }

        // Normalize to 0-255 range
        // The raw values may need scaling depending on ISP configuration
        // Assuming 10-bit or 12-bit values, scale down to 8-bit
        // Scale from potential 12-bit (0-4095) to 8-bit (0-255)
        result->brightness_avg = (float)(raw_avg >> 4);
        if (result->brightness_avg > 255.0f) {
            result->brightness_avg = 255.0f;
        }
    }

    result->frame_id = ae_stats.frame_id;

    // 2. Get cur_lux from exposure attributes
    hbn_isp_exposure_attr_t exp_attr = {0};
    ret = hbn_isp_get_exposure_attr(isp_handle, &exp_attr);
    if (ret == 0) {
        result->brightness_lux = exp_attr.manual_attr.cur_lux;
    } else {
        LOG_WARN("ISP_Brightness", "Failed to get exposure attr: %d (using lux=0)", ret);
        result->brightness_lux = 0;
    }

    // 3. Classify brightness zone
    result->zone = isp_classify_brightness_zone(result->brightness_avg, result->brightness_lux);
    result->valid = true;

    return 0;
}

void isp_fill_frame_brightness(Frame *frame, const isp_brightness_result_t *result) {
    if (!frame || !result) {
        return;
    }

    if (result->valid) {
        frame->brightness_avg = result->brightness_avg;
        frame->brightness_lux = result->brightness_lux;
        frame->brightness_zone = (uint8_t)result->zone;
        // correction_applied is set separately when ISP correction is actually applied
    } else {
        // Mark as invalid/unknown
        frame->brightness_avg = 0.0f;
        frame->brightness_lux = 0;
        frame->brightness_zone = BRIGHTNESS_ZONE_NORMAL;  // Default to normal
    }
}

// ============================================================================
// Low-light correction implementation
// ============================================================================

static double get_time_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

void isp_lowlight_state_init(isp_lowlight_state_t *state) {
    if (!state) return;
    state->correction_active = false;
    state->current_zone = BRIGHTNESS_ZONE_NORMAL;
    state->below_threshold_since = -1.0;
    state->above_threshold_since = -1.0;
    LOWLIGHT_LOG_INFO("Low-light state initialized");
}

int isp_apply_lowlight_profile(hbn_vnode_handle_t isp_handle, BrightnessZone zone) {
    if (isp_handle <= 0) {
        LOG_ERROR("ISP_Lowlight", "Invalid ISP handle");
        return -1;
    }

    isp_lowlight_profile_t profile = isp_get_profile_for_zone(zone);
    int ret;

    // 1. Apply color processing (brightness, contrast, saturation)
    hbn_isp_color_process_attr_t cproc_attr = {0};
    ret = hbn_isp_get_color_process_attr(isp_handle, &cproc_attr);
    if (ret != 0) {
        LOG_WARN("ISP_Lowlight", "Failed to get color process attr: %d", ret);
        // Continue anyway - we'll set the values
    }

    cproc_attr.mode = HBN_ISP_MODE_MANUAL;
    cproc_attr.manual_attr.bright = profile.brightness;
    cproc_attr.manual_attr.contrast = profile.contrast;
    cproc_attr.manual_attr.saturation = profile.saturation;
    // Keep hue unchanged (0.0)

    ret = hbn_isp_set_color_process_attr(isp_handle, &cproc_attr);
    if (ret != 0) {
        LOG_ERROR("ISP_Lowlight", "Failed to set color process attr: %d", ret);
        return -1;
    }

    // 2. Apply gamma correction
    hbn_isp_gc_attr_t gc_attr = {0};
    ret = hbn_isp_get_gc_attr(isp_handle, &gc_attr);
    if (ret != 0) {
        LOG_WARN("ISP_Lowlight", "Failed to get gamma attr: %d", ret);
    }

    gc_attr.mode = HBN_ISP_MODE_MANUAL;
    gc_attr.manual_attr.standard = true;  // Use standard gamma formula
    gc_attr.manual_attr.standard_val = profile.gamma;

    ret = hbn_isp_set_gc_attr(isp_handle, &gc_attr);
    if (ret != 0) {
        LOG_ERROR("ISP_Lowlight", "Failed to set gamma attr: %d", ret);
        return -1;
    }

    LOG_INFO("ISP_Lowlight", "Applied profile for zone %d: bright=%.1f, contrast=%.2f, sat=%.2f, gamma=%.2f",
             zone, profile.brightness, profile.contrast, profile.saturation, profile.gamma);
    LOWLIGHT_LOG_INFO("Applied profile for zone %d: bright=%.1f, contrast=%.2f, sat=%.2f, gamma=%.2f",
             zone, profile.brightness, profile.contrast, profile.saturation, profile.gamma);

    return 0;
}

bool isp_update_lowlight_correction(hbn_vnode_handle_t isp_handle,
                                    isp_lowlight_state_t *state,
                                    const isp_brightness_result_t *brightness_result) {
    if (!state || !brightness_result || !brightness_result->valid) {
        return state ? state->correction_active : false;
    }

    isp_lowlight_hysteresis_t hyst = DEFAULT_HYSTERESIS;
    double now = get_time_seconds();
    float brightness = brightness_result->brightness_avg;
    BrightnessZone zone = brightness_result->zone;

    // Log brightness periodically for debugging (every ~1 second based on frame rate)
    static int log_counter = 0;
    if (++log_counter >= 30) {
        LOWLIGHT_LOG_DEBUG("brightness=%.1f lux=%u zone=%d correction=%d threshold_on=%.1f threshold_off=%.1f",
                          brightness, brightness_result->brightness_lux, zone,
                          state->correction_active, hyst.correction_on_threshold, hyst.correction_off_threshold);
        log_counter = 0;
    }

    if (!state->correction_active) {
        // Currently OFF - check if we should turn ON
        if (brightness < hyst.correction_on_threshold) {
            if (state->below_threshold_since < 0) {
                state->below_threshold_since = now;
                LOG_DEBUG("ISP_Lowlight", "Brightness %.1f below threshold, starting hold timer", brightness);
                LOWLIGHT_LOG_INFO("Brightness %.1f below threshold %.1f, starting hold timer",
                                  brightness, hyst.correction_on_threshold);
            }
            double elapsed = now - state->below_threshold_since;
            if (elapsed >= hyst.hold_time_on_sec) {
                // Enable correction
                LOG_INFO("ISP_Lowlight", "Enabling low-light correction (brightness=%.1f, held for %.1fs)",
                         brightness, elapsed);
                LOWLIGHT_LOG_INFO(">>> ENABLING low-light correction (brightness=%.1f, zone=%d, held for %.1fs)",
                         brightness, zone, elapsed);
                if (isp_apply_lowlight_profile(isp_handle, zone) == 0) {
                    state->correction_active = true;
                    state->current_zone = zone;
                }
                state->below_threshold_since = -1.0;
            }
        } else {
            state->below_threshold_since = -1.0;  // Reset timer
        }
        state->above_threshold_since = -1.0;  // Clear other timer
    } else {
        // Currently ON - check if we should turn OFF
        if (brightness > hyst.correction_off_threshold) {
            if (state->above_threshold_since < 0) {
                state->above_threshold_since = now;
                LOG_DEBUG("ISP_Lowlight", "Brightness %.1f above threshold, starting hold timer", brightness);
                LOWLIGHT_LOG_INFO("Brightness %.1f above threshold %.1f, starting hold timer",
                                  brightness, hyst.correction_off_threshold);
            }
            double elapsed = now - state->above_threshold_since;
            if (elapsed >= hyst.hold_time_off_sec) {
                // Disable correction (apply NORMAL profile)
                LOG_INFO("ISP_Lowlight", "Disabling low-light correction (brightness=%.1f, held for %.1fs)",
                         brightness, elapsed);
                LOWLIGHT_LOG_INFO("<<< DISABLING low-light correction (brightness=%.1f, held for %.1fs)",
                         brightness, elapsed);
                if (isp_apply_lowlight_profile(isp_handle, BRIGHTNESS_ZONE_NORMAL) == 0) {
                    state->correction_active = false;
                    state->current_zone = BRIGHTNESS_ZONE_NORMAL;
                }
                state->above_threshold_since = -1.0;
            }
        } else {
            state->above_threshold_since = -1.0;  // Reset timer

            // While correction is active, update zone if it changes significantly
            if (zone != state->current_zone && zone != BRIGHTNESS_ZONE_NORMAL && zone != BRIGHTNESS_ZONE_BRIGHT) {
                LOG_DEBUG("ISP_Lowlight", "Zone changed from %d to %d, updating profile", state->current_zone, zone);
                LOWLIGHT_LOG_INFO("Zone changed from %d to %d, updating profile", state->current_zone, zone);
                if (isp_apply_lowlight_profile(isp_handle, zone) == 0) {
                    state->current_zone = zone;
                }
            }
        }
        state->below_threshold_since = -1.0;  // Clear other timer
    }

    return state->correction_active;
}
