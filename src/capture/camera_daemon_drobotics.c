// Copyright (c) 2024, D-Robotics.
// Modified for Smart Pet Camera project with shared memory support
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/*
 * camera_daemon_drobotics.c - Camera capture daemon for D-Robotics platform
 *
 * Based on capture_v2.c with shared memory integration for IPC
 * Key features:
 * - Uses D-Robotics libcam.so/libvpf.so directly
 * - Supports Camera 0 (vcon@0) and Camera 1 (vcon@2)
 * - VIN/ISP/VSE pipeline with hardware acceleration
 * - POSIX shared memory for zero-copy IPC
 * - Daemon mode with signal handling
 */

#include <argp.h>
#include <jpeglib.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "hb_camera_data_config.h"
#include "hb_camera_interface.h"
#include "hb_mem_mgr.h"
#include "hbn_api.h"
#include "isp_cfg.h"
#include "vin_cfg.h"
#include "vse_cfg.h"

#include "shared_memory.h"

#define OPT_NO_RAW 1001
#define OPT_PRESET 2001
#define OPT_SENSOR_WIDTH 3001
#define OPT_SENSOR_HEIGHT 3002
#define OPT_TIMEOUT 3003
#define OPT_DAEMON 4001

#define SENSOR_WIDTH_DEFAULT 1920
#define SENSOR_HEIGHT_DEFAULT 1080
#define SENSOR_FPS_DEFAULT 30
#define RAW10 0x2B
#define JPEG_QUALITY 85

#define ERR_CON_EQ(ret, val)                                                   \
  do {                                                                         \
    if ((ret) != (val)) {                                                      \
      fprintf(stderr, "[Error] %s:%d failed, ret=%d\n", __func__, __LINE__,    \
              ret);                                                            \
      goto error_exit;                                                         \
    }                                                                          \
  } while (0)

typedef struct {
  camera_handle_t cam_fd;
  hbn_vnode_handle_t vin_node_handle;
  hbn_vnode_handle_t isp_node_handle;
  hbn_vnode_handle_t vse_node_handle;
  hbn_vflow_handle_t vflow_fd;

  int camera_index;
  int sensor_width;
  int sensor_height;
  int out_width;
  int out_height;
  int fps;

  camera_config_t camera_config;
  mipi_config_t mipi_config;
} camera_context_t;

struct arguments {
  int out_width;
  int out_height;
  int sensor_width;
  int sensor_height;
  int bit;
  int count;
  int fps;
  int enable_raw;
  int camera_index;
  int daemon_mode;
  const char *stream_out;
  int timeout_sec;
};

// Global state
static volatile sig_atomic_t g_running = 1;
static volatile sig_atomic_t g_preserve_shm = 0; // set by SIGUSR1 for shm close only
static SharedFrameBuffer *g_shm = NULL;
static const char *g_shm_name = NULL;  // Custom shared memory name (if set via SHM_NAME env)

// -----------------------------
// Argument and context helpers
// -----------------------------
static void init_default_arguments(struct arguments *args) {
  memset(args, 0, sizeof(*args));
  args->out_width = 640;
  args->out_height = 480;
  args->sensor_width = 0;
  args->sensor_height = 0;
  args->fps = 30;
  args->camera_index = 0;
  args->count = 0; // Default: infinite
  args->daemon_mode = 0;
}

static void apply_sensor_defaults(struct arguments *args) {
  if (args->sensor_width <= 0)
    args->sensor_width = SENSOR_WIDTH_DEFAULT;
  if (args->sensor_height <= 0)
    args->sensor_height = SENSOR_HEIGHT_DEFAULT;
}

static void populate_context_from_args(camera_context_t *ctx,
                                       const struct arguments *args) {
  ctx->camera_index = args->camera_index;
  ctx->sensor_width = args->sensor_width;
  ctx->sensor_height = args->sensor_height;
  ctx->out_width = args->out_width;
  ctx->out_height = args->out_height;
  ctx->fps = args->fps;
}

