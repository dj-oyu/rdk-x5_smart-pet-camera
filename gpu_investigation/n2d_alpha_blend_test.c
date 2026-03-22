/*
 * n2d_alpha_blend_test.c - Verify cross-format alpha blending (BGRA→NV12)
 *
 * Tests whether nano2D (GC820) can alpha-blend a BGRA8888 overlay
 * directly onto an NV12 destination buffer using N2D_BLEND_SRC_OVER.
 *
 * Build:
 *   gcc -O2 -o n2d_alpha_blend_test n2d_alpha_blend_test.c \
 *       -I/usr/include/GC820 -lNano2D -lNano2Dutil -lm
 *
 * Run:
 *   ./n2d_alpha_blend_test
 *
 * Output:
 *   - test1_direct_blend.nv12   (640x480)
 *   - test2_twostep_blend.nv12  (640x480)
 *   - Performance numbers to stdout
 *
 * Verify with:
 *   ffplay -f rawvideo -pixel_format nv12 -video_size 640x480 test1_direct_blend.nv12
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"

#define W 640
#define H 480
#define OVERLAY_W 200
#define OVERLAY_H 60
#define OVERLAY_X 50
#define OVERLAY_Y 50
#define BENCH_ITERS 1000

/* ---- helpers ---- */

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static int save_nv12(const char *path, n2d_buffer_t *buf, int w, int h) {
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); return -1; }
    /* NV12: Y plane (w*h) + UV plane (w*h/2) */
    size_t size = (size_t)w * h * 3 / 2;
    if (buf->memory) {
        fwrite(buf->memory, 1, size, f);
    }
    fclose(f);
    printf("  Saved %s (%zu bytes)\n", path, size);
    return 0;
}

/* Fill NV12 buffer with a green-ish color (Y=149, U=43, V=21) */
static void fill_nv12_green(n2d_buffer_t *buf, int w, int h) {
    if (!buf->memory) return;
    uint8_t *mem = (uint8_t *)buf->memory;
    /* Y plane */
    memset(mem, 149, w * h);
    /* UV plane: U=43, V=21 (green in BT.601) */
    uint8_t *uv = mem + w * h;
    for (int i = 0; i < w * h / 2; i += 2) {
        uv[i]     = 43;   /* U */
        uv[i + 1] = 21;   /* V */
    }
}

/* Fill BGRA overlay: semi-transparent red rectangle with text-like pattern */
static void fill_bgra_overlay(n2d_buffer_t *buf, int w, int h) {
    if (!buf->memory) return;
    uint8_t *mem = (uint8_t *)buf->memory;
    int stride = buf->stride;  /* bytes per row (may be aligned) */
    for (int y = 0; y < h; y++) {
        uint8_t *row = mem + y * stride;
        for (int x = 0; x < w; x++) {
            uint8_t *px = row + x * 4;
            /* Create a pattern: solid band with varying alpha */
            uint8_t alpha;
            if (y >= 10 && y < h - 10 && x >= 10 && x < w - 10) {
                /* Inner area: semi-transparent red (simulates text bg) */
                alpha = 180;
                px[0] = 30;   /* B */
                px[1] = 30;   /* G */
                px[2] = 200;  /* R */
                px[3] = alpha; /* A */
            } else {
                /* Outer area: fully transparent */
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
                px[3] = 0;
            }
        }
    }
    /* Draw some "text-like" white pixels in center */
    for (int y = 20; y < h - 20; y++) {
        uint8_t *row = mem + y * stride;
        for (int x = 30; x < w - 30; x += 3) {
            uint8_t *px = row + x * 4;
            if ((x + y) % 7 < 3) {  /* pseudo-glyph pattern */
                px[0] = 255;  /* B */
                px[1] = 255;  /* G */
                px[2] = 255;  /* R */
                px[3] = 255;  /* A (fully opaque white) */
            }
        }
    }
}

/* ---- Test 1: Direct cross-format alpha blend (BGRA→NV12 SRC_OVER) ---- */

