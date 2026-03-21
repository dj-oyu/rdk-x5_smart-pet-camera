/*
 * n2d_comic.c - GPU-accelerated comic grid composition using nano2D
 *
 * Uses n2d_blit for crop+scale+placement of NV12 panels into a grid.
 */

#include "n2d_comic.h"
#include "logger.h"
#include <string.h>
#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"

static int g_n2d_initialized = 0;

static int ensure_n2d_init(void) {
    if (g_n2d_initialized) return 0;
    n2d_error_t err = n2d_open();
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Comic", "n2d_open failed: %d", err);
        return -1;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);
    g_n2d_initialized = 1;
    return 0;
}

int n2d_comic_compose(
    const uint8_t *nv12_frames[],
    const int frame_widths[],
    const int frame_heights[],
    const comic_crop_t crops[],
    int num_panels,
    int panel_w, int panel_h,
    int margin, int gap,
    uint8_t *out_nv12,
    int out_w, int out_h)
{
    if (!nv12_frames || num_panels < 1 || num_panels > 4) return -1;
    if (!out_nv12) return -1;

    if (ensure_n2d_init() != 0) return -1;

    // Allocate canvas (white background in NV12: Y=235, U=128, V=128)
    n2d_buffer_t canvas = {0};
    n2d_error_t err = n2d_util_allocate_buffer(
        out_w, out_h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &canvas);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Comic", "Failed to allocate canvas: %d", err);
        return -1;
    }

    // Fill white (Y=235, packed as 0x80EB8080 for NV12 fill)
    n2d_fill(&canvas, N2D_NULL, 0x80EB8080, N2D_BLEND_NONE);

    // Panel positions in 2x2 grid
    int border = 2;
    int cell_w = panel_w + 2 * border;
    int cell_h = panel_h + 2 * border;
    int positions[4][2] = {
        {margin, margin},
        {margin + cell_w + gap, margin},
        {margin, margin + cell_h + gap},
        {margin + cell_w + gap, margin + cell_h + gap},
    };

    // Draw black borders and blit panels
    for (int i = 0; i < num_panels && i < 4; i++) {
        int px = positions[i][0];
        int py = positions[i][1];

        // Black border fill
        n2d_rectangle_t border_rect = {px, py, cell_w, cell_h};
        n2d_fill(&canvas, &border_rect, 0x80108080, N2D_BLEND_NONE);  // Y=16 (black)

        // Allocate source buffer and copy NV12 data
        int fw = frame_widths[i];
        int fh = frame_heights[i];
        n2d_buffer_t src = {0};
        err = n2d_util_allocate_buffer(
            fw, fh, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &src);
        if (N2D_IS_ERROR(err)) {
            LOG_WARN("N2D_Comic", "Panel %d: failed to allocate src: %d", i, err);
            continue;
        }

        // Copy NV12 frame data to nano2D buffer
        if (src.memory) {
            memcpy(src.memory, nv12_frames[i], fw * fh * 3 / 2);
        }

        // Determine crop region
        n2d_rectangle_t src_rect;
        if (crops && crops[i].src_w > 0 && crops[i].src_h > 0) {
            src_rect = (n2d_rectangle_t){crops[i].src_x, crops[i].src_y,
                                          crops[i].src_w, crops[i].src_h};
        } else {
            src_rect = (n2d_rectangle_t){0, 0, fw, fh};
        }

        // Blit: crop from source → scale to panel size → place in canvas
        n2d_rectangle_t dst_rect = {px + border, py + border, panel_w, panel_h};
        n2d_blit(&canvas, &dst_rect, &src, &src_rect, N2D_BLEND_NONE);

        n2d_free(&src);
    }

    n2d_commit();

    // Copy result to output buffer
    if (canvas.memory) {
        memcpy(out_nv12, canvas.memory, out_w * out_h * 3 / 2);
    }

    n2d_free(&canvas);
    return 0;
}
