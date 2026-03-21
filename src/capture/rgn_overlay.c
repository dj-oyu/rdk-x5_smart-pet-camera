/*
 * rgn_overlay.c - NV12 overlay drawing (CPU)
 *
 * Bitmap font + rectangle drawing directly on NV12 Y/UV planes.
 * Target: 768x432 MJPEG overlay — negligible CPU cost.
 */

#include "rgn_overlay.h"
#include <string.h>

// 5x7 bitmap font
static const uint8_t font5x7[][5] = {
    {0x3E,0x51,0x49,0x45,0x3E}, {0x00,0x42,0x7F,0x40,0x00}, // 0 1
    {0x42,0x61,0x51,0x49,0x46}, {0x21,0x41,0x45,0x4B,0x31}, // 2 3
    {0x18,0x14,0x12,0x7F,0x10}, {0x27,0x45,0x45,0x45,0x39}, // 4 5
    {0x3C,0x4A,0x49,0x49,0x30}, {0x01,0x71,0x09,0x05,0x03}, // 6 7
    {0x36,0x49,0x49,0x49,0x36}, {0x06,0x49,0x49,0x29,0x1E}, // 8 9
    {0x00,0x36,0x36,0x00,0x00}, {0x08,0x08,0x08,0x08,0x08}, // : -
    {0x00,0x60,0x60,0x00,0x00}, {0x20,0x10,0x08,0x04,0x02}, // . /
    {0x00,0x00,0x00,0x00,0x00},                               // space
    {0x7E,0x11,0x11,0x11,0x7E}, {0x7F,0x49,0x49,0x49,0x36}, // A B
    {0x3E,0x41,0x41,0x41,0x22}, {0x7F,0x41,0x41,0x22,0x1C}, // C D
    {0x7F,0x49,0x49,0x49,0x41}, {0x7F,0x09,0x09,0x09,0x01}, // E F
    {0x3E,0x41,0x49,0x49,0x7A}, {0x7F,0x08,0x08,0x08,0x7F}, // G H
    {0x00,0x41,0x7F,0x41,0x00},                               // I
    {0x7F,0x02,0x0C,0x02,0x7F}, {0x7F,0x04,0x08,0x10,0x7F}, // M N
    {0x3E,0x41,0x41,0x41,0x3E}, {0x01,0x01,0x7F,0x01,0x01}, // O T
    {0x20,0x54,0x54,0x54,0x78}, {0x7F,0x48,0x44,0x44,0x38}, // a b
    {0x38,0x44,0x44,0x44,0x20}, {0x38,0x44,0x44,0x48,0x7F}, // c d
    {0x38,0x54,0x54,0x54,0x18}, {0x00,0x44,0x7D,0x40,0x00}, // e i
    {0x7C,0x04,0x18,0x04,0x78}, {0x7C,0x08,0x04,0x04,0x78}, // m n
    {0x38,0x44,0x44,0x44,0x38}, {0x7C,0x14,0x14,0x14,0x08}, // o p
    {0x7C,0x08,0x04,0x04,0x08}, {0x48,0x54,0x54,0x54,0x20}, // r s
    {0x04,0x3F,0x44,0x40,0x20},                               // t
};

static int font_idx(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c == ':') return 10; if (c == '-') return 11;
    if (c == '.') return 12; if (c == '/') return 13;
    if (c == ' ') return 14;
    if (c >= 'A' && c <= 'I') return 15 + (c - 'A');
    if (c == 'M') return 24; if (c == 'N') return 25;
    if (c == 'O') return 26; if (c == 'T') return 27;
    if (c >= 'a' && c <= 'e') return 28 + (c - 'a');
    if (c == 'i') return 33; if (c == 'm') return 34;
    if (c == 'n') return 35; if (c == 'o') return 36;
    if (c == 'p') return 37; if (c == 'r') return 38;
    if (c == 's') return 39; if (c == 't') return 40;
    return 14;
}