// Signal handler
static void signal_handler(int signum) {
  if (signum == SIGUSR1) {
    g_preserve_shm = 1;
  }
  g_running = 0;
  printf("\n[Info] Shutdown signal received (signal=%d, preserve_shm=%d)\n",
         signum, g_preserve_shm);
}

// Setup signal handlers
static void setup_signals(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_handler;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGUSR1, &sa, NULL);
}

// JPEG encoding from YUV (NV12)
static int encode_nv12_to_jpeg(const uint8_t *y_plane, const uint8_t *uv_plane,
                               int width, int height, int y_stride,
                               int uv_stride, uint8_t *jpeg_buffer,
                               size_t *jpeg_size, size_t max_size) {
  struct jpeg_compress_struct cinfo;
  struct jpeg_error_mgr jerr;

  cinfo.err = jpeg_std_error(&jerr);
  jpeg_create_compress(&cinfo);

  unsigned long outsize = max_size;
  unsigned char *outbuffer = jpeg_buffer;
  jpeg_mem_dest(&cinfo, &outbuffer, &outsize);

  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, JPEG_QUALITY, TRUE);

  jpeg_start_compress(&cinfo, TRUE);

  // Convert NV12 to RGB row by row
  uint8_t *rgb_row = (uint8_t *)malloc(width * 3);
  if (!rgb_row) {
    jpeg_destroy_compress(&cinfo);
    return -1;
  }

  for (int y = 0; y < height; y++) {
    const uint8_t *y_row = y_plane + y * y_stride;
    const uint8_t *uv_row = uv_plane + (y / 2) * uv_stride;

    for (int x = 0; x < width; x++) {
      int y_val = y_row[x];
      int u_val = uv_row[(x / 2) * 2 + 0];
      int v_val = uv_row[(x / 2) * 2 + 1];

      // YUV to RGB conversion
      int c = y_val - 16;
      int d = u_val - 128;
      int e = v_val - 128;

      int r = (298 * c + 409 * e + 128) >> 8;
      int g = (298 * c - 100 * d - 208 * e + 128) >> 8;
      int b = (298 * c + 516 * d + 128) >> 8;

      rgb_row[x * 3 + 0] = (r < 0) ? 0 : (r > 255) ? 255 : r;
      rgb_row[x * 3 + 1] = (g < 0) ? 0 : (g > 255) ? 255 : g;
      rgb_row[x * 3 + 2] = (b < 0) ? 0 : (b > 255) ? 255 : b;
    }

    JSAMPROW row_pointer[1] = {rgb_row};
    jpeg_write_scanlines(&cinfo, row_pointer, 1);
  }

  free(rgb_row);
  jpeg_finish_compress(&cinfo);

  *jpeg_size = outsize;
  jpeg_destroy_compress(&cinfo);

  return 0;
}

static char doc[] =
    "camera_daemon_drobotics -- D-Robotics camera daemon with shared memory";
static char args_doc[] = "";
static struct argp_option options[] = {
    {"preset", 'P', "N", 0,
     "Resolution/FPS preset: 1=640x480@30, 2=1920x1080@30", 0},
    {"width", 'w', "PIXELS", 0, "YUV output width (default: 640)", 1},
    {"height", 'h', "PIXELS", 0, "YUV output height (default: 480)", 2},
    {"sensor-width", OPT_SENSOR_WIDTH, "PIXELS", 0,
     "Sensor raw width (default: 0 = auto)", 3},
    {"sensor-height", OPT_SENSOR_HEIGHT, "PIXELS", 0,
     "Sensor raw height (default: 0 = auto)", 4},
    {"fps", 'f', "FPS", 0, "Sensor FPS (default: 30)", 10},
    {"camera", 'C', "INDEX", 0, "Camera index: 0 or 1 (default: 0)", 5},
    {"daemon", OPT_DAEMON, 0, 0, "Run as daemon (infinite loop)", 10},
    {"count", 'c', "N", 0,
     "Number of frames to capture (default: 0 = infinite)", 10},
    {0}};

