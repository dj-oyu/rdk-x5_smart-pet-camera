/**
 * test_hb_mem_dma.c - Benchmark hb_mem_dma_copy vs CPU memcpy
 *
 * Tests:
 * 1. hb_mem_alloc_com_buf → allocate DMA-capable buffers
 * 2. hb_mem_dma_copy vs memcpy for NV12 frame-sized copies
 * 3. Measures latency for various buffer sizes (460KB, 1.3MB, 3MB)
 *
 * Usage:
 *   ./test_hb_mem_dma
 *
 * This program does NOT require the camera daemon to be running.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "hb_mem_mgr.h"

#define ITERATIONS 100

static double timespec_diff_ms(struct timespec *start, struct timespec *end) {
    return (end->tv_sec - start->tv_sec) * 1000.0 +
           (end->tv_nsec - start->tv_nsec) / 1e6;
}

typedef struct {
    const char *label;
    size_t size;
} test_case_t;

static int bench_memcpy(const char *label, size_t size, int iterations) {
    uint8_t *src = malloc(size);
    uint8_t *dst = malloc(size);
    if (!src || !dst) {
        fprintf(stderr, "[memcpy] malloc failed for %s (%zu bytes)\n", label, size);
        free(src);
        free(dst);
        return -1;
    }

    // Fill source with pattern
    memset(src, 0xAB, size);

    // Warmup
    memcpy(dst, src, size);

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < iterations; i++) {
        memcpy(dst, src, size);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);

    double total_ms = timespec_diff_ms(&start, &end);
    double avg_ms = total_ms / iterations;
    double throughput_mbps = (double)size / 1024.0 / 1024.0 / (avg_ms / 1000.0);

    printf("  memcpy     %s: avg=%.3fms total=%.1fms throughput=%.0f MB/s\n",
           label, avg_ms, total_ms, throughput_mbps);

    // Verify
    if (memcmp(src, dst, size) != 0) {
        fprintf(stderr, "  [ERROR] memcpy data mismatch!\n");
    }

    free(src);
    free(dst);
    return 0;
}

static int bench_dma_copy(const char *label, size_t size, int iterations) {
    int32_t ret;

    // Allocate hb_mem buffers (DMA-capable)
    int64_t flags = HB_MEM_USAGE_CPU_READ_OFTEN |
                    HB_MEM_USAGE_CPU_WRITE_OFTEN |
                    HB_MEM_USAGE_CACHED;

    hb_mem_common_buf_t src_buf = {0};
    hb_mem_common_buf_t dst_buf = {0};

    ret = hb_mem_alloc_com_buf(size, flags, &src_buf);
    if (ret != 0) {
        fprintf(stderr, "  [DMA] hb_mem_alloc_com_buf(src) failed: %d (size=%zu)\n", ret, size);
        return -1;
    }

    ret = hb_mem_alloc_com_buf(size, flags, &dst_buf);
    if (ret != 0) {
        fprintf(stderr, "  [DMA] hb_mem_alloc_com_buf(dst) failed: %d (size=%zu)\n", ret, size);
        hb_mem_free_buf(src_buf.fd);
        return -1;
    }

    printf("  [DMA] Allocated: src fd=%d vaddr=0x%lx, dst fd=%d vaddr=0x%lx\n",
           src_buf.fd, (unsigned long)src_buf.virt_addr,
           dst_buf.fd, (unsigned long)dst_buf.virt_addr);

    // Fill source with pattern
    memset(src_buf.virt_addr, 0xCD, size);

    // Flush source cache so DMA sees correct data
    hb_mem_flush_buf(src_buf.fd, 0, size);

    // Warmup
    ret = hb_mem_dma_copy((uint64_t)dst_buf.virt_addr,
                           (uint64_t)src_buf.virt_addr, size);
    if (ret != 0) {
        fprintf(stderr, "  [DMA] hb_mem_dma_copy warmup failed: %d\n", ret);
        fprintf(stderr, "  [DMA] This device may not support DMA copy.\n");
        hb_mem_free_buf(src_buf.fd);
        hb_mem_free_buf(dst_buf.fd);
        return -1;
    }

    // Invalidate dst cache to read DMA result
    hb_mem_invalidate_buf(dst_buf.fd, 0, size);

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < iterations; i++) {
        hb_mem_flush_buf(src_buf.fd, 0, size);
        hb_mem_dma_copy((uint64_t)dst_buf.virt_addr,
                        (uint64_t)src_buf.virt_addr, size);
        hb_mem_invalidate_buf(dst_buf.fd, 0, size);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);

    double total_ms = timespec_diff_ms(&start, &end);
    double avg_ms = total_ms / iterations;
    double throughput_mbps = (double)size / 1024.0 / 1024.0 / (avg_ms / 1000.0);

    printf("  DMA copy   %s: avg=%.3fms total=%.1fms throughput=%.0f MB/s\n",
           label, avg_ms, total_ms, throughput_mbps);

    // Verify DMA result
    hb_mem_invalidate_buf(dst_buf.fd, 0, size);
    if (memcmp(src_buf.virt_addr, dst_buf.virt_addr, size) != 0) {
        fprintf(stderr, "  [ERROR] DMA copy data mismatch!\n");
    } else {
        printf("  [DMA] Data verification: OK\n");
    }

    // Also benchmark: memcpy between hb_mem buffers (for fair comparison)
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < iterations; i++) {
        memcpy(dst_buf.virt_addr, src_buf.virt_addr, size);
    }
    clock_gettime(CLOCK_MONOTONIC, &end);

    total_ms = timespec_diff_ms(&start, &end);
    avg_ms = total_ms / iterations;
    throughput_mbps = (double)size / 1024.0 / 1024.0 / (avg_ms / 1000.0);

    printf("  memcpy(hb) %s: avg=%.3fms total=%.1fms throughput=%.0f MB/s\n",
           label, avg_ms, total_ms, throughput_mbps);

    hb_mem_free_buf(src_buf.fd);
    hb_mem_free_buf(dst_buf.fd);
    return 0;
}

int main(void) {
    printf("=== hb_mem DMA Copy Benchmark ===\n\n");

    // Initialize hb_mem module
    int32_t ret = hb_mem_module_open();
    if (ret != 0) {
        fprintf(stderr, "hb_mem_module_open failed: %d\n", ret);
        fprintf(stderr, "Make sure /dev/ion or /dev/hb_mem exists.\n");
        return 1;
    }
    printf("[OK] hb_mem_module_open succeeded\n\n");

    test_case_t cases[] = {
        {"MJPEG NV12 (640x480)",  640 * 480 * 3 / 2},     // 460KB
        {"1080p NV12 (1920x1080)", 1920 * 1080 * 3 / 2},  // 3.1MB
        {"H.264 typical (50KB)",  50 * 1024},              // 50KB
        {"Encoder pool (1080p Y)", 1920 * 1080},           // 2MB (Y plane only)
    };
    int num_cases = sizeof(cases) / sizeof(cases[0]);

    for (int c = 0; c < num_cases; c++) {
        printf("--- %s (%zu bytes, %d iterations) ---\n",
               cases[c].label, cases[c].size, ITERATIONS);

        bench_memcpy(cases[c].label, cases[c].size, ITERATIONS);
        bench_dma_copy(cases[c].label, cases[c].size, ITERATIONS);

        printf("\n");
    }

    hb_mem_module_close();
    printf("=== Benchmark complete ===\n");
    return 0;
}
