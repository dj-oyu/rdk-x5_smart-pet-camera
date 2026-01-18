/*
 * encoder_lowlevel.h - Low-level H.264 Encoder Abstraction
 *
 * Hardware Abstraction Layer for D-Robotics H.264 Encoder
 * Manages multimedia codec API (hb_mm_mc_*) for H.264 encoding
 */

#ifndef ENCODER_LOWLEVEL_H
#define ENCODER_LOWLEVEL_H

#include <stdint.h>
#include <stddef.h>
#include "hb_media_codec.h"

/**
 * Encoder context - encapsulates H.264 encoder state
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
 * Create and initialize H.264 encoder
 *
 * Creates an H.264 encoder instance with CBR rate control.
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
 *   - Uses H.264 CBR mode with GOP preset 1
 *   - Buffer counts are set to 3 (required for X5 hardware)
 *   - HARDWARE LIMIT: Bitrate must be <= 700000 bps (700 kbps)
 *   - Exceeding this limit will cause encoder initialization to fail
 */
int encoder_create(encoder_context_t *ctx, int camera_index,
                   int width, int height, int fps, int bitrate);

/**
 * Encode one NV12 frame to H.264
 *
 * Takes NV12 frame data and produces H.264 bitstream.
 * Blocks until encoding is complete or timeout occurs.
 *
 * Args:
 *   ctx: Encoder context
 *   nv12_y: Pointer to Y plane data (width * height bytes)
 *   nv12_uv: Pointer to UV plane data (width * height / 2 bytes)
 *   h264_data_out: Output buffer for H.264 bitstream
 *   h264_size_out: Output size of H.264 data (bytes)
 *   max_size: Maximum size of output buffer
 *   timeout_ms: Timeout in milliseconds
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 *
 * Note:
 *   - Input must be NV12 format (Y plane + interleaved UV)
 *   - Output buffer must be large enough for one frame
 *   - Recommended buffer size: width * height * 3 / 2
 *   - This function handles all buffer management internally
 */
int encoder_encode_frame(encoder_context_t *ctx,
                         const uint8_t *nv12_y, const uint8_t *nv12_uv,
                         uint8_t *h264_data_out, size_t *h264_size_out,
                         size_t max_size, int timeout_ms);

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
