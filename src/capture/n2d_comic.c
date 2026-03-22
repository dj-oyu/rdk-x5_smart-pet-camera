/*
 * n2d_comic.c - GPU-accelerated comic grid composition using nano2D
 *
 * Uses n2d_blit for crop+scale+placement of NV12 panels into a grid.
 * Buffers are allocated once and reused (same pattern as letterbox_hw_test).
 */

#include "n2d_comic.h"
#include "logger.h"
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"

static int g_n2d_initialized = 0;
static int g_n2d_failed = 0;  // Permanent failure flag (no GPU device)

// Pre-allocated buffers (reused across calls)
static n2d_buffer_t g_canvas = {0};
static int g_canvas_w = 0, g_canvas_h = 0;
static n2d_buffer_t g_src_buf = {0};
static int g_src_w = 0, g_src_h = 0;

static int ensure_n2d_init(void) {
    if (g_n2d_initialized) return 0;
    if (g_n2d_failed) return -1;
    // Check if GPU device exists before calling n2d_open (avoids SEGV)
    if (access("/dev/galcore", F_OK) != 0) {
        LOG_ERROR("N2D_Comic", "No GPU device (/dev/galcore), skipping nano2D");
        g_n2d_failed = 1;
        return -1;
    }
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

// Ensure canvas buffer is allocated with required dimensions
static int ensure_canvas(int w, int h) {
    if (g_canvas.memory && g_canvas_w == w && g_canvas_h == h) return 0;
    if (g_canvas.memory) n2d_free(&g_canvas);
    memset(&g_canvas, 0, sizeof(g_canvas));
    n2d_error_t err = n2d_util_allocate_buffer(
        w, h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &g_canvas);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Comic", "Failed to allocate canvas %dx%d: %d", w, h, err);
        return -1;
    }
    g_canvas_w = w;
    g_canvas_h = h;
    return 0;
}

// Ensure src buffer is allocated with required dimensions
static int ensure_src(int w, int h) {
    if (g_src_buf.memory && g_src_w == w && g_src_h == h) return 0;
    if (g_src_buf.memory) n2d_free(&g_src_buf);
    memset(&g_src_buf, 0, sizeof(g_src_buf));
    n2d_error_t err = n2d_util_allocate_buffer(
        w, h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &g_src_buf);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Comic", "Failed to allocate src %dx%d: %d", w, h, err);
        return -1;
    }
    g_src_w = w;
    g_src_h = h;
    return 0;
}

// Copy NV12 frame into nano2D buffer respecting stride alignment
static void copy_nv12_to_n2d(n2d_buffer_t *buf, const uint8_t *nv12, int w, int h) {
    uint8_t *dst = (uint8_t *)buf->memory;
    // Y plane
    for (int y = 0; y < h; y++)
        memcpy(dst + y * buf->stride, nv12 + y * w, w);
    // UV plane
    uint8_t *dst_uv = dst + buf->stride * buf->alignedh;
    const uint8_t *src_uv = nv12 + w * h;
    for (int y = 0; y < h / 2; y++)
        memcpy(dst_uv + y * buf->stride, src_uv + y * w, w);
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
    if (ensure_canvas(out_w, out_h) != 0) return -1;

    // Fill white
    n2d_fill(&g_canvas, N2D_NULL, 0xFFFFFFFF, N2D_BLEND_NONE);

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
        n2d_fill(&g_canvas, &border_rect, 0xFF000000, N2D_BLEND_NONE);  // black

        // Ensure src buffer matches this panel's dimensions
        int fw = frame_widths[i];
        int fh = frame_heights[i];
        if (ensure_src(fw, fh) != 0) continue;

        // Copy NV12 frame data respecting nano2D stride alignment
        if (g_src_buf.memory && nv12_frames[i]) {
            copy_nv12_to_n2d(&g_src_buf, nv12_frames[i], fw, fh);
        } else {
            continue;
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
        n2d_blit(&g_canvas, &dst_rect, &g_src_buf, &src_rect, N2D_BLEND_NONE);
        n2d_commit();  // Execute before g_src_buf is overwritten by next panel
    }

    // Copy result to output buffer (respecting stride alignment)
    if (g_canvas.memory) {
        uint8_t *src = (uint8_t *)g_canvas.memory;
        // Y plane
        for (int y = 0; y < out_h; y++)
            memcpy(out_nv12 + y * out_w, src + y * g_canvas.stride, out_w);
        // UV plane
        uint8_t *src_uv = src + g_canvas.stride * g_canvas.alignedh;
        uint8_t *dst_uv = out_nv12 + out_w * out_h;
        for (int y = 0; y < out_h / 2; y++)
            memcpy(dst_uv + y * out_w, src_uv + y * g_canvas.stride, out_w);
    }

    return 0;
}
