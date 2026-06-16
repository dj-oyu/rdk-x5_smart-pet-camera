/**
 * isp_brightness.c - ISP brightness statistics implementation
 *
 * Uses D-Robotics ISP API to read hardware-calculated brightness statistics
 * and exposure attributes. Read-only; no ISP settings are modified here.
 */

#include "isp_brightness.h"
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

static FILE* g_lowlight_log_file = NULL;

static void lowlight_log_init(void) {
    if (g_lowlight_log_file == NULL) {
        g_lowlight_log_file = fopen(ISP_LOWLIGHT_LOG_PATH, "a");
        if (g_lowlight_log_file) {
            setvbuf(g_lowlight_log_file, NULL, _IOLBF, 0); // Line buffered
        }
    }
}

static void lowlight_log(const char* level, const char* fmt, ...) {
    lowlight_log_init();

    // Get timestamp
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);

    // Format: YYYY/MM/DD HH:MM:SS.mmm [LEVEL] message
    char timestamp[64];
    snprintf(timestamp, sizeof(timestamp), "%04d/%02d/%02d %02d:%02d:%02d.%03ld", tm.tm_year + 1900,
             tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, ts.tv_nsec / 1000000);

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

// ISP AE statistics grid: 32x32 = 1024 zones, 4 channels each
#define AE_GRID_SIZE  32
#define AE_GRID_ITEMS (AE_GRID_SIZE * AE_GRID_SIZE)
#define AE_CHANNELS   4

// Fixed bit depth for AE statistics normalization
// Sensor: 10-bit RAW input, ISP internally expands to ~15-bit range
// Observed AE stat values: avg ~10000, max ~40000-48000 (approx 15.5-bit effective)
// Use fixed 7-bit shift to normalize to 0-255 range
#define AE_STAT_SHIFT_BITS 7

// Brightness zone thresholds
#define THRESHOLD_DARK     50
#define THRESHOLD_DIM      70
#define THRESHOLD_BRIGHT   180
#define THRESHOLD_LUX_DARK 100

BrightnessZone isp_classify_brightness_zone(float brightness_avg, uint32_t cur_lux) {
    // Classify based on brightness_avg only
    // cur_lux retrieval is skipped to reduce ISP API calls and avoid frame drops
    // When cur_lux is 0 (not retrieved), ignore it in classification
    (void)cur_lux; // Unused - kept for API compatibility

    if (brightness_avg < THRESHOLD_DARK) {
        return BRIGHTNESS_ZONE_DARK;
    } else if (brightness_avg < THRESHOLD_DIM) {
        return BRIGHTNESS_ZONE_DIM;
    } else if (brightness_avg < THRESHOLD_BRIGHT) {
        return BRIGHTNESS_ZONE_NORMAL;
    } else {
        return BRIGHTNESS_ZONE_BRIGHT;
    }
}

int isp_get_brightness(hbn_vnode_handle_t isp_handle, isp_brightness_result_t* result) {
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
        if (zone_value < min_val)
            min_val = zone_value;
        if (zone_value > max_val)
            max_val = zone_value;
    }

    uint64_t raw_avg = 0;
    if (valid_zones > 0) {
        raw_avg = sum / valid_zones;

        // Debug: log raw values periodically
        static int debug_counter = 0;
        if (++debug_counter >= 30) {
            LOWLIGHT_LOG_DEBUG("AE raw: avg=%lu min=%u max=%u zones=%d", (unsigned long)raw_avg,
                               min_val, max_val, valid_zones);
            debug_counter = 0;
        }

        // Normalize to 0-255 range using fixed bit depth
        // Based on known sensor configuration: 10-bit RAW input
        // ISP AE statistics use ~15-bit effective range (max observed ~48000)
        result->brightness_avg = (float)(raw_avg >> AE_STAT_SHIFT_BITS);
        if (result->brightness_avg > 255.0f) {
            result->brightness_avg = 255.0f;
        }
    }

    result->frame_id = ae_stats.frame_id;

    // Skip hbn_isp_get_exposure_attr() to reduce API calls and avoid frame drops
    // cur_lux is not critical - brightness_avg alone is sufficient for zone classification
    result->brightness_lux = 0;

    // 2. Classify brightness zone
    result->zone = isp_classify_brightness_zone(result->brightness_avg, result->brightness_lux);
    result->valid = true;

    return 0;
}

// ============================================================================
// Exposure attributes (read-only AE loop output)
// ============================================================================

int isp_get_exposure_info(hbn_vnode_handle_t isp_handle, isp_exposure_info_t* info) {
    if (!info) {
        return -1;
    }
    memset(info, 0, sizeof(*info));
    info->valid = false;

    if (isp_handle <= 0) {
        return -1;
    }

    hbn_isp_exposure_attr_t exp_attr = {0};
    int ret = hbn_isp_get_exposure_attr(isp_handle, &exp_attr);
    if (ret != 0) {
        return -1;
    }

    info->lock_state = exp_attr.lock_state;
    info->exp_time = exp_attr.manual_attr.exp_time;
    info->again = exp_attr.manual_attr.again;
    info->dgain = exp_attr.manual_attr.dgain;
    info->ispgain = exp_attr.manual_attr.ispgain;
    info->ae_exp = exp_attr.manual_attr.ae_exp;
    info->cur_lux = exp_attr.manual_attr.cur_lux;
    info->frame_id = exp_attr.manual_attr.frame_id;
    info->valid = true;
    return 0;
}
