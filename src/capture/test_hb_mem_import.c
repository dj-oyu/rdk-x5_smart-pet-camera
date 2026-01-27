/**
 * test_hb_mem_import.c - Test program for hb_mem import APIs
 *
 * Reads ZeroCopyFrame from shared memory (requires camera daemon running),
 * dumps all hb_mem_graphic_buf_t fields, and tries multiple import API
 * approaches to diagnose which one works on this device.
 *
 * Usage:
 *   ./test_hb_mem_import [--night]
 *
 * Prerequisites:
 *   - camera_switcher_daemon + camera_daemon must be running
 *   - ZeroCopy SHM must be populated with at least one frame
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <semaphore.h>
#include <time.h>

#include "shared_memory.h"
#include "hb_mem_mgr.h"
#include "logger.h"

#define TAG "TestImport"

static void dump_graphic_buf(const hb_mem_graphic_buf_t *gb) {
    printf("=== hb_mem_graphic_buf_t DUMP (sizeof=%zu) ===\n", sizeof(*gb));
    printf("  fd[3]          = {%d, %d, %d}\n", gb->fd[0], gb->fd[1], gb->fd[2]);
    printf("  plane_cnt      = %d\n", gb->plane_cnt);
    printf("  format         = %d\n", gb->format);
    printf("  width          = %d\n", gb->width);
    printf("  height         = %d\n", gb->height);
    printf("  stride         = %d\n", gb->stride);
    printf("  vstride        = %d\n", gb->vstride);
    printf("  is_contig      = %d\n", gb->is_contig);
    printf("  share_id[3]    = {%d, %d, %d}\n",
           gb->share_id[0], gb->share_id[1], gb->share_id[2]);
    printf("  flags          = %ld\n", (long)gb->flags);
    printf("  size[3]        = {%lu, %lu, %lu}\n",
           (unsigned long)gb->size[0],
           (unsigned long)gb->size[1],
           (unsigned long)gb->size[2]);
    printf("  virt_addr[3]   = {0x%lx, 0x%lx, 0x%lx}\n",
           (unsigned long)gb->virt_addr[0],
           (unsigned long)gb->virt_addr[1],
           (unsigned long)gb->virt_addr[2]);
    printf("  phys_addr[3]   = {0x%lx, 0x%lx, 0x%lx}\n",
           (unsigned long)gb->phys_addr[0],
           (unsigned long)gb->phys_addr[1],
           (unsigned long)gb->phys_addr[2]);
    printf("  offset[3]      = {%lu, %lu, %lu}\n",
           (unsigned long)gb->offset[0],
           (unsigned long)gb->offset[1],
           (unsigned long)gb->offset[2]);
    printf("=== END DUMP ===\n\n");
}

static void dump_raw_hex(const uint8_t *data, size_t len) {
    printf("Raw hex dump (%zu bytes):\n", len);
    for (size_t i = 0; i < len; i += 16) {
        printf("  [%3zu] ", i);
        for (size_t j = i; j < i + 16 && j < len; j++) {
            printf("%02x ", data[j]);
        }
        printf("\n");
    }
    printf("\n");
}

static void dump_common_buf(const char *label, const hb_mem_common_buf_t *cb) {
    printf("  %s: fd=%d, share_id=%d, flags=%ld, size=%lu, "
           "virt_addr=0x%lx, phys_addr=0x%lx, offset=%lu\n",
           label, cb->fd, cb->share_id, (long)cb->flags,
           (unsigned long)cb->size,
           (unsigned long)cb->virt_addr,
           (unsigned long)cb->phys_addr,
           (unsigned long)cb->offset);
}

/**
 * Test A: hb_mem_import_graph_buf with fd/virt_addr cleared to 0
 */
static int test_import_graph_cleared(const hb_mem_graphic_buf_t *original) {
    printf("[Test A] hb_mem_import_graph_buf (fd=0, virt_addr=0)\n");

    hb_mem_graphic_buf_t in_buf;
    memcpy(&in_buf, original, sizeof(in_buf));

    // Clear process-local fields
    for (int i = 0; i < 3; i++) {
        in_buf.fd[i] = 0;
        in_buf.virt_addr[i] = 0;
    }

    hb_mem_graphic_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_graph_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_graphic_buf(&out_buf);

    // Verify we got valid data
    printf("  Output fd[0]=%d, virt_addr[0]=0x%lx, size[0]=%lu\n",
           out_buf.fd[0], (unsigned long)out_buf.virt_addr[0],
           (unsigned long)out_buf.size[0]);

    // Read first 16 bytes from Y plane to verify access
    if (out_buf.virt_addr[0] && out_buf.size[0] > 0) {
        uint8_t *data = (uint8_t *)out_buf.virt_addr[0];
        printf("  Y plane first 16 bytes: ");
        for (int i = 0; i < 16 && (size_t)i < out_buf.size[0]; i++) {
            printf("%02x ", data[i]);
        }
        printf("\n");
    }

    // Release
    for (int i = 0; i < out_buf.plane_cnt; i++) {
        if (out_buf.fd[i] > 0) {
            int free_ret = hb_mem_free_buf(out_buf.fd[i]);
            printf("  hb_mem_free_buf(fd=%d): ret=%d\n", out_buf.fd[i], free_ret);
        }
    }
    printf("\n");
    return 0;
}

