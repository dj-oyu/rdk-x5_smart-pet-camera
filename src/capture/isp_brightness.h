/**
 * isp_brightness.h - ISP brightness statistics module
 *
 * Read-only access to ISP hardware state: AE-statistics brightness and
 * exposure attributes. Switch-signal policy lives in switch_signal.h.
 */

#ifndef ISP_BRIGHTNESS_H
#define ISP_BRIGHTNESS_H

#include <stdint.h>
#include <stdbool.h>

typedef enum {
    BRIGHTNESS_ZONE_DARK = 0,
    BRIGHTNESS_ZONE_DIM = 1,
    BRIGHTNESS_ZONE_NORMAL = 2,
    BRIGHTNESS_ZONE_BRIGHT = 3,
} BrightnessZone;

// Forward declaration for ISP handle type
typedef int64_t hbn_vnode_handle_t;

/**
 * Brightness measurement result from ISP
 */
typedef struct {
    float brightness_avg;    // Average brightness (0-255) from AE statistics
    uint32_t brightness_lux; // Environment illuminance from ISP cur_lux
    BrightnessZone zone;     // Classified brightness zone
    uint64_t frame_id;       // Frame ID from ISP statistics
    bool valid;              // True if measurement succeeded
} isp_brightness_result_t;

/**
 * Get brightness statistics from ISP hardware
 *
 * Retrieves AE statistics (32x32 grid) and calculates average brightness.
 * Also retrieves cur_lux from exposure attributes.
 *
 * Args:
 *   isp_handle: ISP vnode handle from vio_context
 *   result: Output structure for brightness data
 *
 * Returns:
 *   0 on success, -1 on error
 */
int isp_get_brightness(hbn_vnode_handle_t isp_handle, isp_brightness_result_t* result);

/**
 * Classify brightness into zones
 *
 * Args:
 *   brightness_avg: Average brightness (0-255)
 *   cur_lux: Environment illuminance from ISP
 *
 * Returns:
 *   BrightnessZone enum value
 */
BrightnessZone isp_classify_brightness_zone(float brightness_avg, uint32_t cur_lux);

/**
 * Exposure state snapshot from ISP (AE loop output)
 *
 * Used by the exposure probe logging to evaluate whether exposure-derived
 * signals (cur_lux, gains, exp_time) are a viable day/night switch source.
 */
typedef struct {
    bool valid;          // True if hbn_isp_get_exposure_attr succeeded
    uint32_t lock_state; // AE convergence state (non-zero = converged)
    float exp_time;      // Exposure time in seconds
    float again;         // Analog gain
    float dgain;         // Digital gain
    float ispgain;       // ISP digital gain
    float ae_exp;        // AE exposure value
    uint32_t cur_lux;    // Environment illuminance reported by ISP
    uint32_t frame_id;   // Frame ID from exposure attributes
} isp_exposure_info_t;

/**
 * Get exposure attributes from ISP hardware
 *
 * Reads hbn_isp_get_exposure_attr (manual_attr snapshot + lock_state).
 * Read-only; does not modify exposure settings.
 *
 * Returns:
 *   0 on success, -1 on error (info->valid is set accordingly)
 */
int isp_get_exposure_info(hbn_vnode_handle_t isp_handle, isp_exposure_info_t* info);

#endif // ISP_BRIGHTNESS_H
