/*
 * n2d_comic.h - GPU-accelerated comic grid composition using nano2D
 *
 * Composes NV12 frames into a 2x2 comic grid and outputs JPEG via HW encoder.
 */

#ifndef N2D_COMIC_H
#define N2D_COMIC_H

#include <stdint.h>
#include <stddef.h>

/**
 * Crop region for a comic panel
 */
typedef struct {
    int src_x, src_y;    // Crop origin in source frame
    int src_w, src_h;    // Crop size in source frame
} comic_crop_t;

/**
 * Compose a 2x2 comic grid from up to 4 NV12 frames
 *
 * Each panel is cropped from its source frame, scaled to panel size,
 * and placed in a 2x2 grid. All operations use nano2D (GPU).
 * Final output is NV12 which can be fed to HW JPEG encoder.
 *
 * Args:
 *   nv12_frames: Array of NV12 frame data pointers (up to 4)
 *   frame_widths: Width of each source frame
 *   frame_heights: Height of each source frame
 *   crops: Crop region for each panel (NULL = full frame)
 *   num_panels: Number of panels (1-4)
 *   panel_w: Output panel width (e.g., 400)
 *   panel_h: Output panel height (e.g., 225)
 *   margin: Margin around grid (pixels)
 *   gap: Gap between panels (pixels)
 *   out_nv12: Output NV12 buffer (caller-allocated)
 *   out_w: Output canvas width
 *   out_h: Output canvas height
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int n2d_comic_compose(
    const uint8_t *nv12_frames[],
    const int frame_widths[],
    const int frame_heights[],
    const comic_crop_t crops[],
    int num_panels,
    int panel_w, int panel_h,
    int margin, int gap,
    uint8_t *out_nv12,
    int out_w, int out_h);

#endif // N2D_COMIC_H
