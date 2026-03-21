/*
 * rgn_overlay.h - NV12 overlay drawing (CPU)
 *
 * Draws text (bitmap font) and rectangles on NV12 frames.
 * 768x432 at ~5 rects + 5 texts = negligible CPU cost.
 */

#ifndef RGN_OVERLAY_H
#define RGN_OVERLAY_H

#include <stdint.h>

typedef struct {
    int x, y, w, h;
    uint8_t y_val, u_val, v_val;
    int thickness;  // 0 = filled, >0 = outline
} overlay_rect_t;

typedef struct {
    int x, y;
    const char *text;
    uint8_t text_y;   // Text Y luminance (235=white, 16=black)
    uint8_t bg_y;     // Background Y luminance
    int scale;        // Font scale (1=small, 2=medium)
} overlay_text_t;

int rgn_overlay_draw(
    uint8_t *nv12, int width, int height,
    const overlay_rect_t *rects, int num_rects,
    const overlay_text_t *texts, int num_texts);

#endif
