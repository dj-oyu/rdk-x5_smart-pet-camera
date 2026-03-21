/*
 * Hardware Letterbox Test
 * Tests nano2D (GC820) and rectangle_fill for YOLO letterboxing
 * 640x360 (16:9) → 640x640 (1:1) with black bars
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "GC820/nano2D.h"

int main() {
    int src_w = 640, src_h = 360;
    int dst_w = 640, dst_h = 640;
    int pad_top = (dst_h - src_h) / 2;  // 140px
    int iterations = 100;

    printf("=== HW Letterbox Benchmark (nano2D) ===\n");
    printf("Input: %dx%d → Output: %dx%d (pad_top=%d)\n\n", src_w, src_h, dst_w, dst_h, pad_top);

    n2d_error_t error = n2d_open();
    if (N2D_IS_ERROR(error)) { printf("n2d_open failed: %d\n", error); return 1; }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    // Source: 640x360 NV12 (simulated camera frame)
    n2d_buffer_t src = {0};
    error = n2d_util_allocate_buffer(src_w, src_h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &src);
    if (N2D_IS_ERROR(error)) { printf("alloc src failed: %d\n", error); goto close; }

    // Fill source with test pattern (gray gradient)
    if (src.memory) {
        uint8_t *y = (uint8_t*)src.memory;
        for (int row = 0; row < src_h; row++)
            for (int col = 0; col < src_w; col++)
                y[row * src.stride + col] = (uint8_t)(row * 255 / src_h);
    }

    // Destination: 640x640 NV12 (letterboxed output for YOLO)
    n2d_buffer_t dst = {0};
    error = n2d_util_allocate_buffer(dst_w, dst_h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &dst);
    if (N2D_IS_ERROR(error)) { printf("alloc dst failed: %d\n", error); goto free_src; }

    // === Method 1: n2d_fill + n2d_blit (fill black, then blit center) ===
    printf("--- Method 1: n2d_fill (black) + n2d_blit (center) ---\n");
    {
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int i = 0; i < iterations; i++) {
            // Fill entire dst with black (Y=0 in NV12)
            n2d_color_t black = 0x00000000;  // ARGB black
            error = n2d_fill(&dst, N2D_NULL, black, N2D_BLEND_NONE);
            if (N2D_IS_ERROR(error) && i == 0) printf("  n2d_fill failed: %d\n", error);

            // Blit source into center of dst
            n2d_rectangle_t dst_rect = { .x = 0, .y = pad_top, .width = src_w, .height = src_h };
            error = n2d_blit(&dst, &dst_rect, &src, N2D_NULL, N2D_BLEND_NONE);
            if (N2D_IS_ERROR(error) && i == 0) printf("  n2d_blit failed: %d\n", error);

            n2d_commit();
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0 + (t1.tv_nsec-t0.tv_nsec)/1e6) / iterations;
        printf("  %.2f ms/frame (%.1f fps)\n\n", ms, 1000.0/ms);
    }

    // === Method 2: n2d_blit only (skip fill, assume dst pre-zeroed) ===
    printf("--- Method 2: n2d_blit only (pre-zeroed dst) ---\n");
    {
        // Pre-zero once
        n2d_fill(&dst, N2D_NULL, 0x00000000, N2D_BLEND_NONE);
        n2d_commit();

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int i = 0; i < iterations; i++) {
            n2d_rectangle_t dst_rect = { .x = 0, .y = pad_top, .width = src_w, .height = src_h };
            n2d_blit(&dst, &dst_rect, &src, N2D_NULL, N2D_BLEND_NONE);
            n2d_commit();
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0 + (t1.tv_nsec-t0.tv_nsec)/1e6) / iterations;
        printf("  %.2f ms/frame (%.1f fps)\n\n", ms, 1000.0/ms);
    }

    // === Method 3: Full pipeline - 1920x1080 → crop+scale 640x360 → letterbox 640x640 ===
    printf("--- Method 3: Full pipeline (1080p → 640x360 scale → 640x640 letterbox) ---\n");
    {
        n2d_buffer_t hd_src = {0};
        error = n2d_util_allocate_buffer(1920, 1080, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &hd_src);
        if (N2D_IS_ERROR(error)) { printf("  alloc hd_src failed: %d\n", error); goto skip3; }

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int i = 0; i < iterations; i++) {
            // Step 1: Fill dst black
            n2d_fill(&dst, N2D_NULL, 0x00000000, N2D_BLEND_NONE);
            // Step 2: Scale 1920x1080 → blit into 640x360 center of 640x640
            n2d_rectangle_t dst_rect = { .x = 0, .y = pad_top, .width = 640, .height = 360 };
            n2d_blit(&dst, &dst_rect, &hd_src, N2D_NULL, N2D_BLEND_NONE);
            n2d_commit();
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0 + (t1.tv_nsec-t0.tv_nsec)/1e6) / iterations;
        printf("  %.2f ms/frame (%.1f fps)\n", ms, 1000.0/ms);
        printf("  (includes 1920x1080→640x360 downscale + letterbox)\n\n");

        n2d_free(&hd_src);
    }
skip3:

    // === Comparison: Software letterbox (CPU memcpy) ===
    printf("--- Reference: Software letterbox (CPU memcpy) ---\n");
    {
        int y_size_src = src_w * src_h;
        int uv_size_src = src_w * src_h / 2;
        int y_size_dst = dst_w * dst_h;
        uint8_t *sw_src = malloc(y_size_src + uv_size_src);
        uint8_t *sw_dst = calloc(1, dst_w * dst_h * 3 / 2);
        memset(sw_src, 128, y_size_src + uv_size_src);

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int i = 0; i < iterations; i++) {
            // Y plane: copy to center
            memset(sw_dst, 0, y_size_dst);  // black
            memcpy(sw_dst + pad_top * dst_w, sw_src, y_size_src);
            // UV plane: copy to center
            int uv_pad_top = pad_top / 2;
            memset(sw_dst + y_size_dst, 128, dst_w * dst_h / 2);  // neutral UV
            memcpy(sw_dst + y_size_dst + uv_pad_top * dst_w, sw_src + y_size_src, uv_size_src);
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0 + (t1.tv_nsec-t0.tv_nsec)/1e6) / iterations;
        printf("  %.2f ms/frame (%.1f fps)\n\n", ms, 1000.0/ms);

        free(sw_src);
        free(sw_dst);
    }

    n2d_free(&dst);
free_src:
    n2d_free(&src);
close:
    n2d_close();
    printf("=== Done ===\n");
    return 0;
}