static void draw_rect(uint8_t *nv12, int w, int h,
                       const overlay_rect_t *r) {
    uint8_t *y_plane = nv12;
    uint8_t *uv_plane = nv12 + w * h;
    int x0 = r->x, y0 = r->y, rw = r->w, rh = r->h;
    if (x0 < 0) { rw += x0; x0 = 0; }
    if (y0 < 0) { rh += y0; y0 = 0; }
    if (x0 + rw > w) rw = w - x0;
    if (y0 + rh > h) rh = h - y0;
    if (rw <= 0 || rh <= 0) return;

    int t = r->thickness;
    if (t > rh / 2) t = rh / 2;
    if (t > rw / 2) t = rw / 2;

    for (int py = y0; py < y0 + rh; py++) {
        int ly = py - y0;
        int edge = (t == 0) ||
                   (ly < t) || (ly >= rh - t);
        uint8_t *yr = y_plane + py * w;
        for (int px = x0; px < x0 + rw; px++) {
            int lx = px - x0;
            if (edge || lx < t || lx >= rw - t)
                yr[px] = r->y_val;
        }
    }

    // UV plane (half res, interleaved NV12)
    int uy0 = y0 / 2, uy1 = (y0 + rh + 1) / 2;
    int ux0 = x0 / 2, ux1 = (x0 + rw + 1) / 2;
    int ut = (t + 1) / 2;

    for (int uy = uy0; uy < uy1 && uy < h / 2; uy++) {
        int ly = uy - uy0, uvh = uy1 - uy0;
        int edge = (t == 0) ||
                   (ly < ut) || (ly >= uvh - ut);
        uint8_t *uvr = uv_plane + uy * w;
        for (int ux = ux0; ux < ux1 && ux < w / 2; ux++) {
            int lx = ux - ux0, uvw = ux1 - ux0;
            if (edge || lx < ut || lx >= uvw - ut) {
                uvr[ux * 2]     = r->u_val;
                uvr[ux * 2 + 1] = r->v_val;
            }
        }
    }
}

static void draw_text(uint8_t *nv12, int w, int h,
                       const overlay_text_t *t) {
    uint8_t *y_plane = nv12;
    int len = (int)strlen(t->text);
    int tw = len * 6 * t->scale;
    int th = 7 * t->scale;
    int pad = 4;

    // Background
    for (int py = t->y - pad; py < t->y + th + pad && py < h; py++) {
        if (py < 0) continue;
        uint8_t *row = y_plane + py * w;
        for (int px = t->x - pad; px < t->x + tw + pad && px < w; px++) {
            if (px >= 0) row[px] = t->bg_y;
        }
    }

    // Glyphs
    for (int ci = 0; ci < len; ci++) {
        int fi = font_idx(t->text[ci]);
        if (fi < 0 || fi >= (int)(sizeof(font5x7)/sizeof(font5x7[0]))) fi = 14;
        for (int col = 0; col < 5; col++) {
            uint8_t bits = font5x7[fi][col];
            for (int row = 0; row < 7; row++) {
                if (!(bits & (1 << row))) continue;
                for (int sy = 0; sy < t->scale; sy++) {
                    int py = t->y + row * t->scale + sy;
                    if (py < 0 || py >= h) continue;
                    uint8_t *yr = y_plane + py * w;
                    for (int sx = 0; sx < t->scale; sx++) {
                        int px = t->x + (ci * 6 + col) * t->scale + sx;
                        if (px >= 0 && px < w) yr[px] = t->text_y;
                    }
                }
            }
        }
    }
}

int rgn_overlay_draw(
    uint8_t *nv12, int width, int height,
    const overlay_rect_t *rects, int num_rects,
    const overlay_text_t *texts, int num_texts)
{
    if (!nv12 || width <= 0 || height <= 0) return -1;
    for (int i = 0; i < num_rects; i++)
        draw_rect(nv12, width, height, &rects[i]);
    for (int i = 0; i < num_texts; i++)
        draw_text(nv12, width, height, &texts[i]);
    return 0;
}