static int test1_direct_blend(void) {
    printf("\n=== Test 1: Direct BGRA→NV12 alpha blend (SRC_OVER) ===\n");

    n2d_error_t err;
    n2d_buffer_t dst = {0};
    n2d_buffer_t src = {0};

    /* Allocate NV12 destination (simulates camera frame) */
    err = n2d_util_allocate_buffer(W, H, N2D_NV12,
        N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &dst);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: allocate NV12 dst: %d\n", err);
        return -1;
    }

    /* Allocate BGRA source (simulates text overlay) */
    err = n2d_util_allocate_buffer(OVERLAY_W, OVERLAY_H, N2D_BGRA8888,
        N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &src);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: allocate BGRA src: %d\n", err);
        n2d_free(&dst);
        return -1;
    }

    /* Fill test data */
    fill_nv12_green(&dst, W, H);
    fill_bgra_overlay(&src, OVERLAY_W, OVERLAY_H);

    /* Attempt cross-format alpha blend */
    n2d_rectangle_t dst_rect = {OVERLAY_X, OVERLAY_Y, OVERLAY_W, OVERLAY_H};
    err = n2d_blit(&dst, &dst_rect, &src, N2D_NULL, N2D_BLEND_SRC_OVER);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: n2d_blit SRC_OVER returned error %d\n", err);
        printf("  >> Cross-format alpha blend NOT supported\n");
        n2d_free(&src);
        n2d_free(&dst);
        return -1;
    }

    err = n2d_commit();
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: n2d_commit returned error %d\n", err);
        n2d_free(&src);
        n2d_free(&dst);
        return -1;
    }

    printf("  OK: n2d_blit SRC_OVER succeeded!\n");
    save_nv12("test1_direct_blend.nv12", &dst, W, H);

    /* Benchmark */
    printf("  Benchmarking %d iterations...\n", BENCH_ITERS);
    double t0 = now_ms();
    for (int i = 0; i < BENCH_ITERS; i++) {
        n2d_blit(&dst, &dst_rect, &src, N2D_NULL, N2D_BLEND_SRC_OVER);
        n2d_commit();
    }
    double elapsed = now_ms() - t0;
    printf("  Perf: %.3f ms/iter (%.1f ops/sec)\n",
           elapsed / BENCH_ITERS, BENCH_ITERS / elapsed * 1000.0);

    /* Benchmark batch: 5 blits + 1 commit (simulates 5 labels) */
    printf("  Benchmarking batch (5 blits + 1 commit) x %d...\n", BENCH_ITERS);
    n2d_rectangle_t rects[5] = {
        {50, 50, OVERLAY_W, OVERLAY_H},
        {50, 120, OVERLAY_W, OVERLAY_H},
        {50, 190, OVERLAY_W, OVERLAY_H},
        {50, 260, OVERLAY_W, OVERLAY_H},
        {50, 330, OVERLAY_W, OVERLAY_H},
    };
    t0 = now_ms();
    for (int i = 0; i < BENCH_ITERS; i++) {
        for (int j = 0; j < 5; j++) {
            n2d_blit(&dst, &rects[j], &src, N2D_NULL, N2D_BLEND_SRC_OVER);
        }
        n2d_commit();
    }
    elapsed = now_ms() - t0;
    printf("  Perf (5 labels): %.3f ms/iter (%.1f fps)\n",
           elapsed / BENCH_ITERS, BENCH_ITERS / elapsed * 1000.0);

    n2d_free(&src);
    n2d_free(&dst);
    return 0;
}

/* ---- Test 2: Two-step path (NV12→BGRA blend, BGRA→NV12 writeback) ---- */