/**
 * Test B: hb_mem_import_graph_buf with ALL original fields (no clearing)
 */
static int test_import_graph_original(const hb_mem_graphic_buf_t *original) {
    printf("[Test B] hb_mem_import_graph_buf (original fields, no clearing)\n");

    hb_mem_graphic_buf_t in_buf;
    memcpy(&in_buf, original, sizeof(in_buf));

    hb_mem_graphic_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_graph_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_graphic_buf(&out_buf);

    // Release
    for (int i = 0; i < out_buf.plane_cnt; i++) {
        if (out_buf.fd[i] > 0) {
            hb_mem_free_buf(out_buf.fd[i]);
        }
    }
    printf("\n");
    return 0;
}

/**
 * Test C: hb_mem_import_com_buf with share_id[0] only
 */
static int test_import_com_share_id_only(const hb_mem_graphic_buf_t *original) {
    printf("[Test C] hb_mem_import_com_buf (share_id=%d, other fields zeroed)\n",
           original->share_id[0]);

    hb_mem_common_buf_t in_buf;
    memset(&in_buf, 0, sizeof(in_buf));
    in_buf.share_id = original->share_id[0];

    hb_mem_common_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_com_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n", ret);
        // Try with size set
        printf("  Retrying with size=%lu...\n",
               (unsigned long)(original->size[0] + original->size[1]));
        in_buf.size = original->size[0] + original->size[1];
        ret = hb_mem_import_com_buf(&in_buf, &out_buf);
        if (ret != 0) {
            printf("  FAILED again: ret=%d\n\n", ret);
            return -1;
        }
    }

    printf("  SUCCESS!\n");
    dump_common_buf("out_buf", &out_buf);

    // Verify data access
    if (out_buf.virt_addr && out_buf.size > 0) {
        uint8_t *data = (uint8_t *)out_buf.virt_addr;
        printf("  First 16 bytes: ");
        for (int i = 0; i < 16 && (size_t)i < out_buf.size; i++) {
            printf("%02x ", data[i]);
        }
        printf("\n");
    }

    // Release
    if (out_buf.fd > 0) {
        int free_ret = hb_mem_free_buf(out_buf.fd);
        printf("  hb_mem_free_buf(fd=%d): ret=%d\n", out_buf.fd, free_ret);
    }
    printf("\n");
    return 0;
}

/**
 * Test D: hb_mem_import_com_buf with share_id + phys_addr + size
 */
static int test_import_com_with_phys(const hb_mem_graphic_buf_t *original) {
    printf("[Test D] hb_mem_import_com_buf (share_id=%d, phys_addr=0x%lx, size=%lu)\n",
           original->share_id[0],
           (unsigned long)original->phys_addr[0],
           (unsigned long)(original->size[0] + original->size[1]));

    hb_mem_common_buf_t in_buf;
    memset(&in_buf, 0, sizeof(in_buf));
    in_buf.share_id = original->share_id[0];
    in_buf.phys_addr = original->phys_addr[0];
    in_buf.size = original->size[0] + original->size[1];

    hb_mem_common_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_com_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_common_buf("out_buf", &out_buf);

    if (out_buf.fd > 0) {
        hb_mem_free_buf(out_buf.fd);
    }
    printf("\n");
    return 0;
}

/**
 * Test E: hb_mem_import_com_buf per-plane (separate Y and UV)
 */
