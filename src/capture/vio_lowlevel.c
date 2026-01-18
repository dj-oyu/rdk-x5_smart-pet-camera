/*
 * vio_lowlevel.c - Low-level VIO Pipeline Implementation
 */

#include "vio_lowlevel.h"
#include <stdio.h>
#include <string.h>
#include "vin_cfg.h"
#include "isp_cfg.h"
#include "vse_cfg.h"
#include "hb_mem_mgr.h"
#include "logger.h"

#define RAW10 0x2B

static int init_camera_config(vio_context_t *ctx) {
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

    return 0;
}

int vio_create(vio_context_t *ctx, int camera_index,
               int sensor_width, int sensor_height,
               int output_width, int output_height,
               int fps) {
    int ret = 0;

    if (!ctx) return -1;

    memset(ctx, 0, sizeof(vio_context_t));

    ctx->camera_index = camera_index;
    ctx->sensor_width = sensor_width;
    ctx->sensor_height = sensor_height;
    ctx->output_width = output_width;
    ctx->output_height = output_height;
    ctx->fps = fps;

    // Initialize camera configuration
    ret = init_camera_config(ctx);
    if (ret != 0) return ret;

    uint32_t mipi_host = (camera_index == 1) ? 2 : 0;
    uint32_t hw_id = mipi_host;

    LOG_INFO("VIO", "Creating pipeline for Camera %d (MIPI Host %d)", camera_index, mipi_host);

    // Create camera node
    ret = hbn_camera_create(&ctx->camera_config, &ctx->cam_fd);
    if (ret != 0) {
        LOG_ERROR("VIO", "hbn_camera_create failed: %d", ret);
        return ret;
    }

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

    ret = hbn_vnode_open(HB_VIN, hw_id, AUTO_ALLOC_ID, &ctx->vin_handle);
    if (ret != 0) {
        LOG_ERROR("VIO", "hbn_vnode_open(VIN) failed: %d", ret);
        goto error_cleanup;
    }

    ret = hbn_vnode_set_attr(ctx->vin_handle, &vin_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ichn_attr(ctx->vin_handle, 0, &vin_ichn_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_attr(ctx->vin_handle, 0, &vin_ochn_attr);
    if (ret != 0) goto error_cleanup;

    hbn_buf_alloc_attr_t alloc_attr = {
        .buffers_num = 3,
        .is_contig = 1,
        .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN | HB_MEM_USAGE_CACHED,
    };
    ret = hbn_vnode_set_ochn_buf_attr(ctx->vin_handle, 0, &alloc_attr);
    if (ret != 0) goto error_cleanup;

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

    ret = hbn_vnode_open(HB_ISP, 0, AUTO_ALLOC_ID, &ctx->isp_handle);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_attr(ctx->isp_handle, &isp_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ichn_attr(ctx->isp_handle, 0, &isp_ichn_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_attr(ctx->isp_handle, 0, &isp_ochn_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->isp_handle, 0, &alloc_attr);
    if (ret != 0) goto error_cleanup;

    // Create VSE node (Dual Channel: Ch0=Main output, Ch1=YOLO 640x640)
    vse_attr_t vse_attr = {0};

    vse_ichn_attr_t vse_ichn_attr = {
        .width = ctx->sensor_width,
        .height = ctx->sensor_height,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    // Channel 0: Main output (configurable resolution)
    vse_ochn_attr_t vse_ochn_attr_ch0 = {
        .chn_en = CAM_TRUE,
        .roi = {
            .x = 0,
            .y = 0,
            .w = ctx->sensor_width,
            .h = ctx->sensor_height,
        },
        .target_w = ctx->output_width,
        .target_h = ctx->output_height,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    // Channel 1: YOLO input (fixed 640x640)
    vse_ochn_attr_t vse_ochn_attr_ch1 = {
        .chn_en = CAM_TRUE,
        .roi = {
            .x = 0,
            .y = 0,
            .w = ctx->sensor_width,
            .h = ctx->sensor_height,
        },
        .target_w = 640,
        .target_h = 640,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    // Channel 2: MJPEG/web_monitor input (fixed 640x480)
    vse_ochn_attr_t vse_ochn_attr_ch2 = {
        .chn_en = CAM_TRUE,
        .roi = {
            .x = 0,
            .y = 0,
            .w = ctx->sensor_width,
            .h = ctx->sensor_height,
        },
        .target_w = 640,
        .target_h = 480,
        .fmt = FRM_FMT_NV12,
        .bit_width = 8,
    };

    ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &ctx->vse_handle);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_attr(ctx->vse_handle, &vse_attr);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ichn_attr(ctx->vse_handle, 0, &vse_ichn_attr);
    if (ret != 0) goto error_cleanup;

    // Set Channel 0 attributes
    ret = hbn_vnode_set_ochn_attr(ctx->vse_handle, 0, &vse_ochn_attr_ch0);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->vse_handle, 0, &alloc_attr);
    if (ret != 0) goto error_cleanup;

    // Set Channel 1 attributes (YOLO input)
    ret = hbn_vnode_set_ochn_attr(ctx->vse_handle, 1, &vse_ochn_attr_ch1);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->vse_handle, 1, &alloc_attr);
    if (ret != 0) goto error_cleanup;

    // Set Channel 2 attributes (MJPEG/web_monitor input)
    ret = hbn_vnode_set_ochn_attr(ctx->vse_handle, 2, &vse_ochn_attr_ch2);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vnode_set_ochn_buf_attr(ctx->vse_handle, 2, &alloc_attr);
    if (ret != 0) goto error_cleanup;

    // Create vflow
    ret = hbn_vflow_create(&ctx->vflow_fd);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vin_handle);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->isp_handle);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vse_handle);
    if (ret != 0) goto error_cleanup;

    // Bind: VIN -> ISP -> VSE
    ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->vin_handle, 1, ctx->isp_handle, 0);
    if (ret != 0) goto error_cleanup;

    ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->isp_handle, 0, ctx->vse_handle, 0);
    if (ret != 0) goto error_cleanup;

    // Attach camera to VIN
    ret = hbn_camera_attach_to_vin(ctx->cam_fd, ctx->vin_handle);
    if (ret != 0) {
        LOG_ERROR("VIO", "hbn_camera_attach_to_vin failed: %d", ret);
        goto error_cleanup;
    }

    LOG_INFO("VIO", "Pipeline created successfully");
    return 0;