static int test2_twostep_blend(void) {
    printf("\n=== Test 2: Two-step BGRA blend via intermediate buffer ===\n");

    n2d_error_t err;
    n2d_buffer_t dst_nv12 = {0};
    n2d_buffer_t overlay_bgra = {0};
    n2d_buffer_t region_bgra = {0};

    /* Allocate NV12 destination */
    err = n2d_util_allocate_buffer(W, H, N2D_NV12,
        N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &dst_nv12);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: allocate NV12 dst: %d\n", err);
        return -1;
    }

    /* Allocate BGRA overlay (text) */
    err = n2d_util_allocate_buffer(OVERLAY_W, OVERLAY_H, N2D_BGRA8888,
        N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &overlay_bgra);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: allocate BGRA overlay: %d\n", err);
        n2d_free(&dst_nv12);
        return -1;
    }

    /* Allocate BGRA intermediate (same size as overlay region) */
    err = n2d_util_allocate_buffer(OVERLAY_W, OVERLAY_H, N2D_BGRA8888,
        N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &region_bgra);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: allocate BGRA region: %d\n", err);
        n2d_free(&overlay_bgra);
        n2d_free(&dst_nv12);
        return -1;
    }

    /* Fill test data */
    fill_nv12_green(&dst_nv12, W, H);
    fill_bgra_overlay(&overlay_bgra, OVERLAY_W, OVERLAY_H);

    /* Step A: Extract NV12 region → BGRA (format conversion) */
    n2d_rectangle_t src_rect = {OVERLAY_X, OVERLAY_Y, OVERLAY_W, OVERLAY_H};
    err = n2d_blit(&region_bgra, N2D_NULL, &dst_nv12, &src_rect, N2D_BLEND_NONE);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: Step A (NV12→BGRA extract): %d\n", err);
        goto cleanup;
    }

    /* Step B: Alpha blend BGRA overlay onto BGRA region */
    err = n2d_blit(&region_bgra, N2D_NULL, &overlay_bgra, N2D_NULL, N2D_BLEND_SRC_OVER);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: Step B (BGRA alpha blend): %d\n", err);
        goto cleanup;
    }

    /* Step C: Write blended BGRA back to NV12 (format conversion) */
    n2d_rectangle_t dst_rect = {OVERLAY_X, OVERLAY_Y, OVERLAY_W, OVERLAY_H};
    err = n2d_blit(&dst_nv12, &dst_rect, &region_bgra, N2D_NULL, N2D_BLEND_NONE);
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: Step C (BGRA→NV12 writeback): %d\n", err);
        goto cleanup;
    }

    err = n2d_commit();
    if (N2D_IS_ERROR(err)) {
        printf("  FAIL: n2d_commit: %d\n", err);
        goto cleanup;
    }

    printf("  OK: Two-step blend succeeded!\n");
    save_nv12("test2_twostep_blend.nv12", &dst_nv12, W, H);

    /* Benchmark: full 3-step per label, 5 labels */
    printf("  Benchmarking (3 steps x 5 labels + 1 commit) x %d...\n", BENCH_ITERS);
    n2d_rectangle_t rects[5] = {
        {50, 50, OVERLAY_W, OVERLAY_H},
        {50, 120, OVERLAY_W, OVERLAY_H},
        {50, 190, OVERLAY_W, OVERLAY_H},
        {50, 260, OVERLAY_W, OVERLAY_H},
        {50, 330, OVERLAY_W, OVERLAY_H},
    };
    double t0 = now_ms();
    for (int i = 0; i < BENCH_ITERS; i++) {
        for (int j = 0; j < 5; j++) {
            /* A: extract */
            n2d_blit(&region_bgra, N2D_NULL, &dst_nv12, &rects[j], N2D_BLEND_NONE);
            /* B: blend */
            n2d_blit(&region_bgra, N2D_NULL, &overlay_bgra, N2D_NULL, N2D_BLEND_SRC_OVER);
            /* C: writeback */
            n2d_blit(&dst_nv12, &rects[j], &region_bgra, N2D_NULL, N2D_BLEND_NONE);
        }
        n2d_commit();
    }
    double elapsed = now_ms() - t0;
    printf("  Perf (5 labels, 3-step): %.3f ms/iter (%.1f fps)\n",
           elapsed / BENCH_ITERS, BENCH_ITERS / elapsed * 1000.0);

cleanup:
    n2d_free(&region_bgra);
    n2d_free(&overlay_bgra);
    n2d_free(&dst_nv12);
    return N2D_IS_ERROR(err) ? -1 : 0;
}

/* ---- main ---- */

int main(int argc, char **argv) {
    printf("nano2D BGRA→NV12 Alpha Blend Test\n");
    printf("Frame: %dx%d NV12, Overlay: %dx%d BGRA @ (%d,%d)\n\n",
           W, H, OVERLAY_W, OVERLAY_H, OVERLAY_X, OVERLAY_Y);

    /* Check GPU device */
    if (access("/dev/galcore", F_OK) != 0) {
        printf("ERROR: /dev/galcore not found. No GPU available.\n");
        return 1;
    }

    /* Initialize nano2D */
    n2d_error_t err = n2d_open();
    if (N2D_IS_ERROR(err)) {
        printf("ERROR: n2d_open failed: %d\n", err);
        return 1;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    printf("nano2D initialized.\n");

    /* Run tests */
    int test1_ok = test1_direct_blend();

    int test2_ok = test2_twostep_blend();

    /* Summary */
    printf("\n=== Summary ===\n");
    printf("Test 1 (Direct BGRA→NV12 SRC_OVER):  %s\n",
           test1_ok == 0 ? "PASS" : "FAIL");
    printf("Test 2 (Two-step via BGRA intermediate): %s\n",
           test2_ok == 0 ? "PASS" : "FAIL");

    if (test1_ok == 0) {
        printf("\nRecommendation: Use direct BGRA→NV12 blend path.\n");
        printf("Single n2d_blit() call per label — minimal GPU overhead.\n");
    } else if (test2_ok == 0) {
        printf("\nRecommendation: Use two-step path (3 blits per label).\n");
        printf("Compare GPU cost vs current CPU 0.2ms to decide.\n");
    } else {
        printf("\nCross-format alpha blend not supported.\n");
        printf("Consider NEON SIMD optimization for CPU path.\n");
    }

    printf("\nVerify output visually:\n");
    printf("  ffplay -f rawvideo -pixel_format nv12 -video_size %dx%d test1_direct_blend.nv12\n", W, H);
    printf("  ffplay -f rawvideo -pixel_format nv12 -video_size %dx%d test2_twostep_blend.nv12\n", W, H);

    n2d_close();
    return 0;
}
