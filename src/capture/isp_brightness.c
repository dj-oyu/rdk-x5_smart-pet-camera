/**
 * isp_brightness.c - ISP brightness statistics implementation
 *
 * Uses D-Robotics ISP API to get hardware-calculated brightness statistics.
 */

#include "isp_brightness.h"
#include "logger.h"

#include <hbn_api.h>
#include <hbn_isp_api.h>
#include <string.h>

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

    for (int i = 0; i < AE_GRID_ITEMS; i++) {
        // Each zone has AE_CHANNELS values, use first channel (index * 4)
        uint32_t zone_value = ae_stats.expStat[i * AE_CHANNELS];
        sum += zone_value;
        valid_zones++;
    }

    if (valid_zones > 0) {
        // Normalize to 0-255 range
        // The raw values may need scaling depending on ISP configuration
        // Assuming 10-bit or 12-bit values, scale down to 8-bit
        uint64_t avg = sum / valid_zones;
        // Scale from potential 12-bit (0-4095) to 8-bit (0-255)
        result->brightness_avg = (float)(avg >> 4);
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