error_cleanup:
    vio_destroy(ctx);
    return ret;
}

int vio_start(vio_context_t *ctx) {
    if (!ctx || ctx->vflow_fd <= 0) return -1;

    int ret = hbn_vflow_start(ctx->vflow_fd);
    if (ret != 0) {
        LOG_ERROR("VIO", "hbn_vflow_start failed: %d", ret);
        return ret;
    }

    LOG_INFO("VIO", "Pipeline started");
    return 0;
}

int vio_get_frame(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms) {
    if (!ctx || !frame) return -1;

    int ret = hbn_vnode_getframe(ctx->vse_handle, 0, timeout_ms, frame);
    if (ret != 0) {
        return ret;
    }

    // Invalidate cache before reading
    if (frame->buffer.virt_addr[0]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[0],
                                         frame->buffer.size[0]);
    }
    if (frame->buffer.virt_addr[1]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[1],
                                         frame->buffer.size[1]);
    }

    return 0;
}

int vio_get_frame_ch1(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms) {
    if (!ctx || !frame) return -1;

    int ret = hbn_vnode_getframe(ctx->vse_handle, 1, timeout_ms, frame);
    if (ret != 0) {
        return ret;
    }

    // Invalidate cache before reading
    if (frame->buffer.virt_addr[0]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[0],
                                         frame->buffer.size[0]);
    }
    if (frame->buffer.virt_addr[1]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[1],
                                         frame->buffer.size[1]);
    }

    return 0;
}

int vio_release_frame(vio_context_t *ctx, hbn_vnode_image_t *frame) {
    if (!ctx || !frame) return -1;

    return hbn_vnode_releaseframe(ctx->vse_handle, 0, frame);
}

int vio_release_frame_ch1(vio_context_t *ctx, hbn_vnode_image_t *frame) {
    if (!ctx || !frame) return -1;

    return hbn_vnode_releaseframe(ctx->vse_handle, 1, frame);
}

int vio_get_frame_ch2(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms) {
    if (!ctx || !frame) return -1;

    int ret = hbn_vnode_getframe(ctx->vse_handle, 2, timeout_ms, frame);
    if (ret != 0) {
        return ret;
    }

    // Invalidate cache before reading
    if (frame->buffer.virt_addr[0]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[0],
                                         frame->buffer.size[0]);
    }
    if (frame->buffer.virt_addr[1]) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)frame->buffer.virt_addr[1],
                                         frame->buffer.size[1]);
    }

    return 0;
}

int vio_release_frame_ch2(vio_context_t *ctx, hbn_vnode_image_t *frame) {
    if (!ctx || !frame) return -1;

    return hbn_vnode_releaseframe(ctx->vse_handle, 2, frame);
}

void vio_stop(vio_context_t *ctx) {
    if (!ctx || ctx->vflow_fd <= 0) return;

    hbn_vflow_stop(ctx->vflow_fd);
    LOG_INFO("VIO", "Pipeline stopped");
}

void vio_destroy(vio_context_t *ctx) {
    if (!ctx) return;

    if (ctx->vflow_fd > 0) {
        hbn_vflow_stop(ctx->vflow_fd);
        hbn_vflow_destroy(ctx->vflow_fd);
    }
    if (ctx->vse_handle > 0) hbn_vnode_close(ctx->vse_handle);
    if (ctx->isp_handle > 0) hbn_vnode_close(ctx->isp_handle);
    if (ctx->vin_handle > 0) hbn_vnode_close(ctx->vin_handle);
    if (ctx->cam_fd > 0) hbn_camera_destroy(ctx->cam_fd);

    memset(ctx, 0, sizeof(vio_context_t));
    LOG_INFO("VIO", "Pipeline destroyed");
}
