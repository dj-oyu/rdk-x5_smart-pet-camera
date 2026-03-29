/*
 * n2d_letterbox.c - GPU-accelerated letterbox using nano2D (GC820)
 *
 * Performs NV12 letterbox padding on GPU via n2d_fill + n2d_blit.
 * Zero-copy input from hbmem physical addresses via n2d_wrap.
 */

#include "n2d_letterbox.h"
#include "logger.h"
#include <stdlib.h>
#include <string.h>
#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"

struct n2d_letterbox_ctx {
    int src_w, src_h;
    int dst_w, dst_h;
    int pad_top;

    // nano2D destination buffer (persistent, reused across frames)
    n2d_buffer_t dst_buf;
    int initialized;
};

n2d_letterbox_ctx_t* n2d_letterbox_create(int src_w, int src_h, int dst_w, int dst_h) {
    n2d_letterbox_ctx_t* ctx = calloc(1, sizeof(n2d_letterbox_ctx_t));
    if (!ctx)
        return NULL;

    ctx->src_w = src_w;
    ctx->src_h = src_h;
    ctx->dst_w = dst_w;
    ctx->dst_h = dst_h;
    ctx->pad_top = (dst_h - src_h) / 2;

    // Initialize nano2D
    n2d_error_t err = n2d_open();
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Letterbox", "n2d_open failed: %d", err);
        free(ctx);
        return NULL;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    // Allocate persistent destination buffer (640x640 NV12)
    err = n2d_util_allocate_buffer(dst_w, dst_h, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE,
                                   &ctx->dst_buf);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Letterbox", "Failed to allocate dst buffer: %d", err);
        n2d_close();
        free(ctx);
        return NULL;
    }

    // Pre-fill with black (only need to do once since blit overwrites center)
    n2d_fill(&ctx->dst_buf, N2D_NULL, 0x00108080, N2D_BLEND_NONE);
    n2d_commit();

    ctx->initialized = 1;
    LOG_INFO("N2D_Letterbox", "Created: %dx%d -> %dx%d (pad_top=%d, GPU)", src_w, src_h, dst_w,
             dst_h, ctx->pad_top);

    return ctx;
}

int n2d_letterbox_process(n2d_letterbox_ctx_t* ctx, uint64_t src_phys_addr_y,
                          uint64_t src_phys_addr_uv, int src_stride, uint8_t** out_virt_addr,
                          size_t* out_size) {
    if (!ctx || !ctx->initialized || !out_virt_addr || !out_size)
        return -1;
    (void)src_phys_addr_uv; // UV is contiguous after Y in NV12
    (void)src_stride;       // stride computed from alignedw

    // Wrap hbmem physical address as nano2D source buffer (zero-copy)
    // Must set alignedw/alignedh/stride like zerocopy_bench.c
    n2d_buffer_t src_buf = {0};
    src_buf.width = ctx->src_w;
    src_buf.height = ctx->src_h;
    src_buf.format = N2D_NV12;
    src_buf.orientation = N2D_0;
    src_buf.srcType = N2D_SOURCE_DEFAULT;
    src_buf.tiling = N2D_LINEAR;
    src_buf.cacheMode = N2D_CACHE_128;
    src_buf.alignedw = gcmALIGN(src_buf.width, 64);
    src_buf.alignedh = src_buf.height;
    const float nv12_bpp = gcmALIGN(16, 8) * 1.0f / 8;
    src_buf.stride = gcmALIGN((int)(src_buf.alignedw * nv12_bpp), 64);

    n2d_user_memory_desc_t desc = {0};
    desc.flag = N2D_WRAP_FROM_USERMEMORY;
    desc.logical = 0;
    desc.physical = (n2d_uintptr_t)src_phys_addr_y;
    desc.size = src_buf.stride * src_buf.alignedh * 3 / 2;

    n2d_uintptr_t handle;
    n2d_error_t err = n2d_wrap(&desc, &handle);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Letterbox", "n2d_wrap failed: %d", err);
        return -1;
    }
    src_buf.handle = handle;

    err = n2d_map(&src_buf);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Letterbox", "n2d_map failed: %d", err);
        n2d_free(&src_buf);
        return -1;
    }

    // Blit source into center of destination (letterbox)
    n2d_rectangle_t dst_rect = {
        .x = 0,
        .y = ctx->pad_top,
        .width = ctx->src_w,
        .height = ctx->src_h,
    };

    err = n2d_blit(&ctx->dst_buf, &dst_rect, &src_buf, N2D_NULL, N2D_BLEND_NONE);
    if (N2D_IS_ERROR(err)) {
        LOG_ERROR("N2D_Letterbox", "n2d_blit failed: %d", err);
        n2d_free(&src_buf);
        return -1;
    }

    n2d_commit();

    // Free wrapped source (does not free the original hbmem buffer)
    n2d_free(&src_buf);

    // Return pointer to destination buffer
    *out_virt_addr = (uint8_t*)ctx->dst_buf.memory;
    *out_size = ctx->dst_w * ctx->dst_h * 3 / 2;

    return 0;
}

void n2d_letterbox_destroy(n2d_letterbox_ctx_t* ctx) {
    if (!ctx)
        return;

    if (ctx->initialized) {
        n2d_free(&ctx->dst_buf);
        n2d_close();
    }

    free(ctx);
    LOG_INFO("N2D_Letterbox", "Destroyed");
}
