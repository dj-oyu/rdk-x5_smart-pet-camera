/*
 * jpeg_encoder.c - Hardware JPEG Encoder Implementation
 *
 * Uses D-Robotics RDK-X5 hardware JPEG encoder for high-speed encoding.
 * Converts NV12 frames to JPEG with minimal CPU usage.
 */

#include "jpeg_encoder.h"
#include <stdio.h>
#include <string.h>
#include "logger.h"

int jpeg_encoder_create(jpeg_encoder_context_t* ctx, int width, int height, int quality) {
    int ret = 0;

    if (!ctx)
        return -1;

    memset(ctx, 0, sizeof(jpeg_encoder_context_t));

    ctx->width = width;
    ctx->height = height;
    ctx->quality = quality;

    media_codec_context_t* encoder = &ctx->codec_ctx;

    encoder->encoder = 1;
    encoder->codec_id = MEDIA_CODEC_ID_JPEG;
    encoder->instance_index = 0; // Use instance 0 for JPEG

    // Video encoder parameters for JPEG
    encoder->video_enc_params.width = width;
    encoder->video_enc_params.height = height;
    encoder->video_enc_params.pix_fmt = MC_PIXEL_FORMAT_NV12;

    // Buffer configuration
    // JPEG output can be up to the size of raw frame, align to 4096
    encoder->video_enc_params.bitstream_buf_size = ((width * height * 3 / 2) + 0xfff) & ~0xfff;
    encoder->video_enc_params.frame_buf_count = 3;
    encoder->video_enc_params.bitstream_buf_count = 3;

    // No GOP for JPEG (each frame is independent)
    encoder->video_enc_params.gop_params.gop_preset_idx = 0;
    encoder->video_enc_params.gop_params.decoding_refresh_type = 0;

    // Misc settings
    encoder->video_enc_params.rot_degree = 0;    // MC_CCW_0
    encoder->video_enc_params.mir_direction = 0; // MC_DIRECTION_NONE
    encoder->video_enc_params.frame_cropping_flag = 0;
    encoder->video_enc_params.enable_user_pts = 0;

    // JPEG-specific configuration
    encoder->video_enc_params.jpeg_enc_config.quality_factor = quality;
    encoder->video_enc_params.jpeg_enc_config.dcf_enable = 0;
    encoder->video_enc_params.jpeg_enc_config.restart_interval = 0;
    encoder->video_enc_params.jpeg_enc_config.huff_table_valid = 0;

    ret = hb_mm_mc_initialize(encoder);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_initialize failed: %d", ret);
        return ret;
    }

    ret = hb_mm_mc_configure(encoder);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_configure failed: %d", ret);
        hb_mm_mc_release(encoder);
        return ret;
    }

    mc_av_codec_startup_params_t startup_params = {0};
    ret = hb_mm_mc_start(encoder, &startup_params);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_start failed: %d", ret);
        hb_mm_mc_release(encoder);
        return ret;
    }

    ctx->initialized = 1;
    LOG_INFO("JPEGEncoder", "Created (JPEG %dx%d, quality=%d)", width, height, quality);

    return 0;
}

int jpeg_encoder_encode_frame(jpeg_encoder_context_t* ctx, const uint8_t* nv12_y,
                              const uint8_t* nv12_uv, uint8_t* jpeg_out, size_t* jpeg_size,
                              size_t max_size, int timeout_ms) {
    int ret = 0;

    if (!ctx || !ctx->initialized || !nv12_y || !nv12_uv || !jpeg_out || !jpeg_size) {
        return -1;
    }

    media_codec_buffer_t input_buffer = {0};
    media_codec_buffer_t output_buffer = {0};
    media_codec_output_buffer_info_t output_info = {0};

    // Dequeue encoder input buffer
    ret = hb_mm_mc_dequeue_input_buffer(&ctx->codec_ctx, &input_buffer, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_dequeue_input_buffer failed: %d", ret);
        return ret;
    }

    // Setup input buffer parameters
    input_buffer.type = MC_VIDEO_FRAME_BUFFER;
    input_buffer.vframe_buf.width = ctx->width;
    input_buffer.vframe_buf.height = ctx->height;
    input_buffer.vframe_buf.pix_fmt = MC_PIXEL_FORMAT_NV12;
    input_buffer.vframe_buf.size = ctx->width * ctx->height * 3 / 2;

    // Copy NV12 data to input buffer
    size_t y_size = ctx->width * ctx->height;
    size_t uv_size = ctx->width * ctx->height / 2;

    if (input_buffer.vframe_buf.vir_ptr[0]) {
        memcpy(input_buffer.vframe_buf.vir_ptr[0], nv12_y, y_size);
    } else {
        LOG_ERROR("JPEGEncoder", "Input buffer Y plane is NULL");
        return -1;
    }

    if (input_buffer.vframe_buf.vir_ptr[1]) {
        memcpy(input_buffer.vframe_buf.vir_ptr[1], nv12_uv, uv_size);
    } else {
        LOG_ERROR("JPEGEncoder", "Input buffer UV plane is NULL");
        return -1;
    }

    // Queue input buffer for encoding
    ret = hb_mm_mc_queue_input_buffer(&ctx->codec_ctx, &input_buffer, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_queue_input_buffer failed: %d", ret);
        return ret;
    }

    // Dequeue encoder output buffer
    ret = hb_mm_mc_dequeue_output_buffer(&ctx->codec_ctx, &output_buffer, &output_info, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_dequeue_output_buffer failed: %d", ret);
        return ret;
    }

    // Copy JPEG data to output buffer
    if (output_buffer.vstream_buf.vir_ptr && output_buffer.vstream_buf.size > 0) {
        if (output_buffer.vstream_buf.size <= max_size) {
            memcpy(jpeg_out, output_buffer.vstream_buf.vir_ptr, output_buffer.vstream_buf.size);
            *jpeg_size = output_buffer.vstream_buf.size;
        } else {
            LOG_ERROR("JPEGEncoder", "JPEG output size (%u) exceeds buffer size (%zu)",
                      output_buffer.vstream_buf.size, max_size);
            ret = -1;
        }
    } else {
        LOG_ERROR("JPEGEncoder", "Invalid output buffer");
        ret = -1;
    }

    // Release encoder output buffer
    int release_ret = hb_mm_mc_queue_output_buffer(&ctx->codec_ctx, &output_buffer, timeout_ms);
    if (release_ret != 0) {
        LOG_ERROR("JPEGEncoder", "hb_mm_mc_queue_output_buffer failed: %d", release_ret);
        // Don't override previous error if there was one
        if (ret == 0)
            ret = release_ret;
    }

    return ret;
}

void jpeg_encoder_destroy(jpeg_encoder_context_t* ctx) {
    if (!ctx)
        return;

    if (ctx->initialized) {
        hb_mm_mc_stop(&ctx->codec_ctx);
        hb_mm_mc_release(&ctx->codec_ctx);
        LOG_INFO("JPEGEncoder", "Destroyed");
    }

    memset(ctx, 0, sizeof(jpeg_encoder_context_t));
}
