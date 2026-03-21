/*
 * Minimal GPU 2D format conversion benchmark
 * Tests NV12→RGBA and RGBA→NV12 using nano2D
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "GC820/nano2D.h"

int main(int argc, char **argv) {
    int width = 1920, height = 1080;
    int iterations = 100;

    printf("=== nano2D Format Conversion Benchmark ===\n");
    printf("Resolution: %dx%d, Iterations: %d\n\n", width, height, iterations);

    n2d_error_t error = n2d_open();
    if (N2D_IS_ERROR(error)) {
        printf("n2d_open failed: %d\n", error);
        return 1;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    // Allocate NV12 source buffer
    n2d_buffer_t nv12_buf = {0};
    error = n2d_util_allocate_buffer(width, height, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &nv12_buf);
    if (N2D_IS_ERROR(error)) {
        printf("Failed to allocate NV12 buffer: %d\n", error);
        goto close;
    }

    // Allocate RGBA destination buffer
    n2d_buffer_t rgba_buf = {0};
    error = n2d_util_allocate_buffer(width, height, N2D_RGBA8888, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &rgba_buf);
    if (N2D_IS_ERROR(error)) {
        printf("Failed to allocate RGBA buffer: %d\n", error);
        goto free_nv12;
    }

    // Benchmark: NV12 → RGBA
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < iterations; i++) {
        n2d_blit(&rgba_buf, N2D_NULL, &nv12_buf, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double nv12_to_rgba_ms = ((t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / iterations;
    printf("NV12 → RGBA: %.2f ms/frame (%.1f fps)\n", nv12_to_rgba_ms, 1000.0 / nv12_to_rgba_ms);

    // Benchmark: RGBA → NV12
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < iterations; i++) {
        n2d_blit(&nv12_buf, N2D_NULL, &rgba_buf, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double rgba_to_nv12_ms = ((t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / iterations;
    printf("RGBA → NV12: %.2f ms/frame (%.1f fps)\n", rgba_to_nv12_ms, 1000.0 / rgba_to_nv12_ms);

    // Benchmark: NV12 resize (1920x1080 → 640x360)
    n2d_buffer_t small_buf = {0};
    error = n2d_util_allocate_buffer(640, 360, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &small_buf);
    if (!N2D_IS_ERROR(error)) {
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int i = 0; i < iterations; i++) {
            n2d_blit(&small_buf, N2D_NULL, &nv12_buf, N2D_NULL, N2D_BLEND_NONE);
            n2d_commit();
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double resize_ms = ((t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / iterations;
        printf("NV12 resize 1920x1080→640x360: %.2f ms/frame (%.1f fps)\n", resize_ms, 1000.0 / resize_ms);
        n2d_free(&small_buf);
    }

    n2d_free(&rgba_buf);
free_nv12:
    n2d_free(&nv12_buf);
close:
    n2d_close();
    printf("\n=== Done ===\n");
    return 0;
}
