/*
 * encoder_lowlevel.c - Low-level H.264 Encoder Implementation
 */

#include "encoder_lowlevel.h"
#include <stdio.h>
#include <string.h>
#include "logger.h"

int encoder_create(encoder_context_t *ctx, int camera_index,
                   int width, int height, int fps, int bitrate) {
    int ret = 0;

    if (!ctx) return -1;

    memset(ctx, 0, sizeof(encoder_context_t));

    ctx->camera_index = camera_index;
    ctx->width = width;
    ctx->height = height;
    ctx->fps = fps;
    ctx->bitrate = bitrate;

    media_codec_context_t *encoder = &ctx->codec_ctx;

    encoder->encoder = 1;
    encoder->codec_id = MEDIA_CODEC_ID_H264;
    encoder->instance_index = camera_index;

    // Video encoder parameters
    encoder->video_enc_params.width = width;
    encoder->video_enc_params.height = height;
    encoder->video_enc_params.pix_fmt = MC_PIXEL_FORMAT_NV12;

    // Buffer configuration (CRITICAL for encoder to work!)
    encoder->video_enc_params.bitstream_buf_size = (width * height * 3 / 2 + 0x3ff) & ~0x3ff;
    encoder->video_enc_params.frame_buf_count = 3;
    encoder->video_enc_params.bitstream_buf_count = 3;

    // GOP configuration (required for X5 hardware)
    encoder->video_enc_params.gop_params.gop_preset_idx = 1;
    encoder->video_enc_params.gop_params.decoding_refresh_type = 2;

    // Misc settings
    encoder->video_enc_params.rot_degree = 0;  // MC_CCW_0
    encoder->video_enc_params.mir_direction = 0;  // MC_DIRECTION_NONE
    encoder->video_enc_params.frame_cropping_flag = 0;
    encoder->video_enc_params.enable_user_pts = 1;

    // H.264 CBR rate control
    encoder->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H264CBR;
    encoder->video_enc_params.rc_params.h264_cbr_params.intra_period = fps;
    encoder->video_enc_params.rc_params.h264_cbr_params.intra_qp = 30;
    encoder->video_enc_params.rc_params.h264_cbr_params.bit_rate = bitrate;
    encoder->video_enc_params.rc_params.h264_cbr_params.frame_rate = fps;
    encoder->video_enc_params.rc_params.h264_cbr_params.initial_rc_qp = 20;
    encoder->video_enc_params.rc_params.h264_cbr_params.vbv_buffer_size = 20;
    encoder->video_enc_params.rc_params.h264_cbr_params.mb_level_rc_enalbe = 1;
    encoder->video_enc_params.rc_params.h264_cbr_params.min_qp_I = 8;
    encoder->video_enc_params.rc_params.h264_cbr_params.max_qp_I = 50;
    encoder->video_enc_params.rc_params.h264_cbr_params.min_qp_P = 8;
    encoder->video_enc_params.rc_params.h264_cbr_params.max_qp_P = 50;
    encoder->video_enc_params.rc_params.h264_cbr_params.min_qp_B = 8;
    encoder->video_enc_params.rc_params.h264_cbr_params.max_qp_B = 50;
    encoder->video_enc_params.rc_params.h264_cbr_params.hvs_qp_enable = 1;
    encoder->video_enc_params.rc_params.h264_cbr_params.hvs_qp_scale = 2;
    encoder->video_enc_params.rc_params.h264_cbr_params.max_delta_qp = 10;
    encoder->video_enc_params.rc_params.h264_cbr_params.qp_map_enable = 0;

    ret = hb_mm_mc_initialize(encoder);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_initialize failed: %d", ret);
        return ret;
    }

    ret = hb_mm_mc_configure(encoder);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_configure failed: %d", ret);
        hb_mm_mc_release(encoder);
        return ret;
    }

    mc_av_codec_startup_params_t startup_params = {0};
    ret = hb_mm_mc_start(encoder, &startup_params);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_start failed: %d", ret);
        hb_mm_mc_release(encoder);
        return ret;
    }

    LOG_INFO("Encoder", "Created (H.264 CBR %dx%d @ %dfps, %dkbps)",
             width, height, fps, bitrate / 1000);

    return 0;
}

int encoder_encode_frame(encoder_context_t *ctx,
                         const uint8_t *nv12_y, const uint8_t *nv12_uv,
                         uint8_t *h264_data_out, size_t *h264_size_out,
                         size_t max_size, int timeout_ms) {
    int ret = 0;

    if (!ctx || !nv12_y || !nv12_uv || !h264_data_out || !h264_size_out) {
        return -1;
    }

    media_codec_buffer_t input_buffer = {0};
    media_codec_buffer_t output_buffer = {0};
    media_codec_output_buffer_info_t output_info = {0};

    // Dequeue encoder input buffer
    ret = hb_mm_mc_dequeue_input_buffer(&ctx->codec_ctx, &input_buffer, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_dequeue_input_buffer failed: %d", ret);
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
        LOG_ERROR("Encoder", "Input buffer Y plane is NULL");
        return -1;
    }

    if (input_buffer.vframe_buf.vir_ptr[1]) {
        memcpy(input_buffer.vframe_buf.vir_ptr[1], nv12_uv, uv_size);
    } else {
        LOG_ERROR("Encoder", "Input buffer UV plane is NULL");
        return -1;
    }

    // Queue input buffer for encoding
    ret = hb_mm_mc_queue_input_buffer(&ctx->codec_ctx, &input_buffer, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_queue_input_buffer failed: %d", ret);
        return ret;
    }

    // Dequeue encoder output buffer
    ret = hb_mm_mc_dequeue_output_buffer(&ctx->codec_ctx, &output_buffer, &output_info, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_dequeue_output_buffer failed: %d", ret);
        return ret;
    }

    // Copy H.264 data to output buffer
    if (output_buffer.vstream_buf.vir_ptr && output_buffer.vstream_buf.size > 0) {
        if (output_buffer.vstream_buf.size <= max_size) {
            memcpy(h264_data_out, output_buffer.vstream_buf.vir_ptr, output_buffer.vstream_buf.size);
            *h264_size_out = output_buffer.vstream_buf.size;
        } else {
            LOG_ERROR("Encoder", "H.264 output size (%u) exceeds buffer size (%zu)",
                      output_buffer.vstream_buf.size, max_size);
            ret = -1;
        }
    } else {
        LOG_ERROR("Encoder", "Invalid output buffer");
        ret = -1;
    }

    // Release encoder output buffer
    int release_ret = hb_mm_mc_queue_output_buffer(&ctx->codec_ctx, &output_buffer, timeout_ms);
    if (release_ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_queue_output_buffer failed: %d", release_ret);
        // Don't override previous error if there was one
        if (ret == 0) ret = release_ret;
    }

    return ret;
}

void encoder_stop(encoder_context_t *ctx) {
    if (!ctx) return;

    if (ctx->codec_ctx.encoder) {
        hb_mm_mc_stop(&ctx->codec_ctx);
        LOG_INFO("Encoder", "Stopped");
    }
}

void encoder_destroy(encoder_context_t *ctx) {
    if (!ctx) return;

    if (ctx->codec_ctx.encoder) {
        hb_mm_mc_stop(&ctx->codec_ctx);
        hb_mm_mc_release(&ctx->codec_ctx);
    }

    memset(ctx, 0, sizeof(encoder_context_t));
    LOG_INFO("Encoder", "Destroyed");
}
