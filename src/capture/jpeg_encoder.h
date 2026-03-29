/*
 * jpeg_encoder.h - Hardware JPEG Encoder Abstraction
 *
 * Hardware Abstraction Layer for D-Robotics JPEG Encoder
 * Manages multimedia codec API (hb_mm_mc_*) for hardware JPEG encoding
 * Used to accelerate MJPEG streaming from NV12 frames
 */

#ifndef JPEG_ENCODER_H
#define JPEG_ENCODER_H

#include <stdint.h>
#include <stddef.h>
#include "hb_media_codec.h"

/**
 * JPEG encoder context - encapsulates hardware JPEG encoder state
 */
typedef struct {
    media_codec_context_t codec_ctx;

    // Configuration
    int width;       // Frame width
    int height;      // Frame height
    int quality;     // JPEG quality (1-100)
    int initialized; // 1 if encoder is initialized and ready
} jpeg_encoder_context_t;

/**
 * Create and initialize hardware JPEG encoder
 *
 * Creates a JPEG encoder instance using D-Robotics hardware acceleration.
 * The encoder is configured for single-frame JPEG encoding from NV12 input.
 *
 * Args:
 *   ctx: Encoder context to initialize
 *   width: Frame width (e.g., 1920)
 *   height: Frame height (e.g., 1080)
 *   quality: JPEG quality factor (1-100, default 85 recommended)
 *            Higher = better quality, larger file
 *            Lower = more compression, smaller file
 *
 * Returns:
 *   0 on success, negative error code on failure
 *
 * Note:
 *   - Uses MEDIA_CODEC_ID_JPEG for single-frame encoding
 *   - Input format: NV12 (MC_PIXEL_FORMAT_NV12)
 *   - Thread-safe: Each thread should have its own context
 *   - Call jpeg_encoder_destroy() when done
 */
int jpeg_encoder_create(jpeg_encoder_context_t* ctx, int width, int height, int quality);

/**
 * Encode one NV12 frame to JPEG
 *
 * Takes NV12 frame data and produces JPEG bitstream using hardware encoder.
 * Blocks until encoding is complete or timeout occurs.
 *
 * Args:
 *   ctx: Encoder context (must be initialized)
 *   nv12_y: Pointer to Y plane data (width * height bytes)
 *   nv12_uv: Pointer to UV plane data (width * height / 2 bytes)
 *   jpeg_out: Output buffer for JPEG data (caller allocated)
 *   jpeg_size: Output size of JPEG data (bytes)
 *   max_size: Maximum size of output buffer
 *   timeout_ms: Timeout in milliseconds (recommended: 100ms)
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 *
 * Note:
 *   - Input must be NV12 format (Y plane + interleaved UV)
 *   - Output buffer must be large enough (recommend: width * height)
 *   - Typical encoding time: 3-8ms on RDK-X5 hardware
 *   - This function handles all buffer management internally
 */
int jpeg_encoder_encode_frame(jpeg_encoder_context_t* ctx, const uint8_t* nv12_y,
                              const uint8_t* nv12_uv, uint8_t* jpeg_out, size_t* jpeg_size,
                              size_t max_size, int timeout_ms);

/**
 * Destroy encoder and cleanup resources
 *
 * Stops encoder (if running) and releases all resources.
 * ctx becomes invalid after this call.
 *
 * Args:
 *   ctx: Encoder context
 */
void jpeg_encoder_destroy(jpeg_encoder_context_t* ctx);

#endif // JPEG_ENCODER_H
