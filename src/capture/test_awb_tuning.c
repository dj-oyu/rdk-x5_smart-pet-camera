/*
 * test_awb_tuning.c - Interactive AWB (Auto White Balance) Tuning Tool
 *
 * Starts a camera pipeline and provides an interactive shell to adjust
 * AWB gains in real-time. Designed for tuning the night (IR) camera's
 * color balance.
 *
 * Usage:
 *   ./test_awb_tuning --camera <0|1>
 *
 * Commands (in interactive shell):
 *   d            Dump current AWB attr
 *   a            Set AWB to Auto mode
 *   m R G B      Set AWB to Manual mode with rgain/grgain=gbgain/bgain
 *                Example: m 1.0 1.0 1.4  (cool/blue tint)
 *   t TEMP       Calculate gains for color temperature (Kelvin)
 *                Example: t 4000
 *   s [NAME]     Save current frame as NV12 + JPEG (optional name suffix)
 *   q            Quit
 *
 * Notes:
 *   - Stop camera_switcher_daemon before running this tool
 *   - Saved frames: /app/smart-pet-camera/test_pic/awb_*.nv12
 *   - View NV12:  ffplay -f rawvideo -pix_fmt nv12 -s 1920x1080 FILE.nv12
 *   - JPEG files are saved alongside for easy viewing
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <getopt.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "hb_camera_data_config.h"
#include "hb_camera_interface.h"
#include "hb_mem_mgr.h"
#include "hbn_api.h"
#include "hbn_isp_api.h"
#include "isp_cfg.h"
#include "isp_common.h"
#include "vin_cfg.h"
#include "vse_cfg.h"

#define RAW10 0x2B
#define OUTPUT_DIR "/app/smart-pet-camera/test_pic"

typedef struct {
  camera_handle_t cam_fd;
  hbn_vnode_handle_t vin_handle;
  hbn_vnode_handle_t isp_handle;
  hbn_vnode_handle_t vse_handle;
  hbn_vflow_handle_t vflow_fd;
  mipi_config_t mipi_config;
  camera_config_t camera_config;
} vio_handles_t;

static volatile sig_atomic_t g_running = 1;

static void signal_handler(int sig) {
  (void)sig;
  g_running = 0;
}

// ============================================================================
// VIO Pipeline (same pattern as test_isp_lowlight.c)
// ============================================================================

static int init_vio_pipeline(vio_handles_t *h, int camera_index) {
  int ret;
  uint32_t mipi_host = (camera_index == 1) ? 2 : 0;
  uint32_t hw_id = mipi_host;

  const int sensor_width = 1920;
  const int sensor_height = 1080;
  const int fps = 30;

  printf("[VIO] Initializing pipeline for camera %d (MIPI Host %d)\n",
         camera_index, mipi_host);

  ret = hb_mem_module_open();
  if (ret != 0) {
    fprintf(stderr, "[VIO] hb_mem_module_open failed: %d\n", ret);
    return ret;
  }

  h->mipi_config = (mipi_config_t){
      .rx_enable = 1,
      .rx_attr = {
          .phy = 0,
          .lane = 2,
          .datatype = RAW10,
          .fps = fps,
          .mclk = 24,
          .mipiclk = 1728,
          .width = sensor_width,
          .height = sensor_height,
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

  h->camera_config = (camera_config_t){
      .name = "imx219",
      .addr = 0x10,
      .bus_select = 0,
      .fps = fps,
      .width = sensor_width,
      .height = sensor_height,
      .format = RAW10,
      .sensor_mode = 1,
      .gpio_enable_bit = 0x01,
      .gpio_level_bit = 0x00,
      .mipi_cfg = &h->mipi_config,
      .calib_lname = "/usr/hobot/lib/sensor/imx219_1920x1080_tuning.json",
  };

  ret = hbn_camera_create(&h->camera_config, &h->cam_fd);
  if (ret != 0) {
    fprintf(stderr, "[VIO] hbn_camera_create failed: %d\n", ret);
    return ret;
  }

  vin_node_attr_t vin_attr = {
      .cim_attr = {
          .mipi_rx = mipi_host,
          .vc_index = 0,
          .ipi_channel = 1,
          .cim_isp_flyby = 1,
          .func = {
              .enable_frame_id = 1,
              .hdr_mode = NOT_HDR,
          },
      },
  };

  vin_ichn_attr_t vin_ichn_attr = {
      .width = sensor_width,
      .height = sensor_height,
      .format = RAW10,
  };

  vin_ochn_attr_t vin_ochn_attr = {
      .ddr_en = 1,
      .ochn_attr_type = VIN_BASIC_ATTR,
      .vin_basic_attr = {
          .format = RAW10,
          .wstride = sensor_width * 2,
      },
  };

  ret = hbn_vnode_open(HB_VIN, hw_id, AUTO_ALLOC_ID, &h->vin_handle);
  if (ret != 0) {
    fprintf(stderr, "[VIO] hbn_vnode_open(VIN) failed: %d\n", ret);
    return ret;
  }

  ret = hbn_vnode_set_attr(h->vin_handle, &vin_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ichn_attr(h->vin_handle, 0, &vin_ichn_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ochn_attr(h->vin_handle, 0, &vin_ochn_attr);
  if (ret != 0) return ret;

  hbn_buf_alloc_attr_t alloc_attr = {
      .buffers_num = 3,
      .is_contig = 1,
      .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
               HB_MEM_USAGE_CACHED,
  };
  ret = hbn_vnode_set_ochn_buf_attr(h->vin_handle, 0, &alloc_attr);
  if (ret != 0) return ret;

  // ISP node
  isp_attr_t isp_attr = {
      .input_mode = 1,
      .sensor_mode = ISP_NORMAL_M,
      .crop = { .x = 0, .y = 0, .w = sensor_width, .h = sensor_height },
  };

  isp_ichn_attr_t isp_ichn_attr = {
      .width = sensor_width,
      .height = sensor_height,
      .fmt = FRM_FMT_RAW,
      .bit_width = 10,
  };

  isp_ochn_attr_t isp_ochn_attr = {
      .ddr_en = 1,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  ret = hbn_vnode_open(HB_ISP, 0, AUTO_ALLOC_ID, &h->isp_handle);
  if (ret != 0) {
    fprintf(stderr, "[VIO] hbn_vnode_open(ISP) failed: %d\n", ret);
    return ret;
  }

  ret = hbn_vnode_set_attr(h->isp_handle, &isp_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ichn_attr(h->isp_handle, 0, &isp_ichn_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ochn_attr(h->isp_handle, 0, &isp_ochn_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ochn_buf_attr(h->isp_handle, 0, &alloc_attr);
  if (ret != 0) return ret;

  // VSE node (single channel: 1920x1080)
  vse_attr_t vse_attr = {0};

  vse_ichn_attr_t vse_ichn_attr = {
      .width = sensor_width,
      .height = sensor_height,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  vse_ochn_attr_t vse_ochn_attr = {
      .chn_en = CAM_TRUE,
      .roi = { .x = 0, .y = 0, .w = sensor_width, .h = sensor_height },
      .target_w = sensor_width,
      .target_h = sensor_height,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &h->vse_handle);
  if (ret != 0) return ret;

  ret = hbn_vnode_set_attr(h->vse_handle, &vse_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ichn_attr(h->vse_handle, 0, &vse_ichn_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ochn_attr(h->vse_handle, 0, &vse_ochn_attr);
  if (ret != 0) return ret;
  ret = hbn_vnode_set_ochn_buf_attr(h->vse_handle, 0, &alloc_attr);
  if (ret != 0) return ret;

  // Create and bind vflow
  ret = hbn_vflow_create(&h->vflow_fd);
  if (ret != 0) return ret;

  ret = hbn_vflow_add_vnode(h->vflow_fd, h->vin_handle);
  if (ret != 0) return ret;
  ret = hbn_vflow_add_vnode(h->vflow_fd, h->isp_handle);
  if (ret != 0) return ret;
  ret = hbn_vflow_add_vnode(h->vflow_fd, h->vse_handle);
  if (ret != 0) return ret;

  ret = hbn_vflow_bind_vnode(h->vflow_fd, h->vin_handle, 1, h->isp_handle, 0);
  if (ret != 0) return ret;
  ret = hbn_vflow_bind_vnode(h->vflow_fd, h->isp_handle, 0, h->vse_handle, 0);
  if (ret != 0) return ret;

  ret = hbn_camera_attach_to_vin(h->cam_fd, h->vin_handle);
  if (ret != 0) {
    fprintf(stderr, "[VIO] hbn_camera_attach_to_vin failed: %d\n", ret);
    return ret;
  }

  printf("[VIO] Pipeline initialized successfully\n");
  return 0;
}

static void destroy_vio_pipeline(vio_handles_t *h) {
  if (h->vflow_fd > 0) {
    hbn_vflow_stop(h->vflow_fd);
    hbn_vflow_destroy(h->vflow_fd);
  }
  if (h->vse_handle > 0) hbn_vnode_close(h->vse_handle);
  if (h->isp_handle > 0) hbn_vnode_close(h->isp_handle);
  if (h->vin_handle > 0) hbn_vnode_close(h->vin_handle);
  if (h->cam_fd > 0) hbn_camera_destroy(h->cam_fd);
  hb_mem_module_close();
  printf("[VIO] Pipeline destroyed\n");
}

// ============================================================================
// AWB operations
// ============================================================================

static void dump_awb_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_awb_attr_t attr = {0};
  int ret = hbn_isp_get_awb_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[AWB] Failed to get AWB attr: %d\n", ret);
    return;
  }

  const char *mode_str;
  switch (attr.mode) {
    case HBN_ISP_MODE_AUTO:   mode_str = "AUTO";   break;
    case HBN_ISP_MODE_MANUAL: mode_str = "MANUAL"; break;
    default:                  mode_str = "UNKNOWN"; break;
  }

  printf("\n");
  printf("  === AWB Attributes ===\n");
  printf("  mode:         %s (%d)\n", mode_str, attr.mode);
  printf("  lock_state:   %u\n", attr.lock_state);
  printf("  --- Auto attr ---\n");
  printf("  use_damping:         %u\n", attr.auto_attr.use_damping);
  printf("  use_manual_damp_coff: %u\n", attr.auto_attr.use_manual_damp_coff);
  printf("  manual_damp_coff:    %.4f\n", attr.auto_attr.manual_damp_coff);
  printf("  lock_tolerance:      %.4f\n", attr.auto_attr.lock_tolerance);
  printf("  unlock_tolerance:    %.4f\n", attr.auto_attr.unlock_tolerance);
  printf("  rg_strength:         %u\n", attr.auto_attr.rg_strength);
  printf("  bg_strength:         %u\n", attr.auto_attr.bg_strength);
  printf("  auto gain:   R=%.4f  Gr=%.4f  Gb=%.4f  B=%.4f\n",
         attr.auto_attr.gain.rgain, attr.auto_attr.gain.grgain,
         attr.auto_attr.gain.gbgain, attr.auto_attr.gain.bgain);
  printf("  auto temper: %u\n", attr.auto_attr.temper);
  printf("  --- Manual attr ---\n");
  printf("  manual gain: R=%.4f  Gr=%.4f  Gb=%.4f  B=%.4f\n",
         attr.manual_attr.gain.rgain, attr.manual_attr.gain.grgain,
         attr.manual_attr.gain.gbgain, attr.manual_attr.gain.bgain);
  printf("  manual temper: %u\n", attr.manual_attr.temper);
  printf("\n");
}

static int set_awb_auto(hbn_vnode_handle_t isp_handle) {
  hbn_isp_awb_attr_t attr = {0};
  int ret = hbn_isp_get_awb_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[AWB] Failed to get AWB attr: %d\n", ret);
    return ret;
  }

  attr.mode = HBN_ISP_MODE_AUTO;

  ret = hbn_isp_set_awb_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[AWB] Failed to set AWB attr: %d\n", ret);
    return ret;
  }

  printf("[AWB] Set to AUTO mode\n");
  return 0;
}

static int set_awb_manual(hbn_vnode_handle_t isp_handle,
                          float rgain, float ggain, float bgain) {
  hbn_isp_awb_attr_t attr = {0};
  int ret = hbn_isp_get_awb_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[AWB] Failed to get AWB attr: %d\n", ret);
    return ret;
  }

  attr.mode = HBN_ISP_MODE_MANUAL;
  attr.manual_attr.gain.rgain  = rgain;
  attr.manual_attr.gain.grgain = ggain;
  attr.manual_attr.gain.gbgain = ggain;
  attr.manual_attr.gain.bgain  = bgain;

  ret = hbn_isp_set_awb_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[AWB] Failed to set AWB attr: %d\n", ret);
    return ret;
  }

  printf("[AWB] Set to MANUAL: R=%.3f G=%.3f B=%.3f\n", rgain, ggain, bgain);
  return 0;
}

static int calc_gains_for_temp(hbn_vnode_handle_t isp_handle, uint32_t temp) {
  hbn_isp_awb_gain_t gain = {0};
  int ret = hbn_isp_cal_gain_by_temp(isp_handle, temp, 0, &gain);
  if (ret != 0) {
    fprintf(stderr, "[AWB] hbn_isp_cal_gain_by_temp(%u) failed: %d\n", temp, ret);
    return ret;
  }

  printf("[AWB] Gains for %uK: R=%.4f Gr=%.4f Gb=%.4f B=%.4f\n",
         temp, gain.rgain, gain.grgain, gain.gbgain, gain.bgain);
  printf("      To apply: m %.4f %.4f %.4f\n", gain.rgain, gain.grgain, gain.bgain);
  return 0;
}

// ============================================================================
// Gamma (GC) operations
// ============================================================================

static void dump_gamma_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_gc_attr_t attr = {0};
  int ret = hbn_isp_get_gc_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[GC] Failed to get gamma attr: %d\n", ret);
    return;
  }

  const char *mode_str = (attr.mode == HBN_ISP_MODE_MANUAL) ? "MANUAL" : "AUTO";
  printf("\n");
  printf("  === Gamma (GC) Attributes ===\n");
  printf("  mode:          %s (%d)\n", mode_str, attr.mode);
  printf("  standard:      %d\n", attr.manual_attr.standard);
  printf("  standard_val:  %.4f\n", attr.manual_attr.standard_val);
  printf("  curve[0..7]:   ");
  for (int i = 0; i < 8; i++) printf("%u ", attr.manual_attr.curve[i]);
  printf("...\n\n");
}

static int set_gamma(hbn_vnode_handle_t isp_handle, float gamma_val) {
  hbn_isp_gc_attr_t attr = {0};
  int ret = hbn_isp_get_gc_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[GC] Failed to get gamma attr: %d\n", ret);
    return ret;
  }

  // Try 1: keep current mode, just modify standard_val
  attr.manual_attr.standard = 1;
  attr.manual_attr.standard_val = gamma_val;

  int gc_ret = hbn_isp_set_gc_attr(isp_handle, &attr);
  if (gc_ret == 0) {
    printf("[GC] Set gamma=%.2f (kept %s mode)\n", gamma_val,
           attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");
    return 0;
  }

  // Try 2: switch to Manual mode
  attr.mode = HBN_ISP_MODE_MANUAL;
  gc_ret = hbn_isp_set_gc_attr(isp_handle, &attr);
  if (gc_ret == 0) {
    printf("[GC] Set gamma=%.2f (MANUAL mode)\n", gamma_val);
    return 0;
  }

  fprintf(stderr, "[GC] Failed to set gamma (all approaches): %d\n", gc_ret);
  return gc_ret;
}

// ============================================================================
// WDR (Wide Dynamic Range) operations
// ============================================================================

static void dump_wdr_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_wdr_attr_t attr = {0};
  int ret = hbn_isp_get_wdr_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[WDR] Failed to get WDR attr: %d\n", ret);
    return;
  }

  const char *mode_str = (attr.mode == HBN_ISP_MODE_MANUAL) ? "MANUAL" : "AUTO";
  printf("\n");
  printf("  === WDR Attributes ===\n");
  printf("  mode:               %s (%d)\n", mode_str, attr.mode);
  printf("  --- Manual attr ---\n");
  printf("  strength:           %u\n", attr.manual_attr.strength_attr.strength);
  printf("  high_strength:      %u\n", attr.manual_attr.strength_attr.high_strength);
  printf("  low_strength:       %u\n", attr.manual_attr.strength_attr.low_strength);
  printf("  dark_attention:     %u\n", attr.manual_attr.ltm_attr.dark_attention_level);
  printf("  contrast:           %d\n", attr.manual_attr.ltm_weight_attr.contrast);
  printf("  max_gain:           %u\n", attr.manual_attr.gain_limitation_attr.max_gain);
  printf("  min_gain:           %u\n", attr.manual_attr.gain_limitation_attr.min_gain);
  printf("\n");
}

static int set_wdr_dark_boost(hbn_vnode_handle_t isp_handle,
                              uint8_t strength, uint8_t dark_attention) {
  hbn_isp_wdr_attr_t attr = {0};
  int ret = hbn_isp_get_wdr_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[WDR] Failed to get WDR attr: %d\n", ret);
    return ret;
  }

  // Try AUTO mode with auto_level first (Manual mode fails on this hardware)
  int wdr_ret = -1;
  if (attr.mode == HBN_ISP_MODE_AUTO) {
    uint8_t level = strength * 10 / 255;
    attr.auto_attr.auto_level = level;
    wdr_ret = hbn_isp_set_wdr_attr(isp_handle, &attr);
    if (wdr_ret == 0) {
      printf("[WDR] Set AUTO auto_level=%u (from strength=%u)\n", level, strength);
    }
  }

  // Fallback: try Manual mode
  if (wdr_ret != 0) {
    attr.mode = HBN_ISP_MODE_MANUAL;
    attr.manual_attr.strength_attr.strength = strength;
    attr.manual_attr.ltm_attr.dark_attention_level = dark_attention;
    wdr_ret = hbn_isp_set_wdr_attr(isp_handle, &attr);
    if (wdr_ret != 0) {
      fprintf(stderr, "[WDR] Failed (AUTO and MANUAL both failed): %d\n", wdr_ret);
      return wdr_ret;
    }
    printf("[WDR] Set MANUAL strength=%u, dark_attention=%u\n", strength, dark_attention);
  }

  return 0;
}

// ============================================================================
// Color Process (Brightness/Contrast) operations
// ============================================================================

static void dump_cproc_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_color_process_attr_t attr = {0};
  int ret = hbn_isp_get_color_process_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[CPROC] Failed to get color process attr: %d\n", ret);
    return;
  }

  const char *mode_str = (attr.mode == HBN_ISP_MODE_MANUAL) ? "MANUAL" : "AUTO";
  printf("\n");
  printf("  === Color Process Attributes ===\n");
  printf("  mode:       %s (%d)\n", mode_str, attr.mode);
  printf("  brightness: %.2f\n", attr.manual_attr.bright);
  printf("  contrast:   %.2f\n", attr.manual_attr.contrast);
  printf("  saturation: %.2f\n", attr.manual_attr.saturation);
  printf("  hue:        %.2f\n", attr.manual_attr.hue);
  printf("  NOTE: May not take effect on this hardware.\n\n");
}

static int set_cproc(hbn_vnode_handle_t isp_handle,
                     float brightness, float contrast, float saturation) {
  hbn_isp_color_process_attr_t attr = {0};
  int ret = hbn_isp_get_color_process_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[CPROC] Failed to get color process attr: %d\n", ret);
    return ret;
  }

  attr.mode = HBN_ISP_MODE_MANUAL;
  attr.manual_attr.bright = brightness;
  attr.manual_attr.contrast = contrast;
  attr.manual_attr.saturation = saturation;

  ret = hbn_isp_set_color_process_attr(isp_handle, &attr);
  if (ret != 0) {
    fprintf(stderr, "[CPROC] Failed to set color process attr: %d\n", ret);
    return ret;
  }

  printf("[CPROC] Set brightness=%.1f, contrast=%.2f, saturation=%.2f\n",
         brightness, contrast, saturation);
  printf("        NOTE: May not take effect on this hardware.\n");
  return 0;
}

// ============================================================================
// Frame capture
// ============================================================================

static int save_frame(vio_handles_t *h, const char *suffix) {
  hbn_vnode_image_t frame = {0};
  int ret = hbn_vnode_getframe(h->vse_handle, 0, 2000, &frame);
  if (ret != 0) {
    fprintf(stderr, "[Save] Failed to get frame: %d\n", ret);
    return ret;
  }

  if (frame.buffer.virt_addr[0]) {
    hb_mem_invalidate_buf_with_vaddr((uint64_t)frame.buffer.virt_addr[0],
                                     frame.buffer.size[0]);
  }
  if (frame.buffer.virt_addr[1]) {
    hb_mem_invalidate_buf_with_vaddr((uint64_t)frame.buffer.virt_addr[1],
                                     frame.buffer.size[1]);
  }

  mkdir(OUTPUT_DIR, 0755);

  // Generate filename with timestamp
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  struct tm tm;
  localtime_r(&ts.tv_sec, &tm);

  char filename[512];
  if (suffix && suffix[0]) {
    snprintf(filename, sizeof(filename),
             "%s/awb_%02d%02d%02d_%02d%02d%02d_%s.nv12",
             OUTPUT_DIR,
             tm.tm_year % 100, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec,
             suffix);
  } else {
    snprintf(filename, sizeof(filename),
             "%s/awb_%02d%02d%02d_%02d%02d%02d.nv12",
             OUTPUT_DIR,
             tm.tm_year % 100, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec);
  }

  FILE *fp = fopen(filename, "wb");
  if (!fp) {
    fprintf(stderr, "[Save] Failed to open %s\n", filename);
    hbn_vnode_releaseframe(h->vse_handle, 0, &frame);
    return -1;
  }

  size_t y_size = frame.buffer.size[0];
  size_t uv_size = frame.buffer.size[1];
  fwrite((void *)frame.buffer.virt_addr[0], 1, y_size, fp);
  fwrite((void *)frame.buffer.virt_addr[1], 1, uv_size, fp);
  fclose(fp);

  printf("[Save] %s (%zu bytes, 1920x1080 NV12)\n", filename, y_size + uv_size);
  printf("       View: ffplay -f rawvideo -pix_fmt nv12 -s 1920x1080 %s\n", filename);

  hbn_vnode_releaseframe(h->vse_handle, 0, &frame);
  return 0;
}

// Drain frames to keep pipeline flowing (call periodically)
static void drain_frames(vio_handles_t *h) {
  hbn_vnode_image_t frame = {0};
  // Non-blocking drain
  int ret = hbn_vnode_getframe(h->vse_handle, 0, 10, &frame);
  if (ret == 0) {
    hbn_vnode_releaseframe(h->vse_handle, 0, &frame);
  }
}

// ============================================================================
// Interactive shell
// ============================================================================

static void print_help(void) {
  printf("\n");
  printf("  === AWB Tuning Commands ===\n");
  printf("  d              Dump ALL ISP attributes (AWB + Gamma + WDR + CPROC)\n");
  printf("  da             Dump AWB only\n");
  printf("  a              Set AWB to Auto mode\n");
  printf("  m R G B        Set AWB to Manual (e.g. 'm 1.0 1.0 1.4' for cool)\n");
  printf("  t TEMP         Show gains for color temperature in K (e.g. 't 4000')\n");
  printf("\n");
  printf("  === Shadow / Brightness Commands ===\n");
  printf("  g GAMMA        Set gamma (e.g. 'g 0.6' to brighten shadows)\n");
  printf("  w STR DARK     Set WDR strength + dark_attention (e.g. 'w 128 200')\n");
  printf("  c BRI CON SAT  Set color process (e.g. 'c 30 1.2 1.0')\n");
  printf("  dw             Dump WDR only\n");
  printf("  dg             Dump Gamma only\n");
  printf("  dc             Dump Color Process only\n");
  printf("\n");
  printf("  === General ===\n");
  printf("  s [NAME]       Save frame to NV12 file (optional name suffix)\n");
  printf("  h              Show this help\n");
  printf("  q              Quit\n");
  printf("\n");
  printf("  AWB Presets:\n");
  printf("  m 1.0 1.0 1.0  Neutral (equal gains)\n");
  printf("  m 1.0 1.0 1.3  Slightly cool (blue)\n");
  printf("  m 1.0 1.0 1.6  Cool (more blue)\n");
  printf("  m 1.3 1.0 1.0  Warm (red)\n");
  printf("  m 1.0 1.0 2.0  Very cool (strong blue)\n");
  printf("\n");
}

static void interactive_loop(vio_handles_t *h) {
  char line[256];

  // Initial dump
  dump_awb_attr(h->isp_handle);
  dump_wdr_attr(h->isp_handle);
  dump_gamma_attr(h->isp_handle);
  print_help();

  while (g_running) {
    printf("awb> ");
    fflush(stdout);

    // Drain frames while waiting for input to prevent buffer stalls
    // Use select() to check if stdin has data
    fd_set fds;
    struct timeval tv;
    FD_ZERO(&fds);
    FD_SET(STDIN_FILENO, &fds);
    tv.tv_sec = 0;
    tv.tv_usec = 100000;  // 100ms

    int sel = select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv);
    if (sel <= 0) {
      drain_frames(h);
      // Reprint prompt only if we drained
      printf("\rawb> ");
      fflush(stdout);

      // Block until actual input
      if (!fgets(line, sizeof(line), stdin)) break;
    } else {
      if (!fgets(line, sizeof(line), stdin)) break;
    }

    // Remove trailing newline
    line[strcspn(line, "\n")] = 0;

    if (line[0] == 0) {
      drain_frames(h);
      continue;
    }

    switch (line[0]) {
      case 'q':
      case 'Q':
        g_running = 0;
        break;

      case 'd':
      case 'D':
        if (line[1] == 'a' || line[1] == 'A') {
          dump_awb_attr(h->isp_handle);
        } else if (line[1] == 'w' || line[1] == 'W') {
          dump_wdr_attr(h->isp_handle);
        } else if (line[1] == 'g' || line[1] == 'G') {
          dump_gamma_attr(h->isp_handle);
        } else if (line[1] == 'c' || line[1] == 'C') {
          dump_cproc_attr(h->isp_handle);
        } else {
          // Dump all
          dump_awb_attr(h->isp_handle);
          dump_gamma_attr(h->isp_handle);
          dump_wdr_attr(h->isp_handle);
          dump_cproc_attr(h->isp_handle);
        }
        break;

      case 'a':
      case 'A':
        set_awb_auto(h->isp_handle);
        break;

      case 'm':
      case 'M': {
        float r, g, b;
        if (sscanf(line + 1, "%f %f %f", &r, &g, &b) == 3) {
          set_awb_manual(h->isp_handle, r, g, b);
        } else {
          printf("  Usage: m <rgain> <ggain> <bgain>\n");
          printf("  Example: m 1.0 1.0 1.4\n");
        }
        break;
      }

      case 't':
      case 'T': {
        unsigned int temp;
        if (sscanf(line + 1, "%u", &temp) == 1) {
          calc_gains_for_temp(h->isp_handle, temp);
        } else {
          printf("  Usage: t <color_temp_K>\n");
          printf("  Example: t 4000\n");
        }
        break;
      }

      case 'g':
      case 'G': {
        float gamma_val;
        if (sscanf(line + 1, "%f", &gamma_val) == 1) {
          set_gamma(h->isp_handle, gamma_val);
        } else {
          printf("  Usage: g <gamma>\n");
          printf("  Example: g 0.6  (brighten shadows)\n");
        }
        break;
      }

      case 'w':
      case 'W': {
        unsigned int str, dark;
        if (sscanf(line + 1, "%u %u", &str, &dark) == 2) {
          set_wdr_dark_boost(h->isp_handle, (uint8_t)str, (uint8_t)dark);
        } else {
          printf("  Usage: w <strength> <dark_attention>\n");
          printf("  Example: w 128 200  (medium WDR, strong shadow boost)\n");
        }
        break;
      }

      case 'c':
      case 'C': {
        float bri, con, sat;
        if (sscanf(line + 1, "%f %f %f", &bri, &con, &sat) == 3) {
          set_cproc(h->isp_handle, bri, con, sat);
        } else {
          printf("  Usage: c <brightness> <contrast> <saturation>\n");
          printf("  Example: c 30 1.2 1.0\n");
        }
        break;
      }

      case 's':
      case 'S': {
        char suffix[128] = "";
        sscanf(line + 1, " %127s", suffix);
        save_frame(h, suffix);
        break;
      }

      case 'p':
      case 'P': {
        // Pause: drain frames for N seconds (default 2) to let ISP settle
        float secs = 2.0f;
        sscanf(line + 1, "%f", &secs);
        int drain_count = (int)(secs * 30);  // ~30fps
        printf("[Wait] Draining %d frames (%.1fs)...\n", drain_count, secs);
        for (int i = 0; i < drain_count && g_running; i++) {
          drain_frames(h);
          usleep(33000);
        }
        printf("[Wait] Done\n");
        break;
      }

      case 'h':
      case 'H':
      case '?':
        print_help();
        break;

      default:
        printf("  Unknown command: '%s' (type 'h' for help)\n", line);
        break;
    }
  }
}

// ============================================================================
// Main
// ============================================================================

int main(int argc, char *argv[]) {
  int camera_index = 1;  // Default to night camera

  static struct option long_options[] = {
      {"camera", required_argument, 0, 'c'},
      {"help",   no_argument,       0, 'h'},
      {0, 0, 0, 0}
  };

  int opt;
  while ((opt = getopt_long(argc, argv, "c:h", long_options, NULL)) != -1) {
    switch (opt) {
      case 'c':
        camera_index = atoi(optarg);
        break;
      case 'h':
      default:
        printf("Usage: %s [--camera <0|1>]\n", argv[0]);
        printf("  --camera <idx>  Camera index (0=day, 1=night, default=1)\n");
        return (opt == 'h') ? 0 : 1;
    }
  }

  if (camera_index < 0 || camera_index > 1) {
    fprintf(stderr, "Camera index must be 0 or 1\n");
    return 1;
  }

  signal(SIGINT, signal_handler);
  signal(SIGTERM, signal_handler);

  printf("=== AWB Tuning Tool ===\n");
  printf("Camera: %d (%s)\n", camera_index,
         camera_index == 0 ? "DAY" : "NIGHT/IR");
  printf("Stop camera_switcher_daemon before using this tool.\n\n");

  vio_handles_t handles = {0};

  int ret = init_vio_pipeline(&handles, camera_index);
  if (ret != 0) {
    fprintf(stderr, "Failed to initialize pipeline: %d\n", ret);
    return 1;
  }

  ret = hbn_vflow_start(handles.vflow_fd);
  if (ret != 0) {
    fprintf(stderr, "Failed to start pipeline: %d\n", ret);
    destroy_vio_pipeline(&handles);
    return 1;
  }

  printf("[VIO] Pipeline started, waiting for ISP to stabilize...\n");
  // Drain initial frames to let AE/AWB converge
  for (int i = 0; i < 30 && g_running; i++) {
    drain_frames(&handles);
    usleep(33000);  // ~30fps
  }

  interactive_loop(&handles);

  printf("\n[VIO] Shutting down...\n");
  destroy_vio_pipeline(&handles);

  return 0;
}
