/*
 * camera_poc_lowlevel.c - PoC for Low-level VIO + Encoder integration
 *
 * Purpose: Verify 30fps H.264 encoding with zero-copy and shared memory output
 * Requirements:
 *  - Low-level VIO (hbn_*) for NV12 capture
 *  - Low-level Encoder (hb_mm_mc_*) for H.264 encoding
 *  - Shared memory output for profile_shm.py validation
 */

#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <time.h>
#include <stdbool.h>

// D-Robotics Low-level VIO
#include "hb_camera_interface.h"
#include "hb_camera_data_config.h"
#include "hbn_api.h"
#include "vin_cfg.h"
#include "isp_cfg.h"
#include "vse_cfg.h"
#include "hb_mem_mgr.h"

// D-Robotics Low-level Encoder
#include "hb_media_codec.h"

// Shared memory for IPC
#include "shared_memory.h"

#define RAW10 0x2B
#define SENSOR_WIDTH_DEFAULT 1920
#define SENSOR_HEIGHT_DEFAULT 1080
#define SENSOR_FPS_DEFAULT 30
#define ENCODER_BITRATE 8000  // 8Mbps

static volatile bool g_running = true;
static SharedFrameBuffer *g_shm_h264 = NULL;

typedef struct {
    // VIO handles
    camera_handle_t cam_fd;
    hbn_vnode_handle_t vin_node_handle;
    hbn_vnode_handle_t isp_node_handle;
    hbn_vnode_handle_t vse_node_handle;
    hbn_vflow_handle_t vflow_fd;

    // Encoder context
    media_codec_context_t encoder_ctx;

    // Configuration
    int camera_index;
    int sensor_width;
    int sensor_height;
    int out_width;
    int out_height;
    int fps;
    int bitrate;

    camera_config_t camera_config;
    mipi_config_t mipi_config;
} poc_context_t;

static void signal_handler(int signo) {
    printf("\n[PoC] Received signal %d, stopping...\n", signo);
    g_running = false;
}

static int init_camera_config(poc_context_t *ctx) {
    // MIPI configuration for IMX219
    ctx->mipi_config = (mipi_config_t){
        .rx_enable = 1,
        .rx_attr = {
            .phy = 0,  // D-PHY
            .lane = 2,
            .datatype = RAW10,
            .fps = ctx->fps,
            .mclk = 24,
            .mipiclk = 1728,
            .width = ctx->sensor_width,
            .height = ctx->sensor_height,
            .linelenth = 3448,
            .framelenth = 1166,
            .settle = 30,
            .channel_num = 1,
            .channel_sel = {0},
        },
        .rx_ex_mask = 0x40,
        .rx_attr_ex = {
            .stop_check_instart = 1,
        }
    };

    // Camera configuration for IMX219
    ctx->camera_config = (camera_config_t){
        .name = "imx219",
        .addr = 0x10,
        .isp_addr = 0,
        .eeprom_addr = 0,
        .serial_addr = 0,
        .sensor_mode = 1,
        .sensor_clk = 0,
        .gpio_enable_bit = 0x01,
        .gpio_level_bit = 0x00,
        .bus_select = 0,  // Both cameras use bus_select=0
        .bus_timeout = 0,
        .fps = ctx->fps,
        .width = ctx->sensor_width,
        .height = ctx->sensor_height,
        .format = RAW10,
        .flags = 0,
        .extra_mode = 0,
        .config_index = 0,
        .ts_compensate = 0,
        .mipi_cfg = &ctx->mipi_config,
        .calib_lname = "/usr/hobot/lib/sensor/imx219_1920x1080_tuning.json",
        .sensor_param = NULL,
        .iparam_mode = 0,
        .end_flag = 0,
    };

    uint32_t mipi_host = (ctx->camera_index == 1) ? 2 : 0;
    printf("[PoC] Camera %d configuration:\n", ctx->camera_index);
    printf("  - bus_select: %d (fixed)\n", ctx->camera_config.bus_select);
    printf("  - MIPI Host: %d\n", mipi_host);
    printf("  - sensor: %dx%d @ %d fps\n", ctx->sensor_width, ctx->sensor_height, ctx->fps);
    printf("  - output: %dx%d\n", ctx->out_width, ctx->out_height);

    return 0;
}

