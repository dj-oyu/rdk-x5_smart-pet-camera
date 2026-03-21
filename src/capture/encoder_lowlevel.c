/*
 * encoder_lowlevel.c - Low-level H.265 Encoder Implementation
 */

#include "encoder_lowlevel.h"
#include <stdio.h>
#include <string.h>
#include <hb_mem_mgr.h>
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
    encoder->codec_id = MEDIA_CODEC_ID_H265;
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

    // H.265 CBR rate control
    encoder->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H265CBR;
    encoder->video_enc_params.rc_params.h265_cbr_params.intra_period = fps;
    encoder->video_enc_params.rc_params.h265_cbr_params.intra_qp = 30;
    encoder->video_enc_params.rc_params.h265_cbr_params.bit_rate = bitrate;
    encoder->video_enc_params.rc_params.h265_cbr_params.frame_rate = fps;
    encoder->video_enc_params.rc_params.h265_cbr_params.initial_rc_qp = 20;
    encoder->video_enc_params.rc_params.h265_cbr_params.vbv_buffer_size = 20;
    encoder->video_enc_params.rc_params.h265_cbr_params.ctu_level_rc_enalbe = 1;
    encoder->video_enc_params.rc_params.h265_cbr_params.min_qp_I = 8;
    encoder->video_enc_params.rc_params.h265_cbr_params.max_qp_I = 50;
    encoder->video_enc_params.rc_params.h265_cbr_params.min_qp_P = 8;
    encoder->video_enc_params.rc_params.h265_cbr_params.max_qp_P = 50;
    encoder->video_enc_params.rc_params.h265_cbr_params.min_qp_B = 8;
    encoder->video_enc_params.rc_params.h265_cbr_params.max_qp_B = 50;
    encoder->video_enc_params.rc_params.h265_cbr_params.hvs_qp_enable = 1;
    encoder->video_enc_params.rc_params.h265_cbr_params.hvs_qp_scale = 2;
    encoder->video_enc_params.rc_params.h265_cbr_params.max_delta_qp = 10;
    encoder->video_enc_params.rc_params.h265_cbr_params.qp_map_enable = 0;

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

    LOG_INFO("Encoder", "Created (H.265 CBR %dx%d @ %dfps, %dkbps)",
             width, height, fps, bitrate / 1000);

    return 0;
}

int encoder_encode_frame_zerocopy(encoder_context_t *ctx,
                                  const uint8_t *nv12_y, const uint8_t *nv12_uv,
                                  size_t y_size, size_t uv_size,
                                  int timeout_ms,
                                  encoder_output_t *out) {
    int ret = 0;

    if (!ctx || !nv12_y || !nv12_uv || !out) {
        return -1;
    }

    memset(out, 0, sizeof(encoder_output_t));

    media_codec_buffer_t input_buffer = {0};
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

    // memcpy NV12 to VPU input buffer (unavoidable — VPU owns input buffers)
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

    // Dequeue encoder output buffer (DO NOT release — caller owns it)
    ret = hb_mm_mc_dequeue_output_buffer(&ctx->codec_ctx, &out->output_buffer,
                                          &output_info, timeout_ms);
    if (ret != 0) {
        LOG_ERROR("Encoder", "hb_mm_mc_dequeue_output_buffer failed: %d", ret);
        return ret;
    }

    // Fill output info
    out->vir_ptr = out->output_buffer.vstream_buf.vir_ptr;
    out->data_size = out->output_buffer.vstream_buf.size;

    // Get full buffer descriptor for cross-process import (same pattern as Python)
    if (out->vir_ptr) {
        hb_mem_common_buf_t com_buf = {0};
        if (hb_mem_get_com_buf_with_vaddr((uint64_t)out->vir_ptr, &com_buf) == 0) {
            memcpy(out->com_buf_data, &com_buf, sizeof(com_buf));
        }
    }

    // Extract VPU encoder statistics
    out->stats.intra_block_num = output_info.video_stream_info.intra_block_num;
    out->stats.skip_block_num = output_info.video_stream_info.skip_block_num;
    out->stats.avg_mb_qp = output_info.video_stream_info.avg_mb_qp;
    out->stats.enc_pic_byte = output_info.video_stream_info.enc_pic_byte;

    return 0;
}

int encoder_release_output(encoder_context_t *ctx,
                           encoder_output_t *out,
                           int timeout_ms) {
    if (!ctx || !out) return -1;
    return hb_mm_mc_queue_output_buffer(&ctx->codec_ctx, &out->output_buffer, timeout_ms);
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
