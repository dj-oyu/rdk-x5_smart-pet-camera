/*
 * H.264 vs H.265 HW Encoder: Fixed QP Comparison
 * Same quality (QP) → compare output size to measure compression efficiency
 * Also tests CBR at realistic bitrates (2-8 Mbps)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "hb_media_codec.h"
#include "hb_media_error.h"

typedef struct { media_codec_context_t ctx; int initialized; } encoder_ctx_t;

static uint32_t xor_state = 1;
static inline int fast_noise(int range) {
    xor_state ^= xor_state << 13; xor_state ^= xor_state >> 17; xor_state ^= xor_state << 5;
    return (int)(xor_state % (2*range+1)) - range;
}
static void add_grain(const uint8_t *base, uint8_t *out, int size, int frame, int grain) {
    xor_state = frame * 2654435761u + 1;
    for (int i = 0; i < size; i++) {
        int v = (int)base[i] + fast_noise(grain);
        out[i] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
    }
}

static int create_encoder_fixqp(encoder_ctx_t *enc, int codec_id, int w, int h, int qp, int fps) {
    memset(enc, 0, sizeof(encoder_ctx_t));
    media_codec_context_t *ctx = &enc->ctx;
    ctx->encoder = 1; ctx->codec_id = codec_id;
    ctx->instance_index = (codec_id == MEDIA_CODEC_ID_H265) ? 1 : 0;
    ctx->video_enc_params.width = w; ctx->video_enc_params.height = h;
    ctx->video_enc_params.pix_fmt = MC_PIXEL_FORMAT_NV12;
    ctx->video_enc_params.bitstream_buf_size = w * h;
    ctx->video_enc_params.frame_buf_count = 3; ctx->video_enc_params.bitstream_buf_count = 3;
    ctx->video_enc_params.gop_params.gop_preset_idx = 1;
    ctx->video_enc_params.gop_params.decoding_refresh_type = 2;
    ctx->video_enc_params.rot_degree = MC_CCW_0; ctx->video_enc_params.mir_direction = MC_DIRECTION_NONE;

    if (codec_id == MEDIA_CODEC_ID_H264) {
        ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H264FIXQP;
        mc_h264_fix_qp_params_t *p = &ctx->video_enc_params.rc_params.h264_fixqp_params;
        p->intra_period = fps; p->frame_rate = fps;
        p->force_qp_I = qp; p->force_qp_P = qp; p->force_qp_B = qp + 2;
    } else {
        ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H265FIXQP;
        mc_h265_fix_qp_params_t *p = &ctx->video_enc_params.rc_params.h265_fixqp_params;
        p->intra_period = fps; p->frame_rate = fps;
        p->force_qp_I = qp; p->force_qp_P = qp; p->force_qp_B = qp + 2;
    }

    int ret = hb_mm_mc_initialize(ctx);
    if (ret != 0) { printf("  init failed: %d\n", ret); return ret; }
    ret = hb_mm_mc_configure(ctx);
    if (ret != 0) { printf("  config failed: %d\n", ret); hb_mm_mc_release(ctx); return ret; }
    mc_av_codec_startup_params_t sp = {0};
    ret = hb_mm_mc_start(ctx, &sp);
    if (ret != 0) { printf("  start failed: %d\n", ret); hb_mm_mc_release(ctx); return ret; }
    enc->initialized = 1;
    return 0;
}

static int create_encoder_cbr(encoder_ctx_t *enc, int codec_id, int w, int h, int bitrate, int fps) {
    memset(enc, 0, sizeof(encoder_ctx_t));
    media_codec_context_t *ctx = &enc->ctx;
    ctx->encoder = 1; ctx->codec_id = codec_id;
    ctx->instance_index = (codec_id == MEDIA_CODEC_ID_H265) ? 1 : 0;
    ctx->video_enc_params.width = w; ctx->video_enc_params.height = h;
    ctx->video_enc_params.pix_fmt = MC_PIXEL_FORMAT_NV12;
    ctx->video_enc_params.bitstream_buf_size = w * h;
    ctx->video_enc_params.frame_buf_count = 3; ctx->video_enc_params.bitstream_buf_count = 3;
    ctx->video_enc_params.gop_params.gop_preset_idx = 1;
    ctx->video_enc_params.gop_params.decoding_refresh_type = 2;
    ctx->video_enc_params.rot_degree = MC_CCW_0; ctx->video_enc_params.mir_direction = MC_DIRECTION_NONE;

    if (codec_id == MEDIA_CODEC_ID_H264) {
        ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H264CBR;
        mc_h264_cbr_params_t *p = &ctx->video_enc_params.rc_params.h264_cbr_params;
        p->intra_period = fps; p->intra_qp = 30; p->bit_rate = bitrate;
        p->frame_rate = fps; p->initial_rc_qp = 30; p->vbv_buffer_size = 3000;
        p->mb_level_rc_enalbe = 1;
        p->min_qp_I = 8; p->max_qp_I = 50;
        p->min_qp_P = 8; p->max_qp_P = 50;
        p->min_qp_B = 8; p->max_qp_B = 50;
        p->hvs_qp_enable = 1; p->hvs_qp_scale = 2; p->max_delta_qp = 10;
    } else {
        ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H265CBR;
        mc_h265_cbr_params_t *p = &ctx->video_enc_params.rc_params.h265_cbr_params;
        p->intra_period = fps; p->intra_qp = 30; p->bit_rate = bitrate;
        p->frame_rate = fps; p->initial_rc_qp = 30; p->vbv_buffer_size = 3000;
        p->ctu_level_rc_enalbe = 1;
        p->min_qp_I = 8; p->max_qp_I = 50;
        p->min_qp_P = 8; p->max_qp_P = 50;
        p->min_qp_B = 8; p->max_qp_B = 50;
        p->hvs_qp_enable = 1; p->hvs_qp_scale = 2; p->max_delta_qp = 10;
    }

    int ret = hb_mm_mc_initialize(ctx);
    if (ret != 0) { printf("  init failed: %d\n", ret); return ret; }
    ret = hb_mm_mc_configure(ctx);
    if (ret != 0) { printf("  config failed: %d\n", ret); hb_mm_mc_release(ctx); return ret; }
    mc_av_codec_startup_params_t sp = {0};
    ret = hb_mm_mc_start(ctx, &sp);
    if (ret != 0) { printf("  start failed: %d\n", ret); hb_mm_mc_release(ctx); return ret; }
    enc->initialized = 1;
    return 0;
}

static int encode_one(encoder_ctx_t *enc, const uint8_t *base_y, const uint8_t *base_uv,
                       int w, int h, int frame, int grain, size_t *out_size) {
    media_codec_buffer_t in = {0}, out = {0};
    media_codec_output_buffer_info_t info = {0};
    int ret = hb_mm_mc_dequeue_input_buffer(&enc->ctx, &in, 2000);
    if (ret != 0) return ret;
    in.type = MC_VIDEO_FRAME_BUFFER;
    in.vframe_buf.width = w; in.vframe_buf.height = h;
    in.vframe_buf.pix_fmt = MC_PIXEL_FORMAT_NV12;
    in.vframe_buf.size = w*h*3/2;
    if (in.vframe_buf.vir_ptr[0]) add_grain(base_y, in.vframe_buf.vir_ptr[0], w*h, frame, grain);
    if (in.vframe_buf.vir_ptr[1]) memcpy(in.vframe_buf.vir_ptr[1], base_uv, w*h/2);
    ret = hb_mm_mc_queue_input_buffer(&enc->ctx, &in, 2000);
    if (ret != 0) return ret;
    ret = hb_mm_mc_dequeue_output_buffer(&enc->ctx, &out, &info, 2000);
    if (ret != 0) return ret;
    *out_size = out.vstream_buf.size;
    hb_mm_mc_queue_output_buffer(&enc->ctx, &out, 2000);
    return 0;
}

static void destroy_encoder(encoder_ctx_t *enc) {
    if (enc->initialized) { hb_mm_mc_stop(&enc->ctx); hb_mm_mc_release(&enc->ctx); }
}

static void run_fixqp(const char *name, int codec_id, const uint8_t *y, const uint8_t *uv,
                       int w, int h, int qp, int fps, int frames, int grain) {
    printf("--- %s FIXQP=%d (grain=±%d) ---\n", name, qp, grain);
    encoder_ctx_t enc;
    if (create_encoder_fixqp(&enc, codec_id, w, h, qp, fps) != 0) return;
    size_t total = 0;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < frames; i++) {
        size_t sz = 0;
        if (encode_one(&enc, y, uv, w, h, i, grain, &sz) != 0) break;
        total += sz;
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double sec = (t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
    printf("  %.1f fps (%.2f ms/frame), avg=%zu B/frame, bitrate=%.0f kbps\n\n",
           frames/sec, sec*1000/frames, total/frames, (total*8.0/(frames/(double)fps))/1000);
    destroy_encoder(&enc);
}

static void run_cbr(const char *name, int codec_id, const uint8_t *y, const uint8_t *uv,
                     int w, int h, int bitrate, int fps, int frames, int grain) {
    printf("--- %s CBR %dkbps (grain=±%d) ---\n", name, bitrate/1000, grain);
    encoder_ctx_t enc;
    if (create_encoder_cbr(&enc, codec_id, w, h, bitrate, fps) != 0) return;
    size_t total = 0;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < frames; i++) {
        size_t sz = 0;
        if (encode_one(&enc, y, uv, w, h, i, grain, &sz) != 0) break;
        total += sz;
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double sec = (t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
    printf("  %.1f fps (%.2f ms/frame), avg=%zu B/frame, actual=%.0f kbps (target=%d)\n\n",
           frames/sec, sec*1000/frames, total/frames, (total*8.0/(frames/(double)fps))/1000, bitrate/1000);
    destroy_encoder(&enc);
}

int main() {
    int w = 1280, h = 720, fps = 30, frames = 150;
    FILE *f = fopen("/app/multimedia_samples/sample_codec/1280x720_NV12.yuv", "rb");
    if (!f) { printf("Cannot open NV12 file\n"); return 1; }
    uint8_t *nv12 = malloc(w*h*3/2);
    fread(nv12, 1, w*h*3/2, f); fclose(f);
    uint8_t *y = nv12, *uv = nv12 + w*h;

    printf("=== H.264 vs H.265 Compression Efficiency ===\n");
    printf("Base: 1280x720_NV12.yuv, %d frames @%dfps\n\n", frames, fps);

    // Part 1: FIXQP comparison (same quality → compare size)
    printf("== Part 1: Fixed QP (same quality, compare output size) ==\n\n");
    run_fixqp("H.264", MEDIA_CODEC_ID_H264, y, uv, w, h, 28, fps, frames, 5);
    run_fixqp("H.265", MEDIA_CODEC_ID_H265, y, uv, w, h, 28, fps, frames, 5);
    run_fixqp("H.264", MEDIA_CODEC_ID_H264, y, uv, w, h, 35, fps, frames, 5);
    run_fixqp("H.265", MEDIA_CODEC_ID_H265, y, uv, w, h, 35, fps, frames, 5);

    // Part 2: CBR at higher (realistic) bitrates
    printf("== Part 2: CBR at realistic bitrates ==\n\n");
    run_cbr("H.264", MEDIA_CODEC_ID_H264, y, uv, w, h, 4000000, fps, frames, 5);
    run_cbr("H.265", MEDIA_CODEC_ID_H265, y, uv, w, h, 4000000, fps, frames, 5);
    run_cbr("H.264", MEDIA_CODEC_ID_H264, y, uv, w, h, 2000000, fps, frames, 5);
    run_cbr("H.265", MEDIA_CODEC_ID_H265, y, uv, w, h, 2000000, fps, frames, 5);

    free(nv12);
    printf("=== Done ===\n");
    return 0;
}
