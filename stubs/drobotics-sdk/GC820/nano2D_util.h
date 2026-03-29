/*
 * nano2D_util.h - IDE STUB ONLY (D-Robotics GC820 nano2D utility API)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef NANO2D_UTIL_H
#define NANO2D_UTIL_H

#include "nano2D.h"

/* TSC (Tile Status Cache) modes */
typedef enum {
    N2D_TSC_DISABLE = 0,
    N2D_TSC_ENABLE  = 1,
} n2d_tsc_t;

/* Allocate a nano2D buffer with the given dimensions */
n2d_error_t n2d_util_allocate_buffer(int width, int height,
                                      n2d_format_t format,
                                      n2d_orientation_t orientation,
                                      n2d_tiling_t tiling,
                                      n2d_tsc_t tsc,
                                      n2d_buffer_t *buf);

#endif /* NANO2D_UTIL_H */
