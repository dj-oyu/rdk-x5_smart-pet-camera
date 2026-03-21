/*
 * encoder_lowlevel.h - Low-level H.265 Encoder Abstraction
 *
 * Hardware Abstraction Layer for D-Robotics H.265 Encoder
 * Manages multimedia codec API (hb_mm_mc_*) for H.265 encoding
 */

#ifndef ENCODER_LOWLEVEL_H
#define ENCODER_LOWLEVEL_H

#include <stdint.h>
#include <stddef.h>
#include "hb_media_codec.h"

/**
 * Encoder context - encapsulates H.265 encoder state
 */
typedef struct {
    media_codec_context_t codec_ctx;

    // Configuration
    int camera_index;      // Camera index (for multi-instance)
    int width;             // Frame width
    int height;            // Frame height
    int fps;               // Target frame rate
    int bitrate;           // Target bitrate (bps)
} encoder_context_t;

/**
 * Create and initialize H.265 encoder
 *
 * Creates an H.265 encoder instance with CBR rate control.
 * Configures GOP, buffer counts, and rate control parameters.
 *
 * Args:
 *   ctx: Encoder context to initialize
 *   camera_index: Camera/instance index (0 or 1)
 *   width: Frame width (e.g., 1920)
 *   height: Frame height (e.g., 1080)
 *   fps: Target frame rate (e.g., 30)
 *   bitrate: Target bitrate in bps (MAX: 700000 bps / 700 kbps)
 *
 * Returns:
 *   0 on success, negative error code on failure
 *
 * Note:
 *   - Automatically starts the encoder (ready to encode immediately)
 *   - Uses H.265 CBR mode with GOP preset 1
 *   - Buffer counts are set to 3 (required for X5 hardware)
 *   - HARDWARE LIMIT: Bitrate must be <= 700000 bps (700 kbps)
 *   - Exceeding this limit will cause encoder initialization to fail
 */
int encoder_create(encoder_context_t *ctx, int camera_index,
                   int width, int height, int fps, int bitrate);

/**
 * Encode one NV12 frame to H.265 (zero-copy, physical address input)
 *
 * Takes physical addresses of NV12 planes and produces H.265 bitstream.
 * The VPU reads directly from the physical addresses — no memcpy required.
 *
 * Args:
 *   ctx: Encoder context
 *   phys_addr_y: Physical address of Y plane
 *   phys_addr_uv: Physical address of UV plane
 *   h265_data_out: Output buffer for H.265 bitstream
 *   h265_size_out: Output size of H.265 data (bytes)
 *   max_size: Maximum size of output buffer
 *   timeout_ms: Timeout in milliseconds
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 */
/**
 * VPU encoder statistics (per-frame, from output_info)
 */
typedef struct {
    uint32_t intra_block_num;  // Blocks encoded as intra (8x8 units)
    uint32_t skip_block_num;   // Blocks skipped (no change)
    uint32_t avg_mb_qp;       // Average macroblock QP
    uint32_t enc_pic_byte;    // Encoded frame size (bytes)
} encoder_stats_t;

int encoder_encode_frame_vaddr(encoder_context_t *ctx,
                               const uint8_t *nv12_y, const uint8_t *nv12_uv,
                               size_t y_size, size_t uv_size,
                               uint8_t *h265_data_out, size_t *h265_size_out,
                               size_t max_size, int timeout_ms,
                               encoder_stats_t *stats_out);

/**
 * Stop encoder
 *
 * Stops the encoder but preserves context.
 * Can be restarted if needed (though not currently implemented).
 *
 * Args:
 *   ctx: Encoder context
 */
void encoder_stop(encoder_context_t *ctx);

/**
 * Destroy encoder and cleanup resources
 *
 * Stops encoder (if running) and releases all resources.
 * ctx becomes invalid after this call.
 *
 * Args:
 *   ctx: Encoder context
 */
void encoder_destroy(encoder_context_t *ctx);

#endif // ENCODER_LOWLEVEL_H
