/*
 * hb_media_codec.h - IDE STUB ONLY (D-Robotics RDK-X5 multimedia codec API)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef HB_MEDIA_CODEC_H
#define HB_MEDIA_CODEC_H

#include <stdint.h>
#include <stddef.h>

/* Codec IDs */
typedef enum {
    MEDIA_CODEC_ID_H265 = 1,
    MEDIA_CODEC_ID_JPEG = 2,
} media_codec_id_t;

/* Pixel formats */
typedef enum {
    MC_PIXEL_FORMAT_NV12 = 0,
} mc_pixel_format_t;

/* Rate control modes */
typedef enum {
    MC_AV_RC_MODE_H265CBR = 0,
} mc_av_rc_mode_t;

/* Buffer types */
typedef enum {
    MC_VIDEO_FRAME_BUFFER  = 0,
    MC_VIDEO_STREAM_BUFFER = 1,
} mc_buffer_type_t;

/* H.265 CBR parameters (fields used in encoder_lowlevel.c) */
typedef struct {
    int intra_period;
    int intra_qp;
    int bit_rate;
    int frame_rate;
    int initial_rc_qp;
    int vbv_buffer_size;
    int ctu_level_rc_enalbe;  /* typo preserved from SDK */
    int min_qp_I;
    int max_qp_I;
    int min_qp_P;
    int max_qp_P;
    int min_qp_B;
    int max_qp_B;
    int hvs_qp_enable;
    int hvs_qp_scale;
    int max_delta_qp;
    int qp_map_enable;
} mc_h265_cbr_params_t;

typedef struct {
    mc_av_rc_mode_t   mode;
    mc_h265_cbr_params_t h265_cbr_params;
} mc_video_rc_params_t;

typedef struct {
    int gop_preset_idx;
    int decoding_refresh_type;
} mc_video_gop_params_t;

typedef struct {
    int                  width;
    int                  height;
    mc_pixel_format_t    pix_fmt;
    uint32_t             bitstream_buf_size;
    int                  frame_buf_count;
    int                  bitstream_buf_count;
    mc_video_gop_params_t gop_params;
    int                  rot_degree;
    int                  mir_direction;
    int                  frame_cropping_flag;
    int                  enable_user_pts;
    mc_video_rc_params_t rc_params;
} mc_video_enc_params_t;

typedef struct {
    int                  encoder;
    media_codec_id_t     codec_id;
    int                  instance_index;
    mc_video_enc_params_t video_enc_params;
} media_codec_context_t;

/* Input buffer (video frame) */
typedef struct {
    int               width;
    int               height;
    mc_pixel_format_t pix_fmt;
    uint32_t          size;
    uint8_t          *vir_ptr[3];
    uint64_t          phy_ptr[3];
} mc_video_frame_buf_t;

/* Output buffer (bitstream) */
typedef struct {
    uint8_t  *vir_ptr;
    uint64_t  phy_ptr;
    uint32_t  size;
} mc_video_stream_buf_t;

typedef struct {
    mc_buffer_type_t      type;
    mc_video_frame_buf_t  vframe_buf;
    mc_video_stream_buf_t vstream_buf;
} media_codec_buffer_t;

/* Output info (VPU encoder statistics) */
typedef struct {
    uint32_t intra_block_num;
    uint32_t skip_block_num;
    uint32_t avg_mb_qp;
    uint32_t enc_pic_byte;
} mc_video_stream_info_t;

typedef struct {
    mc_video_stream_info_t video_stream_info;
} media_codec_output_buffer_info_t;

/* Startup params (used as zero-init struct) */
typedef struct {
    int reserved;
} mc_av_codec_startup_params_t;

/* Codec API */
int hb_mm_mc_initialize(media_codec_context_t *ctx);
int hb_mm_mc_configure(media_codec_context_t *ctx);
int hb_mm_mc_start(media_codec_context_t *ctx,
                   const mc_av_codec_startup_params_t *params);
int hb_mm_mc_stop(media_codec_context_t *ctx);
int hb_mm_mc_release(media_codec_context_t *ctx);

int hb_mm_mc_dequeue_input_buffer(media_codec_context_t *ctx,
                                   media_codec_buffer_t *buf,
                                   int timeout_ms);
int hb_mm_mc_queue_input_buffer(media_codec_context_t *ctx,
                                 media_codec_buffer_t *buf,
                                 int timeout_ms);
int hb_mm_mc_dequeue_output_buffer(media_codec_context_t *ctx,
                                    media_codec_buffer_t *buf,
                                    media_codec_output_buffer_info_t *info,
                                    int timeout_ms);
int hb_mm_mc_queue_output_buffer(media_codec_context_t *ctx,
                                  media_codec_buffer_t *buf,
                                  int timeout_ms);

#endif /* HB_MEDIA_CODEC_H */
