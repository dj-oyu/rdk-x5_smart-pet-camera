/*
 * n2d_letterbox.h - GPU-accelerated letterbox using nano2D (GC820)
 *
 * Performs NV12 letterbox padding on GPU, freeing CPU for other tasks.
 * Input: 640x360 NV12 → Output: 640x640 NV12 with black bars.
 */

#ifndef N2D_LETTERBOX_H
#define N2D_LETTERBOX_H

#include <stdint.h>
#include <hb_mem_mgr.h>

typedef struct n2d_letterbox_ctx n2d_letterbox_ctx_t;

/**
 * Initialize nano2D letterbox context
 *
 * Args:
 *   src_w, src_h: Input dimensions (e.g., 640x360)
 *   dst_w, dst_h: Output dimensions (e.g., 640x640)
 *
 * Returns:
 *   Context pointer on success, NULL on failure
 */
n2d_letterbox_ctx_t* n2d_letterbox_create(int src_w, int src_h, int dst_w, int dst_h);

/**
 * Process a frame: letterbox with zero-copy from hbmem buffer
 *
 * Takes physical address of VSE output and produces letterboxed 640x640 NV12.
 * The output buffer is owned by the context (reused across frames).
 *
 * Args:
 *   ctx: Letterbox context
 *   src_phys_addr_y: Physical address of input Y plane
 *   src_phys_addr_uv: Physical address of input UV plane
 *   src_stride: Input stride (may differ from src_w due to alignment)
 *   out_virt_addr: Output pointer to letterboxed NV12 data (owned by ctx)
 *   out_size: Output data size
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int n2d_letterbox_process(n2d_letterbox_ctx_t* ctx, uint64_t src_phys_addr_y,
                          uint64_t src_phys_addr_uv, int src_stride, uint8_t** out_virt_addr,
                          size_t* out_size);

/**
 * Destroy letterbox context and free GPU resources
 */
void n2d_letterbox_destroy(n2d_letterbox_ctx_t* ctx);

#endif // N2D_LETTERBOX_H