static int create_vio_pipeline(poc_context_t *ctx) {
    int ret = 0;
    uint32_t mipi_host = (ctx->camera_index == 1) ? 2 : 0;
    uint32_t hw_id = mipi_host;

    // Create camera node
    ret = hbn_camera_create(&ctx->camera_config, &ctx->cam_fd);
    if (ret != 0) {
        fprintf(stderr, "[Error] hbn_camera_create failed: %d\n", ret);
        return ret;
    }
    printf("[PoC] Camera handle created\n");

    // Create VIN node
    vin_node_attr_t vin_attr = {
        .cim_attr = {
            .mipi_rx = mipi_host,
            .vc_index = 0,
            .ipi_channel = 1,
            .cim_isp_flyby = 1,
            .func = {
                .enable_frame_id = 1,
                .set_init_frame_id = 0,
                .hdr_mode = NOT_HDR,
                .time_stamp_en = 0,
            },
        },
    };

    vin_ichn_attr_t vin_ichn_attr = {
        .width = ctx->sensor_width,
        .height = ctx->sensor_height,
        .format = RAW10,
    };

    vin_ochn_attr_t vin_ochn_attr = {
        .ddr_en = 1,
        .ochn_attr_type = VIN_BASIC_ATTR,
        .vin_basic_attr = {
            .format = RAW10,
            .wstride = ctx->sensor_width * 2,
        },
    };

    ret = hbn_vnode_open(HB_VIN, hw_id, AUTO_ALLOC_ID, &ctx->vin_node_handle);
    if (ret != 0) {
        fprintf(stderr, "[Error] hbn_vnode_open(VIN) failed: %d\n", ret);
        return ret;
    }

    ret = hbn_vnode_set_attr(ctx->vin_node_handle, &vin_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ichn_attr(ctx->vin_node_handle, 0, &vin_ichn_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ochn_attr(ctx->vin_node_handle, 0, &vin_ochn_attr);
    if (ret != 0) return ret;

    hbn_buf_alloc_attr_t alloc_attr = {
        .buffers_num = 3,
        .is_contig = 1,
        .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN | HB_MEM_USAGE_CACHED,
    };
    ret = hbn_vnode_set_ochn_buf_attr(ctx->vin_node_handle, 0, &alloc_attr);
    if (ret != 0) return ret;

    printf("[PoC] VIN node created (HW ID: %d)\n", hw_id);

    // Create ISP node
    isp_attr_t isp_attr = {
        .input_mode = 1,  // mcm
        .sensor_mode = ISP_NORMAL_M,
        .crop = {
            .x = 0,
            .y = 0,
            .w = ctx->sensor_width,
            .h = ctx->sensor_height,
        },
    };

    isp_ichn_attr_t isp_ichn_attr = {
        .width = ctx->sensor_width,
        .height = ctx->sensor_height,
        .fmt = FRM_FMT_RAW,
        .bit_width = 10,
    };

    isp_ochn_attr_t isp_ochn_attr = {
        .ddr_en = 1,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    ret = hbn_vnode_open(HB_ISP, 0, AUTO_ALLOC_ID, &ctx->isp_node_handle);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_attr(ctx->isp_node_handle, &isp_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ichn_attr(ctx->isp_node_handle, 0, &isp_ichn_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ochn_attr(ctx->isp_node_handle, 0, &isp_ochn_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->isp_node_handle, 0, &alloc_attr);
    if (ret != 0) return ret;

    printf("[PoC] ISP node created\n");

    // Create VSE node
    vse_attr_t vse_attr = {0};

    vse_ichn_attr_t vse_ichn_attr = {
        .width = ctx->sensor_width,
        .height = ctx->sensor_height,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    vse_ochn_attr_t vse_ochn_attr = {
        .chn_en = CAM_TRUE,
        .roi = {
            .x = 0,
            .y = 0,
            .w = ctx->sensor_width,
            .h = ctx->sensor_height,
        },
        .target_w = ctx->out_width,
        .target_h = ctx->out_height,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &ctx->vse_node_handle);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_attr(ctx->vse_node_handle, &vse_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ichn_attr(ctx->vse_node_handle, 0, &vse_ichn_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ochn_attr(ctx->vse_node_handle, 0, &vse_ochn_attr);
    if (ret != 0) return ret;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->vse_node_handle, 0, &alloc_attr);
    if (ret != 0) return ret;

    printf("[PoC] VSE node created (scale %dx%d -> %dx%d)\n",
           ctx->sensor_width, ctx->sensor_height, ctx->out_width, ctx->out_height);

    // Create and bind vflow
    ret = hbn_vflow_create(&ctx->vflow_fd);
    if (ret != 0) return ret;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vin_node_handle);
    if (ret != 0) return ret;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->isp_node_handle);
    if (ret != 0) return ret;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vse_node_handle);
    if (ret != 0) return ret;

    // Bind: VIN -> ISP -> VSE
    ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->vin_node_handle, 1,
                                ctx->isp_node_handle, 0);
    if (ret != 0) return ret;

    ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->isp_node_handle, 0,
                                ctx->vse_node_handle, 0);
    if (ret != 0) return ret;

    // Attach camera to VIN
    ret = hbn_camera_attach_to_vin(ctx->cam_fd, ctx->vin_node_handle);
    if (ret != 0) {
        fprintf(stderr, "[Error] hbn_camera_attach_to_vin failed: %d\n", ret);
        return ret;
    }

    // Start pipeline
    ret = hbn_vflow_start(ctx->vflow_fd);
    if (ret != 0) {
        fprintf(stderr, "[Error] hbn_vflow_start failed: %d\n", ret);
        return ret;
    }

    printf("[PoC] VIO pipeline started\n");
    return 0;
}

static int init_encoder(poc_context_t *ctx) {
    int ret = 0;
    media_codec_context_t *encoder = &ctx->encoder_ctx;

    memset(encoder, 0, sizeof(media_codec_context_t));

    encoder->encoder = 1;
    encoder->codec_id = MEDIA_CODEC_ID_H264;
    encoder->instance_index = ctx->camera_index;

    // Video encoder parameters
    encoder->video_enc_params.width = ctx->out_width;
    encoder->video_enc_params.height = ctx->out_height;
    encoder->video_enc_params.pix_fmt = MC_PIXEL_FORMAT_NV12;

    // Buffer configuration (CRITICAL for encoder to work!)
    encoder->video_enc_params.bitstream_buf_size = (ctx->out_width * ctx->out_height * 3 / 2 + 0x3ff) & ~0x3ff;
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
    encoder->video_enc_params.rc_params.h264_cbr_params.intra_period = 30;
    encoder->video_enc_params.rc_params.h264_cbr_params.intra_qp = 30;
    encoder->video_enc_params.rc_params.h264_cbr_params.bit_rate = ctx->bitrate;
    encoder->video_enc_params.rc_params.h264_cbr_params.frame_rate = ctx->fps;
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
        fprintf(stderr, "[Error] hb_mm_mc_initialize failed: %d\n", ret);
        return ret;
    }

    ret = hb_mm_mc_configure(encoder);
    if (ret != 0) {
        fprintf(stderr, "[Error] hb_mm_mc_configure failed: %d\n", ret);
        hb_mm_mc_release(encoder);
        return ret;
    }

    mc_av_codec_startup_params_t startup_params = {0};
    ret = hb_mm_mc_start(encoder, &startup_params);
    if (ret != 0) {
        fprintf(stderr, "[Error] hb_mm_mc_start failed: %d\n", ret);
        return ret;
    }

    printf("[PoC] Encoder initialized (H.264 CBR %dx%d @ %dfps, %dkbps)\n",
           ctx->out_width, ctx->out_height, ctx->fps, ctx->bitrate);

    return 0;
}

static void cleanup(poc_context_t *ctx) {
    printf("[PoC] Cleaning up...\n");

    // Stop encoder
    if (ctx->encoder_ctx.encoder) {
        hb_mm_mc_stop(&ctx->encoder_ctx);
        hb_mm_mc_release(&ctx->encoder_ctx);
    }

    // Stop VIO pipeline
    if (ctx->vflow_fd > 0) {
        hbn_vflow_stop(ctx->vflow_fd);
        hbn_vflow_destroy(ctx->vflow_fd);
    }
    if (ctx->vse_node_handle > 0) hbn_vnode_close(ctx->vse_node_handle);
    if (ctx->isp_node_handle > 0) hbn_vnode_close(ctx->isp_node_handle);
    if (ctx->vin_node_handle > 0) hbn_vnode_close(ctx->vin_node_handle);
    if (ctx->cam_fd > 0) hbn_camera_destroy(ctx->cam_fd);

    // Close shared memory
    if (g_shm_h264) {
        const char *shm_name = getenv("SHM_NAME_H264");
        if (!shm_name) shm_name = "/pet_camera_stream";
        shm_frame_buffer_destroy_named(g_shm_h264, shm_name);
        g_shm_h264 = NULL;
    }

    hb_mem_module_close();
}

static int run_encode_loop(poc_context_t *ctx) {
    int ret = 0;
    int frame_count = 0;
    hbn_vnode_image_t vio_frame = {0};
    media_codec_buffer_t input_buffer = {0};
    media_codec_buffer_t output_buffer = {0};
    media_codec_output_buffer_info_t output_info = {0};

    struct timespec start_time, current_time;
    clock_gettime(CLOCK_MONOTONIC, &start_time);

    printf("[PoC] Starting encode loop...\n");

    while (g_running) {
        // Get NV12 frame from VIO
        ret = hbn_vnode_getframe(ctx->vse_node_handle, 0, 2000, &vio_frame);
        if (ret != 0) {
            fprintf(stderr, "[Warn] hbn_vnode_getframe failed: %d\n", ret);
            continue;
        }

        // Dequeue encoder input buffer
        ret = hb_mm_mc_dequeue_input_buffer(&ctx->encoder_ctx, &input_buffer, 2000);
        if (ret != 0) {
            fprintf(stderr, "[Warn] hb_mm_mc_dequeue_input_buffer failed: %d\n", ret);
            hbn_vnode_releaseframe(ctx->vse_node_handle, 0, &vio_frame);
            continue;
        }

        // Copy NV12 from VIO to encoder input buffer
        input_buffer.type = MC_VIDEO_FRAME_BUFFER;
        input_buffer.vframe_buf.width = ctx->out_width;
        input_buffer.vframe_buf.height = ctx->out_height;
        input_buffer.vframe_buf.pix_fmt = MC_PIXEL_FORMAT_NV12;
        input_buffer.vframe_buf.size = ctx->out_width * ctx->out_height * 3 / 2;

        // Invalidate cache before reading VIO frame
        if (vio_frame.buffer.virt_addr[0]) {
            hb_mem_invalidate_buf_with_vaddr((uint64_t)vio_frame.buffer.virt_addr[0],
                                             vio_frame.buffer.size[0]);
        }
        if (vio_frame.buffer.virt_addr[1]) {
            hb_mem_invalidate_buf_with_vaddr((uint64_t)vio_frame.buffer.virt_addr[1],
                                             vio_frame.buffer.size[1]);
        }

        // Copy Y plane
        if (input_buffer.vframe_buf.vir_ptr[0] && vio_frame.buffer.virt_addr[0]) {
            memcpy(input_buffer.vframe_buf.vir_ptr[0],
                   vio_frame.buffer.virt_addr[0],
                   ctx->out_width * ctx->out_height);
        }

        // Copy UV plane
        if (input_buffer.vframe_buf.vir_ptr[1] && vio_frame.buffer.virt_addr[1]) {
            memcpy(input_buffer.vframe_buf.vir_ptr[1],
                   vio_frame.buffer.virt_addr[1],
                   ctx->out_width * ctx->out_height / 2);
        }

        // Release VIO frame
        hbn_vnode_releaseframe(ctx->vse_node_handle, 0, &vio_frame);

        // Queue encoder input
        ret = hb_mm_mc_queue_input_buffer(&ctx->encoder_ctx, &input_buffer, 2000);
        if (ret != 0) {
            fprintf(stderr, "[Warn] hb_mm_mc_queue_input_buffer failed: %d\n", ret);
            continue;
        }

        // Dequeue encoder output
        ret = hb_mm_mc_dequeue_output_buffer(&ctx->encoder_ctx, &output_buffer, &output_info, 2000);
        if (ret != 0) {
            fprintf(stderr, "[Warn] hb_mm_mc_dequeue_output_buffer failed: %d\n", ret);
            continue;
        }

        // Write H.264 to shared memory
        if (g_shm_h264 && output_buffer.vstream_buf.vir_ptr && output_buffer.vstream_buf.size > 0) {
            Frame shm_frame = {0};
            shm_frame.width = ctx->out_width;
            shm_frame.height = ctx->out_height;
            shm_frame.format = 3;  // H.264
            shm_frame.data_size = output_buffer.vstream_buf.size;
            shm_frame.frame_number = frame_count;
            shm_frame.camera_id = ctx->camera_index;
            clock_gettime(CLOCK_MONOTONIC, &shm_frame.timestamp);

            if (output_buffer.vstream_buf.size <= sizeof(shm_frame.data)) {
                memcpy(shm_frame.data, output_buffer.vstream_buf.vir_ptr, output_buffer.vstream_buf.size);
                shm_frame_buffer_write(g_shm_h264, &shm_frame);
            }
        }

        // Release encoder output buffer
        ret = hb_mm_mc_queue_output_buffer(&ctx->encoder_ctx, &output_buffer, 2000);
        if (ret != 0) {
            fprintf(stderr, "[Warn] hb_mm_mc_queue_output_buffer failed: %d\n", ret);
        }

        frame_count++;

        if (frame_count % 30 == 0) {
            clock_gettime(CLOCK_MONOTONIC, &current_time);
            double elapsed = (current_time.tv_sec - start_time.tv_sec) +
                            (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
            double fps = frame_count / elapsed;
            printf("[PoC] Frame %d, FPS: %.2f, H.264 size: %u bytes\n",
                   frame_count, fps, output_buffer.vstream_buf.size);
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &current_time);
    double total_elapsed = (current_time.tv_sec - start_time.tv_sec) +
                          (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
    double avg_fps = frame_count / total_elapsed;
    printf("[PoC] Completed: %d frames in %.2f seconds (avg FPS: %.2f)\n",
           frame_count, total_elapsed, avg_fps);

    return 0;
}

int main(int argc, char *argv[]) {
    int ret = 0;
    poc_context_t ctx = {0};

    // Default configuration
    ctx.camera_index = 0;
    ctx.sensor_width = SENSOR_WIDTH_DEFAULT;
    ctx.sensor_height = SENSOR_HEIGHT_DEFAULT;
    ctx.out_width = 1920;
    ctx.out_height = 1080;
    ctx.fps = SENSOR_FPS_DEFAULT;
    ctx.bitrate = ENCODER_BITRATE;

    // Parse command line
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-C") == 0 && i + 1 < argc) {
            ctx.camera_index = atoi(argv[++i]);
        }
    }

    printf("=== Low-level API PoC ===\n");
    printf("Camera: %d, Resolution: %dx%d @ %dfps\n",
           ctx.camera_index, ctx.out_width, ctx.out_height, ctx.fps);

    // Signal handling
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Initialize memory manager
    ret = hb_mem_module_open();
    if (ret != 0) {
        fprintf(stderr, "[Error] hb_mem_module_open failed: %d\n", ret);
        return 1;
    }

    // Initialize shared memory for H.264 output
    const char *shm_name = getenv("SHM_NAME_H264");
    if (!shm_name) shm_name = "/pet_camera_stream";

    g_shm_h264 = shm_frame_buffer_create_named(shm_name);
    if (!g_shm_h264) {
        fprintf(stderr, "[Error] Failed to create shared memory: %s\n", shm_name);
        cleanup(&ctx);
        return 1;
    }
    printf("[PoC] Shared memory created: %s\n", shm_name);

    // Initialize camera configuration
    ret = init_camera_config(&ctx);
    if (ret != 0) {
        fprintf(stderr, "[Error] init_camera_config failed\n");
        cleanup(&ctx);
        return 1;
    }

    // Create VIO pipeline
    ret = create_vio_pipeline(&ctx);
    if (ret != 0) {
        fprintf(stderr, "[Error] create_vio_pipeline failed\n");
        cleanup(&ctx);
        return 1;
    }

    // Wait for ISP to stabilize
    sleep(2);

    // Initialize encoder
    ret = init_encoder(&ctx);
    if (ret != 0) {
        fprintf(stderr, "[Error] init_encoder failed\n");
        cleanup(&ctx);
        return 1;
    }

    // Run encode loop
    ret = run_encode_loop(&ctx);

    // Cleanup
    cleanup(&ctx);

    printf("[PoC] Exiting\n");
    return ret;
}
