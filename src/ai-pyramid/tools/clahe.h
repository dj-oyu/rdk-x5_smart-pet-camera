// clahe.h — CLAHE + median blur for IR night frames (NV12 Y plane).
// Ported from Rust clahe.rs. Pure C, no dependencies.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

static constexpr int CLAHE_TILE_X = 8;
static constexpr int CLAHE_TILE_Y = 8;
static constexpr float CLAHE_CLIP_LIMIT = 3.0f;
static constexpr int HIST_BINS = 256;

static void median_blur_3x3(const uint8_t* src, uint8_t* dst, int w, int h) {
    memcpy(dst, src, w * h);
    uint8_t window[9];
    for (int row = 1; row < h - 1; ++row) {
        for (int col = 1; col < w - 1; ++col) {
            int k = 0;
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    window[k++] = src[(row + dy) * w + (col + dx)];
                }
            }
            std::sort(window, window + 9);
            dst[row * w + col] = window[4];
        }
    }
}

static void clahe_y_plane(const uint8_t* y_in, uint8_t* y_out, int w, int h) {
    const int tile_w = w / CLAHE_TILE_X;
    const int tile_h = h / CLAHE_TILE_Y;
    const int tile_pixels = tile_w * tile_h;
    const uint32_t clip_count = (uint32_t)(CLAHE_CLIP_LIMIT * tile_pixels / HIST_BINS);

    uint8_t cdfs[CLAHE_TILE_Y * CLAHE_TILE_X][HIST_BINS];
    for (int ty = 0; ty < CLAHE_TILE_Y; ++ty) {
        for (int tx = 0; tx < CLAHE_TILE_X; ++tx) {
            uint32_t hist[HIST_BINS] = {};
            const int x0 = tx * tile_w;
            const int y0 = ty * tile_h;
            for (int r = y0; r < y0 + tile_h; ++r) {
                for (int c = x0; c < x0 + tile_w; ++c) {
                    hist[y_in[r * w + c]]++;
                }
            }
            uint32_t excess = 0;
            for (int i = 0; i < HIST_BINS; ++i) {
                if (hist[i] > clip_count) {
                    excess += hist[i] - clip_count;
                    hist[i] = clip_count;
                }
            }
            const uint32_t redist = excess / HIST_BINS;
            const int remainder = excess % HIST_BINS;
            for (int i = 0; i < HIST_BINS; ++i) {
                hist[i] += redist;
                if (i < remainder) {
                    hist[i]++;
                }
            }
            uint32_t cdf[HIST_BINS];
            cdf[0] = hist[0];
            for (int i = 1; i < HIST_BINS; ++i) {
                cdf[i] = cdf[i - 1] + hist[i];
            }
            uint32_t cdf_min = 0;
            for (int i = 0; i < HIST_BINS; ++i) {
                if (cdf[i] > 0) {
                    cdf_min = cdf[i];
                    break;
                }
            }
            const uint32_t denom = std::max((uint32_t)tile_pixels - cdf_min, 1u);
            for (int i = 0; i < HIST_BINS; ++i) {
                const float val =
                    (float)(cdf[i] > cdf_min ? cdf[i] - cdf_min : 0) / denom * 255.f;
                cdfs[ty * CLAHE_TILE_X + tx][i] = (uint8_t)(val + 0.5f);
            }
        }
    }

    const float half_tw = tile_w / 2.f;
    const float half_th = tile_h / 2.f;
    for (int row = 0; row < h; ++row) {
        for (int col = 0; col < w; ++col) {
            const int val = y_in[row * w + col];
            const float fy = (row - half_th) / (float)tile_h;
            const float fx = (col - half_tw) / (float)tile_w;
            const int ty0 = std::clamp((int)std::floor(fy), 0, CLAHE_TILE_Y - 1);
            const int ty1 = std::min(ty0 + 1, CLAHE_TILE_Y - 1);
            const int tx0 = std::clamp((int)std::floor(fx), 0, CLAHE_TILE_X - 1);
            const int tx1 = std::min(tx0 + 1, CLAHE_TILE_X - 1);
            const float wy = std::clamp(fy - std::floor(fy), 0.f, 1.f);
            const float wx = std::clamp(fx - std::floor(fx), 0.f, 1.f);
            const float v00 = cdfs[ty0 * CLAHE_TILE_X + tx0][val];
            const float v01 = cdfs[ty0 * CLAHE_TILE_X + tx1][val];
            const float v10 = cdfs[ty1 * CLAHE_TILE_X + tx0][val];
            const float v11 = cdfs[ty1 * CLAHE_TILE_X + tx1][val];
            const float top = v00 * (1.f - wx) + v01 * wx;
            const float bot = v10 * (1.f - wx) + v11 * wx;
            y_out[row * w + col] = (uint8_t)(top * (1.f - wy) + bot * wy + 0.5f);
        }
    }
}

// Apply CLAHE to NV12 frame in-place: median blur + CLAHE on Y, UV set to 128.
static void apply_clahe_nv12(uint8_t* nv12, int w, int h) {
    const int y_size = w * h;
    std::vector<uint8_t> tmp(y_size);
    median_blur_3x3(nv12, tmp.data(), w, h);
    clahe_y_plane(tmp.data(), nv12, w, h);
    memset(nv12 + y_size, 128, y_size / 2);
}