static int test_import_com_per_plane(const hb_mem_graphic_buf_t *original) {
    printf("[Test E] hb_mem_import_com_buf per-plane\n");

    for (int plane = 0; plane < original->plane_cnt && plane < 2; plane++) {
        printf("  Plane %d: share_id=%d, phys_addr=0x%lx, size=%lu\n",
               plane, original->share_id[plane],
               (unsigned long)original->phys_addr[plane],
               (unsigned long)original->size[plane]);

        if (original->share_id[plane] == 0 && plane > 0) {
            printf("  Plane %d: share_id=0 (contiguous with plane 0), skipping\n", plane);
            continue;
        }

        hb_mem_common_buf_t in_buf;
        memset(&in_buf, 0, sizeof(in_buf));
        in_buf.share_id = original->share_id[plane];
        in_buf.size = original->size[plane];
        in_buf.phys_addr = original->phys_addr[plane];

        hb_mem_common_buf_t out_buf;
        memset(&out_buf, 0, sizeof(out_buf));

        int ret = hb_mem_import_com_buf(&in_buf, &out_buf);
        if (ret != 0) {
            printf("  Plane %d FAILED: ret=%d\n", plane, ret);
            // Retry with only share_id
            memset(&in_buf, 0, sizeof(in_buf));
            in_buf.share_id = original->share_id[plane];
            ret = hb_mem_import_com_buf(&in_buf, &out_buf);
            if (ret != 0) {
                printf("  Plane %d FAILED (share_id only): ret=%d\n", plane, ret);
                continue;
            }
        }

        printf("  Plane %d SUCCESS!\n", plane);
        dump_common_buf("  out_buf", &out_buf);

        if (out_buf.fd > 0) {
            hb_mem_free_buf(out_buf.fd);
        }
    }
    printf("\n");
    return 0;
}

/**
 * Test F: hb_mem_import_graph_buf with fd set to -1 (invalid fd sentinel)
 */
static int test_import_graph_fd_minus1(const hb_mem_graphic_buf_t *original) {
    printf("[Test F] hb_mem_import_graph_buf (fd=-1, virt_addr=0)\n");

    hb_mem_graphic_buf_t in_buf;
    memcpy(&in_buf, original, sizeof(in_buf));

    for (int i = 0; i < 3; i++) {
        in_buf.fd[i] = -1;
        in_buf.virt_addr[i] = 0;
    }

    hb_mem_graphic_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_graph_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_graphic_buf(&out_buf);

    for (int i = 0; i < out_buf.plane_cnt; i++) {
        if (out_buf.fd[i] > 0) {
            hb_mem_free_buf(out_buf.fd[i]);
        }
    }
    printf("\n");
    return 0;
}

/**
 * Test G: hb_mem_import_graph_buf minimal (only share_id + plane_cnt + size)
 */
static int test_import_graph_minimal(const hb_mem_graphic_buf_t *original) {
    printf("[Test G] hb_mem_import_graph_buf (minimal: share_id + plane_cnt + size only)\n");

    hb_mem_graphic_buf_t in_buf;
    memset(&in_buf, 0, sizeof(in_buf));

    // Copy only the minimum fields
    in_buf.plane_cnt = original->plane_cnt;
    for (int i = 0; i < 3; i++) {
        in_buf.share_id[i] = original->share_id[i];
        in_buf.size[i] = original->size[i];
        in_buf.fd[i] = -1;  // Invalid fd sentinel
    }

    hb_mem_graphic_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_graph_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_graphic_buf(&out_buf);

    for (int i = 0; i < out_buf.plane_cnt; i++) {
        if (out_buf.fd[i] > 0) {
            hb_mem_free_buf(out_buf.fd[i]);
        }
    }
    printf("\n");
    return 0;
}

/**
 * Test H: hb_mem_import_graph_buf with phys_addr also cleared
 */
static int test_import_graph_clear_all_local(const hb_mem_graphic_buf_t *original) {
    printf("[Test H] hb_mem_import_graph_buf (fd=0, virt_addr=0, phys_addr=0, offset=0)\n");

    hb_mem_graphic_buf_t in_buf;
    memcpy(&in_buf, original, sizeof(in_buf));

    for (int i = 0; i < 3; i++) {
        in_buf.fd[i] = 0;
        in_buf.virt_addr[i] = 0;
        in_buf.phys_addr[i] = 0;
        in_buf.offset[i] = 0;
    }

    hb_mem_graphic_buf_t out_buf;
    memset(&out_buf, 0, sizeof(out_buf));

    int ret = hb_mem_import_graph_buf(&in_buf, &out_buf);
    if (ret != 0) {
        printf("  FAILED: ret=%d\n\n", ret);
        return -1;
    }

    printf("  SUCCESS!\n");
    dump_graphic_buf(&out_buf);

    for (int i = 0; i < out_buf.plane_cnt; i++) {
        if (out_buf.fd[i] > 0) {
            hb_mem_free_buf(out_buf.fd[i]);
        }
    }
    printf("\n");
    return 0;
}

