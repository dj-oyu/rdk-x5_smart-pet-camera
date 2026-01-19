/**
 * isp_lowlight_profile.h - Low-light ISP correction profiles
 *
 * Defines ISP parameter profiles for different brightness zones.
 * Used by isp_brightness.c to apply automatic low-light correction.
 */

#ifndef ISP_LOWLIGHT_PROFILE_H
#define ISP_LOWLIGHT_PROFILE_H

#include "shared_memory.h"  // For BrightnessZone enum

/**
 * ISP correction profile for a brightness zone
 */
typedef struct {
    float brightness;    // Color process brightness offset (-128 to 127)
    float contrast;      // Color process contrast (0.0 to 4.0, 1.0 = no change)
    float saturation;    // Color process saturation (0.0 to 4.0, 1.0 = no change)
    float gamma;         // Gamma value (< 1.0 brightens, > 1.0 darkens, 2.2 = sRGB)
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
 */

// DARK zone: Aggressive brightening for very low light
// brightness=+40, contrast=1.2, saturation=0.9 (reduce noise color), gamma=0.7
#define PROFILE_DARK { \
    .brightness = 40.0f, \
    .contrast = 1.2f, \
    .saturation = 0.9f, \
    .gamma = 0.7f \
}

// DIM zone: Moderate brightening for dim conditions
// brightness=+20, contrast=1.1, saturation=1.0, gamma=0.85
#define PROFILE_DIM { \
    .brightness = 20.0f, \
    .contrast = 1.1f, \
    .saturation = 1.0f, \
    .gamma = 0.85f \
}

// NORMAL zone: No correction needed
// brightness=0, contrast=1.0, saturation=1.0, gamma=1.0 (passthrough)
#define PROFILE_NORMAL { \
    .brightness = 0.0f, \
    .contrast = 1.0f, \
    .saturation = 1.0f, \
    .gamma = 1.0f \
}

// BRIGHT zone: Same as normal (no correction)
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