static error_t parse_opt(int key, char *arg, struct argp_state *state) {
  struct arguments *args = state->input;
  switch (key) {
  case 'P': {
    int preset = atoi(arg);
    if (preset == 1) {
      args->out_width = 640;
      args->out_height = 480;
      args->fps = 30;
    } else if (preset == 2) {
      args->out_width = 1920;
      args->out_height = 1080;
      args->fps = 30;
    } else {
      argp_error(state, "invalid preset: %s (use 1 or 2)", arg);
    }
    break;
  }
  case 'w':
    args->out_width = atoi(arg);
    break;
  case 'h':
    args->out_height = atoi(arg);
    break;
  case OPT_SENSOR_WIDTH:
    args->sensor_width = atoi(arg);
    break;
  case OPT_SENSOR_HEIGHT:
    args->sensor_height = atoi(arg);
    break;
  case 'f':
    args->fps = atoi(arg);
    break;
  case 'C':
    args->camera_index = atoi(arg);
    break;
  case OPT_DAEMON:
    args->daemon_mode = 1;
    break;
  case 'c':
    args->count = atoi(arg);
    break;
  default:
    return ARGP_ERR_UNKNOWN;
  }
  return 0;
}

static struct argp argp = {options, parse_opt, args_doc, doc, NULL, NULL, NULL};

// Initialize camera configuration (from capture_v2.c)
static int init_camera_config(camera_context_t *ctx) {
  ctx->mipi_config = (mipi_config_t){.rx_enable = 1,
                                     .rx_attr =
                                         {
                                             .phy = 0,
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
                                     }};

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
      .bus_select = 0,
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
  printf("[Info] Camera %d configuration:\n", ctx->camera_index);
  printf("  - MIPI Host: %d\n", mipi_host);
  printf("  - sensor: %dx%d @ %d fps\n", ctx->sensor_width, ctx->sensor_height,
         ctx->fps);
  printf("  - output: %dx%d\n", ctx->out_width, ctx->out_height);

  return 0;
}

static int create_camera_node(camera_context_t *ctx) {
  int ret = hbn_camera_create(&ctx->camera_config, &ctx->cam_fd);
  if (ret != 0) {
    fprintf(stderr, "[Error] hbn_camera_create failed: %d\n", ret);
    return ret;
  }
  printf("[Info] Camera handle created: %ld\n", ctx->cam_fd);
  return 0;
}

