/**
 * isp_brightness.h - ISP brightness statistics module
 *
 * Provides hardware-accelerated brightness measurement using ISP AE statistics.
 * Used for low-light detection and automatic ISP correction.
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

/**
 * Append one exposure probe record to /tmp/isp_exposure_probe.log
 *
 * Args:
 *   info: Exposure snapshot (may be invalid; logged with err flag)
 *   brightness_avg: Current AE-statistics brightness for correlation
 *   active_camera: 0=DAY, 1=NIGHT
 *   event: Record tag, e.g. "poll", "switch-to-night", "switch-to-day"
 */
void isp_exposure_probe_log(const isp_exposure_info_t* info, float brightness_avg,
                            int active_camera, const char* event);

/**
 * Low-light correction state (for hysteresis tracking)
 */
typedef struct {
    bool correction_active;       // True if low-light correction is currently applied
    BrightnessZone current_zone;  // Last applied zone
    double below_threshold_since; // Timestamp when brightness dropped below threshold (-1 if not)
    double above_threshold_since; // Timestamp when brightness rose above threshold (-1 if not)
} isp_lowlight_state_t;

/**
 * Initialize low-light correction state
 */
void isp_lowlight_state_init(isp_lowlight_state_t* state);

/**
 * Apply low-light correction profile based on brightness zone
 *
 * Sets ISP color processing (brightness, contrast, saturation) and gamma
 * correction parameters for the given zone.
 *
 * Args:
 *   isp_handle: ISP vnode handle
 *   zone: Target brightness zone
 *
 * Returns:
 *   0 on success, -1 on error
 */
int isp_apply_lowlight_profile(hbn_vnode_handle_t isp_handle, BrightnessZone zone);

/**
 * Update low-light correction with hysteresis
 *
 * Checks if correction should be enabled/disabled based on current brightness
 * and hysteresis thresholds. Applies profile if state changes.
 *
 * Args:
 *   isp_handle: ISP vnode handle
 *   state: Low-light state to track hysteresis
 *   brightness_result: Current brightness measurement
 *
 * Returns:
 *   true if correction is active after update, false otherwise
 */
bool isp_update_lowlight_correction(hbn_vnode_handle_t isp_handle, isp_lowlight_state_t* state,
                                    const isp_brightness_result_t* brightness_result);

#endif // ISP_BRIGHTNESS_H