int main(int argc, char *argv[]) {
    log_init(LOG_LEVEL_DEBUG, stdout, 0);

    int use_night = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--night") == 0) {
            use_night = 1;
        }
    }

    const char *shm_name = use_night ? SHM_NAME_ZEROCOPY_NIGHT : SHM_NAME_ZEROCOPY_DAY;
    printf("=== hb_mem Import API Test ===\n");
    printf("Using ZeroCopy SHM: %s\n\n", shm_name);

    // Initialize hb_mem module
    int ret = hb_mem_module_open();
    if (ret != 0) {
        printf("FATAL: hb_mem_module_open failed: %d\n", ret);
        return 1;
    }
    printf("hb_mem module initialized\n\n");

    // Open ZeroCopy shared memory
    ZeroCopyFrameBuffer *zc_shm = shm_zerocopy_open(shm_name);
    if (!zc_shm) {
        printf("FATAL: Failed to open ZeroCopy SHM: %s\n", shm_name);
        printf("Make sure camera daemon is running.\n");
        hb_mem_module_close();
        return 1;
    }
    printf("Opened ZeroCopy SHM: %s\n", shm_name);

    // Wait for a frame (with timeout)
    printf("Waiting for frame (5 second timeout)...\n");
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 5;

    ret = sem_timedwait(&zc_shm->new_frame_sem, &ts);
    if (ret != 0) {
        printf("FATAL: Timed out waiting for frame from camera daemon\n");
        shm_zerocopy_close(zc_shm);
        hb_mem_module_close();
        return 1;
    }

    // Read frame metadata
    ZeroCopyFrame *frame = &zc_shm->frame;
    printf("\nFrame received:\n");
    printf("  frame_number   = %lu\n", (unsigned long)frame->frame_number);
    printf("  camera_id      = %d\n", frame->camera_id);
    printf("  width          = %d\n", frame->width);
    printf("  height         = %d\n", frame->height);
    printf("  format         = %d\n", frame->format);
    printf("  plane_cnt      = %d\n", frame->plane_cnt);
    printf("  share_id       = {%d, %d}\n", frame->share_id[0], frame->share_id[1]);
    printf("  plane_size     = {%lu, %lu}\n",
           (unsigned long)frame->plane_size[0],
           (unsigned long)frame->plane_size[1]);
    printf("  version        = %u\n", frame->version);
    printf("  consumed       = %u\n", frame->consumed);
    printf("\n");

    // Extract hb_mem_graphic_buf_t from raw bytes
    _Static_assert(sizeof(hb_mem_graphic_buf_t) == HB_MEM_GRAPHIC_BUF_SIZE,
        "Size mismatch");

    hb_mem_graphic_buf_t original_buf;
    memcpy(&original_buf, frame->hb_mem_buf_data, sizeof(original_buf));

    // Dump the original buffer
    printf("=== Original buffer from producer (C-side values) ===\n");
    dump_graphic_buf(&original_buf);

    // Also dump raw hex
    dump_raw_hex(frame->hb_mem_buf_data, HB_MEM_GRAPHIC_BUF_SIZE);

    // ========================================================================
    // Run all test variants
    // ========================================================================
    int results[8] = {0};
    int num_tests = 0;

    printf("========================================\n");
    printf("Running import API tests...\n");
    printf("========================================\n\n");

    results[num_tests++] = test_import_graph_cleared(&original_buf);
    results[num_tests++] = test_import_graph_original(&original_buf);
    results[num_tests++] = test_import_com_share_id_only(&original_buf);
    results[num_tests++] = test_import_com_with_phys(&original_buf);
    results[num_tests++] = test_import_com_per_plane(&original_buf);
    results[num_tests++] = test_import_graph_fd_minus1(&original_buf);
    results[num_tests++] = test_import_graph_minimal(&original_buf);
    results[num_tests++] = test_import_graph_clear_all_local(&original_buf);

    // Signal consumed so camera daemon can continue
    frame->consumed = 1;
    sem_post(&zc_shm->consumed_sem);

    // ========================================================================
    // Summary
    // ========================================================================
    printf("========================================\n");
    printf("SUMMARY\n");
    printf("========================================\n");
    const char *test_names[] = {
        "A: import_graph_buf (fd=0, vaddr=0)",
        "B: import_graph_buf (original, no clearing)",
        "C: import_com_buf (share_id only)",
        "D: import_com_buf (share_id + phys + size)",
        "E: import_com_buf (per-plane)",
        "F: import_graph_buf (fd=-1, vaddr=0)",
        "G: import_graph_buf (minimal: share_id+cnt+size)",
        "H: import_graph_buf (clear fd+vaddr+phys+offset)",
    };
    int pass_count = 0;
    for (int i = 0; i < num_tests; i++) {
        printf("  [%s] %s\n", results[i] == 0 ? "PASS" : "FAIL", test_names[i]);
        if (results[i] == 0) pass_count++;
    }
    printf("\n%d/%d tests passed\n", pass_count, num_tests);

    // Cleanup
    shm_zerocopy_close(zc_shm);
    hb_mem_module_close();

    printf("\nDone.\n");
    return (pass_count > 0) ? 0 : 1;
}
