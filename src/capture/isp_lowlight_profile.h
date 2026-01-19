/**
 * isp_lowlight_profile.h - Low-light ISP correction profiles
 *
 * Defines ISP parameter profiles for different brightness zones.
 * Used by isp_brightness.c to apply automatic low-light correction.
 *
 * NOTE: Color Processing (brightness/contrast/saturation) and Gamma APIs
 * return success but don't actually change values on this hardware.
 * Only Exposure settings (AE target, gain ranges) are effective.
 */

#ifndef ISP_LOWLIGHT_PROFILE_H
#define ISP_LOWLIGHT_PROFILE_H

#include "shared_memory.h"  // For BrightnessZone enum

/**
 * ISP correction profile for a brightness zone
 * Uses Noise Reduction settings which are effective on this hardware
 */
typedef struct {
    int denoise_3d;       // 3DNR strength [0-128], higher = more temporal NR
    float denoise_2d;     // 2DNR blend_static [0-1.0], higher = more spatial NR
} isp_lowlight_profile_t;

/**
 * Hysteresis configuration for correction transitions
 */
typedef struct {
    float correction_on_threshold;    // brightness_avg below this enables correction
    float correction_off_threshold;   // brightness_avg above this disables correction
    float hold_time_on_sec;           // Duration below threshold to enable correction
    float hold_time_off_sec;          // Duration above threshold to disable correction
} isp_lowlight_hysteresis_t;

/**
 * Default profiles for each brightness zone
 *
 * Zone thresholds (from shared_memory.h):
 *   DARK:   brightness_avg < 50
 *   DIM:    50 <= brightness_avg < 70
 *   NORMAL: 70 <= brightness_avg < 180
 *   BRIGHT: brightness_avg >= 180
 *
 * Default AE target from tuning file is ~38
 * Default ISP dgain max is ~255
 */

// DARK zone: Strong noise reduction for high-gain low-light
// Default 3DNR=113 from tuning, boost to 120 for aggressive NR
#define PROFILE_DARK { \
    .denoise_3d = 120, \
    .denoise_2d = 0.7f \
}

// DIM zone: Moderate noise reduction
#define PROFILE_DIM { \
    .denoise_3d = 115, \
    .denoise_2d = 0.5f \
}

// NORMAL zone: Default settings (restore tuning file values)
// Default 3DNR=113, 2DNR blend_static=5.0 (from tuning)
#define PROFILE_NORMAL { \
    .denoise_3d = 113, \
    .denoise_2d = 5.0f \
}

// BRIGHT zone: Same as normal
#define PROFILE_BRIGHT PROFILE_NORMAL

/**
 * Default hysteresis settings
 *
 * correction_on:  brightness < 50 for 1 second
 * correction_off: brightness > 70 for 2 seconds
 */
#define DEFAULT_HYSTERESIS { \
    .correction_on_threshold = 50.0f, \
    .correction_off_threshold = 70.0f, \
    .hold_time_on_sec = 1.0f, \
    .hold_time_off_sec = 2.0f \
}

/**
 * Get profile for a brightness zone
 */
static inline isp_lowlight_profile_t isp_get_profile_for_zone(BrightnessZone zone) {
    switch (zone) {
        case BRIGHTNESS_ZONE_DARK:
            return (isp_lowlight_profile_t)PROFILE_DARK;
        case BRIGHTNESS_ZONE_DIM:
            return (isp_lowlight_profile_t)PROFILE_DIM;
        case BRIGHTNESS_ZONE_NORMAL:
            return (isp_lowlight_profile_t)PROFILE_NORMAL;
        case BRIGHTNESS_ZONE_BRIGHT:
        default:
            return (isp_lowlight_profile_t)PROFILE_BRIGHT;
    }
}

#endif // ISP_LOWLIGHT_PROFILE_H
