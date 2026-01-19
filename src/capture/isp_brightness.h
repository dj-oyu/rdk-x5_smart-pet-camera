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
#include "shared_memory.h"  // For BrightnessZone enum

// Forward declaration for ISP handle type
typedef int64_t hbn_vnode_handle_t;

/**
 * Brightness measurement result from ISP
 */
typedef struct {
    float brightness_avg;       // Average brightness (0-255) from AE statistics
    uint32_t brightness_lux;    // Environment illuminance from ISP cur_lux
    BrightnessZone zone;        // Classified brightness zone
    uint64_t frame_id;          // Frame ID from ISP statistics
    bool valid;                 // True if measurement succeeded
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
int isp_get_brightness(hbn_vnode_handle_t isp_handle, isp_brightness_result_t *result);

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
 * Fill Frame structure with brightness data
 *
 * Convenience function to populate Frame brightness fields from ISP result.
 *
 * Args:
 *   frame: Frame structure to update
 *   result: ISP brightness measurement result
 */
void isp_fill_frame_brightness(Frame *frame, const isp_brightness_result_t *result);

#endif // ISP_BRIGHTNESS_H