static int create_vin_node(camera_context_t *ctx) {
  int ret = 0;
  uint32_t mipi_host = (ctx->camera_index == 1) ? 2 : 0;
  uint32_t hw_id = mipi_host;
  uint32_t ichn_id = 0;
  uint32_t ochn_id = 0;

  vin_node_attr_t vin_attr = {
      .cim_attr =
          {
              .mipi_rx = mipi_host,
              .vc_index = 0,
              .ipi_channel = 1,
              .cim_isp_flyby = 1,
              .func =
                  {
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
      .vin_basic_attr =
          {
              .format = RAW10,
              .wstride = ctx->sensor_width * 2,
          },
  };

  ret = hbn_vnode_open(HB_VIN, hw_id, AUTO_ALLOC_ID, &ctx->vin_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_attr(ctx->vin_node_handle, &vin_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ichn_attr(ctx->vin_node_handle, ichn_id, &vin_ichn_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ochn_attr(ctx->vin_node_handle, ochn_id, &vin_ochn_attr);
  ERR_CON_EQ(ret, 0);

  hbn_buf_alloc_attr_t alloc_attr = {
      .buffers_num = 3,
      .is_contig = 1,
      .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
               HB_MEM_USAGE_CACHED,
  };
  ret = hbn_vnode_set_ochn_buf_attr(ctx->vin_node_handle, ochn_id, &alloc_attr);
  ERR_CON_EQ(ret, 0);

  printf("[Info] VIN node created (HW ID: %d)\n", hw_id);
  return 0;

error_exit:
  return ret;
}

static int create_isp_node(camera_context_t *ctx) {
  int ret = 0;
  uint32_t ichn_id = 0;
  uint32_t ochn_id = 0;

  isp_attr_t isp_attr = {
      .input_mode = 1,
      .sensor_mode = ISP_NORMAL_M,
      .crop =
          {
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
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_attr(ctx->isp_node_handle, &isp_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ichn_attr(ctx->isp_node_handle, ichn_id, &isp_ichn_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ochn_attr(ctx->isp_node_handle, ochn_id, &isp_ochn_attr);
  ERR_CON_EQ(ret, 0);

  hbn_buf_alloc_attr_t alloc_attr = {
      .buffers_num = 3,
      .is_contig = 1,
      .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
               HB_MEM_USAGE_CACHED,
  };
  ret = hbn_vnode_set_ochn_buf_attr(ctx->isp_node_handle, ochn_id, &alloc_attr);
  ERR_CON_EQ(ret, 0);

  printf("[Info] ISP node created\n");
  return 0;

error_exit:
  return ret;
}

static int create_vse_node(camera_context_t *ctx) {
  int ret = 0;
  uint32_t hw_id = 0;
  uint32_t ichn_id = 0;
  uint32_t ochn_id = 0;

  vse_attr_t vse_attr = {0};

  vse_ichn_attr_t vse_ichn_attr = {
      .width = ctx->sensor_width,
      .height = ctx->sensor_height,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  vse_ochn_attr_t vse_ochn_attr = {
      .chn_en = CAM_TRUE,
      .roi =
          {
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

  ret = hbn_vnode_open(HB_VSE, hw_id, AUTO_ALLOC_ID, &ctx->vse_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_attr(ctx->vse_node_handle, &vse_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ichn_attr(ctx->vse_node_handle, ichn_id, &vse_ichn_attr);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vnode_set_ochn_attr(ctx->vse_node_handle, ochn_id, &vse_ochn_attr);
  ERR_CON_EQ(ret, 0);

  hbn_buf_alloc_attr_t alloc_attr = {
      .buffers_num = 3,
      .is_contig = 1,
      .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
               HB_MEM_USAGE_CACHED,
  };
  ret = hbn_vnode_set_ochn_buf_attr(ctx->vse_node_handle, ochn_id, &alloc_attr);
  ERR_CON_EQ(ret, 0);

  printf("[Info] VSE node created (scale %dx%d -> %dx%d)\n", ctx->sensor_width,
         ctx->sensor_height, ctx->out_width, ctx->out_height);
  return 0;

error_exit:
  return ret;
}

static int create_and_start_pipeline(camera_context_t *ctx) {
  int ret = 0;

  ret = create_camera_node(ctx);
  if (ret != 0)
    return ret;

  ret = create_vin_node(ctx);
  if (ret != 0)
    return ret;

  ret = create_isp_node(ctx);
  if (ret != 0)
    return ret;

  ret = create_vse_node(ctx);
  if (ret != 0)
    return ret;

  ret = hbn_vflow_create(&ctx->vflow_fd);
  if (ret != 0) {
    fprintf(stderr, "[Error] hbn_vflow_create failed: %d\n", ret);
    goto error_exit;
  }

  ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vin_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->isp_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vflow_add_vnode(ctx->vflow_fd, ctx->vse_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->vin_node_handle, 1,
                             ctx->isp_node_handle, 0);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vflow_bind_vnode(ctx->vflow_fd, ctx->isp_node_handle, 0,
                             ctx->vse_node_handle, 0);
  ERR_CON_EQ(ret, 0);

  ret = hbn_camera_attach_to_vin(ctx->cam_fd, ctx->vin_node_handle);
  ERR_CON_EQ(ret, 0);

  ret = hbn_vflow_start(ctx->vflow_fd);
  ERR_CON_EQ(ret, 0);

  printf("[Info] Pipeline started successfully\n");
  return 0;

error_exit:
  return ret;
}

static void cleanup_pipeline(camera_context_t *ctx) {
  if (ctx->vflow_fd > 0) {
    hbn_vflow_stop(ctx->vflow_fd);
    hbn_vflow_destroy(ctx->vflow_fd);
  }
  if (ctx->vse_node_handle > 0)
    hbn_vnode_close(ctx->vse_node_handle);
  if (ctx->isp_node_handle > 0)
    hbn_vnode_close(ctx->isp_node_handle);
  if (ctx->vin_node_handle > 0)
    hbn_vnode_close(ctx->vin_node_handle);
  if (ctx->cam_fd > 0)
    hbn_camera_destroy(ctx->cam_fd);
}

// -----------------------------
// Initialization helpers
// -----------------------------
static int open_memory_manager(void) {
  int ret = hb_mem_module_open();
  if (ret != 0) {
    fprintf(stderr, "[Error] hb_mem_module_open failed: %d\n", ret);
    return -1;
  }
  return 0;
}

static int create_shared_memory(void) {
  // Check for custom shared memory name via environment variable
  g_shm_name = getenv("SHM_NAME");
  if (g_shm_name) {
    g_shm = shm_frame_buffer_create_named(g_shm_name);
  } else {
    g_shm = shm_frame_buffer_create();
  }

  if (!g_shm) {
    fprintf(stderr, "[Error] Failed to create shared memory\n");
    return -1;
  }
  return 0;
}

static int open_or_create_shared_memory(void) {
  // Check for custom shared memory name via environment variable
  g_shm_name = getenv("SHM_NAME");
  if (g_shm_name) {
    g_shm = shm_frame_buffer_open_named(g_shm_name);
  } else {
    g_shm = shm_frame_buffer_open();
  }

  if (g_shm) {
    return 0;
  }

  // Fall back to creation when the segment does not yet exist
  return create_shared_memory();
}

static int initialize_camera(camera_context_t *ctx) {
  int ret = init_camera_config(ctx);
  if (ret != 0) {
    fprintf(stderr, "[Error] Failed to initialize camera config\n");
    return -1;
  }
  return 0;
}

static int start_pipeline(camera_context_t *ctx) {
  int ret = create_and_start_pipeline(ctx);
  if (ret != 0) {
    fprintf(stderr, "[Error] Failed to create pipeline\n");
    return -1;
  }
  return 0;
}

// -----------------------------
// Capture loop
// -----------------------------
static uint64_t run_capture_loop(camera_context_t *ctx, const struct arguments *args) {
  hbn_vnode_image_t vnode_frame = {0};
  int frame_limit = args->count;
  uint64_t frame_counter = 0;
  int ret = 0;

  while (g_running &&
         ((frame_limit == 0) || (frame_counter < (uint64_t)frame_limit))) {
    ret = hbn_vnode_getframe(ctx->vse_node_handle, 0, 2000, &vnode_frame);
    if (ret != 0) {
      fprintf(stderr, "[Warn] Failed to get frame, ret=%d\n", ret);
      continue;
    }

    // Invalidate cache before reading
    for (int j = 0; j < 2; j++) {
      if (vnode_frame.buffer.virt_addr[j]) {
        hb_mem_invalidate_buf_with_vaddr(
            (uint64_t)vnode_frame.buffer.virt_addr[j],
            vnode_frame.buffer.size[j]);
      }
    }

    // Prepare frame for shared memory
    Frame shm_frame = {0};
    shm_frame.frame_number = frame_counter;
    clock_gettime(CLOCK_MONOTONIC, &shm_frame.timestamp);
    shm_frame.camera_id = ctx->camera_index;
    shm_frame.width = ctx->out_width;
    shm_frame.height = ctx->out_height;
    shm_frame.format = 0; // JPEG

    // Convert NV12 to JPEG
    uint8_t *y_plane = vnode_frame.buffer.virt_addr[0];
    uint8_t *uv_plane = vnode_frame.buffer.virt_addr[1];
    int y_stride = ctx->out_width;
    int uv_stride = ctx->out_width;

    if (encode_nv12_to_jpeg(y_plane, uv_plane, ctx->out_width, ctx->out_height,
                            y_stride, uv_stride, shm_frame.data,
                            &shm_frame.data_size, MAX_FRAME_SIZE) < 0) {
      fprintf(stderr, "[Error] JPEG encoding failed\n");
      hbn_vnode_releaseframe(ctx->vse_node_handle, 0, &vnode_frame);
      continue;
    }

    // Write to shared memory
    if (shm_frame_buffer_write(g_shm, &shm_frame) < 0) {
      fprintf(stderr, "[Error] Failed to write frame to shared memory\n");
    } else {
      // For probe captures (count=1), always log the captured frame
      if (frame_counter == 0 && args->count == 1) {
        printf("[probe-daemon] Wrote frame: camera=%d, %dx%d, format=%d, data_size=%zu\n",
               ctx->camera_index, shm_frame.width, shm_frame.height,
               shm_frame.format, shm_frame.data_size);
      }
    }

    hbn_vnode_releaseframe(ctx->vse_node_handle, 0, &vnode_frame);

    frame_counter++;

    // Print status every 30 frames
    if (frame_counter % 30 == 0) {
      printf("[Info] Frame %lu captured (%zu bytes)\n", frame_counter,
             shm_frame.data_size);
    }
  }

  return frame_counter;
}

int main(int argc, char **argv) {
  struct arguments args;
  camera_context_t ctx = {0};
  uint64_t frame_counter = 0;

  init_default_arguments(&args);
  argp_parse(&argp, argc, argv, 0, 0, &args);
  apply_sensor_defaults(&args);

  // Setup signals
  setup_signals();

  // Initialize context
  populate_context_from_args(&ctx, &args);

  // Initialize memory manager
  if (open_memory_manager() != 0) {
    return 1;
  }

  // Create shared memory
  if (open_or_create_shared_memory() != 0) {
    hb_mem_module_close();
    return 1;
  }

  // Initialize camera configuration
  if (initialize_camera(&ctx) != 0) {
    if (g_shm_name) {
      shm_frame_buffer_destroy_named(g_shm, g_shm_name);
    } else {
      shm_frame_buffer_destroy(g_shm);
    }
    hb_mem_module_close();
    return 1;
  }

  // Create and start pipeline
  if (start_pipeline(&ctx) != 0) {
    cleanup_pipeline(&ctx);
    if (g_shm_name) {
      shm_frame_buffer_destroy_named(g_shm, g_shm_name);
    } else {
      shm_frame_buffer_destroy(g_shm);
    }
    hb_mem_module_close();
    return 1;
  }

  // Wait for ISP to stabilize
  sleep(2);
  printf("[Info] Camera daemon started (Ctrl+C to stop)\n");
  if (args.daemon_mode || args.count == 0) {
    printf("[Info] Running in daemon mode (infinite loop)\n");
  }

  frame_counter = run_capture_loop(&ctx, &args);

  // Cleanup
  cleanup_pipeline(&ctx);
  if (g_shm) {
    // Custom-named shared memory is managed by the orchestrator;
    // we only close (not destroy) since we didn't create it
    if (g_preserve_shm || g_shm_name) {
      if (g_preserve_shm) {
        printf("[Info] Preserving shared memory (SIGUSR1)\n");
      } else {
        printf("[Info] Preserving custom-named shared memory: %s\n", g_shm_name);
      }
      shm_frame_buffer_close(g_shm);
    } else {
      shm_frame_buffer_destroy(g_shm);
    }
  }
  hb_mem_module_close();

  printf("[Info] Camera daemon stopped (captured %lu frames)\n", frame_counter);
  return 0;
}
