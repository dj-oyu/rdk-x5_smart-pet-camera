/*
 * test_isp_lowlight.c - Low-light ISP Enhancement Verification Tool
 *
 * This tool tests hardware ISP adjustments for low-light conditions:
 * - Color Processing (CPROC): Brightness, Contrast, Saturation
 * - Gamma Correction (GC): Gamma curve for dark scene enhancement
 * - Exposure Control: AE target, gain ranges
 *
 * Usage:
 *   ./test_isp_lowlight --camera <0|1> [options]
 *
 * Options:
 *   --camera <idx>     Camera index (0 or 1)
 *   --brightness <val> Brightness adjustment [-127, 127] (default: 20)
 *   --contrast <val>   Contrast adjustment [0, 1.999] (default: 1.2)
 *   --saturation <val> Saturation adjustment [0, 1.999] (default: 1.0)
 *   --gamma <val>      Gamma value for curve generation (default: 0.8)
 *   --ae-target <val>  AE target brightness [0, 255] (default: 60)
 *   --dgain-max <val>  Max digital gain (default: 16.0)
 *   --reset            Reset to default values
 *   --dump             Dump current ISP settings
 *   --help             Show this help
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE // for usleep()

#include <getopt.h>
#include <math.h>
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

// Default low-light enhancement parameters
#define DEFAULT_BRIGHTNESS 20.0f // Slight brightness boost
#define DEFAULT_CONTRAST 1.2f    // Moderate contrast increase
#define DEFAULT_SATURATION 1.0f  // Keep saturation neutral
#define DEFAULT_GAMMA 0.8f       // < 1.0 brightens dark areas
#define DEFAULT_AE_TARGET 60.0f  // Higher AE target for low-light
#define DEFAULT_DGAIN_MAX 16.0f  // Allow higher digital gain

// Noise reduction defaults (higher = more NR, but may lose detail)
#define DEFAULT_3DNR_STRENGTH 113  // 3DNR strength [0-128]
#define DEFAULT_2DNR_STRENGTH 0.5f // 2DNR blend [0-1.0]
#define DEFAULT_SHARPNESS 64       // Sharpness [0-255]

typedef struct {
  int camera_index;
  float brightness;
  float contrast;
  float saturation;
  float gamma;
  float ae_target;
  float dgain_max;
  // Noise reduction and sharpness
  int denoise_3d;   // 3DNR strength [0-128], -1 = don't change
  float denoise_2d; // 2DNR blend strength [0-1.0], -1 = don't change
  int sharpness;    // Sharpness/EE strength [0-255], -1 = don't change
  // WDR (Wide Dynamic Range) for highlight protection
  int wdr;            // WDR strength [0-255], -1 = don't change
  float shadow_boost; // Shadow boost amount [0-2.0], 0 = disabled
  int hlc;            // Highlight compression [0-255], -1 = don't change
  int reset;
  int dump_only;
  int save_frames; // Save before/after frames to files
  // Random pattern testing
  int patterns; // Number of random patterns to test (0 = disabled)
  // Track which parameters were explicitly set
  bool brightness_set;
  bool contrast_set;
  bool saturation_set;
  bool gamma_set;
  bool ae_target_set;
  bool dgain_max_set;
  bool denoise_3d_set;
  bool denoise_2d_set;
  bool sharpness_set;
  bool wdr_set;
  bool shadow_boost_set;
  bool hlc_set;
} config_t;

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
static char g_output_dir[256] = "/app/smart-pet-camera/test_pic";

static void signal_handler(int sig) {
  (void)sig;
  g_running = 0;
}

// Save NV12 frame to file (can be viewed with ffplay or converted)
static int save_nv12_frame(const char *filename, uint8_t *y_data,
                           uint8_t *uv_data, size_t y_size, size_t uv_size,
                           int width, int height) {
  FILE *fp = fopen(filename, "wb");
  if (!fp) {
    fprintf(stderr, "Failed to open %s for writing\n", filename);
    return -1;
  }

  // Write Y plane
  fwrite(y_data, 1, y_size, fp);
  // Write UV plane
  fwrite(uv_data, 1, uv_size, fp);

  fclose(fp);
  printf("Saved NV12 frame: %s (%dx%d, %zu bytes)\n", filename, width, height,
         y_size + uv_size);
  printf("  View with: ffplay -f rawvideo -pixel_format nv12 -video_size %dx%d "
         "%s\n",
         width, height, filename);
  return 0;
}

// Print histogram of Y channel (brightness distribution)
static void print_histogram(uint8_t *y_data, size_t y_size, const char *label) {
// 16 bins for 0-255 range
#define HIST_BINS 16
#define HIST_WIDTH 50

  uint32_t hist[HIST_BINS] = {0};
  uint64_t sum = 0;
  uint8_t min_val = 255, max_val = 0;

  // Calculate histogram (sample every 10th pixel for speed)
  for (size_t i = 0; i < y_size; i += 10) {
    uint8_t val = y_data[i];
    hist[val / 16]++;
    sum += val;
    if (val < min_val)
      min_val = val;
    if (val > max_val)
      max_val = val;
  }

  size_t sample_count = y_size / 10;
  float avg = (float)sum / sample_count;

  // Find max for scaling
  uint32_t max_count = 0;
  for (int i = 0; i < HIST_BINS; i++) {
    if (hist[i] > max_count)
      max_count = hist[i];
  }

  printf("\n=== Brightness Histogram: %s ===\n", label);
  printf("Min: %3u, Max: %3u, Avg: %.1f\n\n", min_val, max_val, avg);

  // Print histogram bars
  for (int i = 0; i < HIST_BINS; i++) {
    int bar_len = (max_count > 0) ? (hist[i] * HIST_WIDTH / max_count) : 0;
    printf("%3d-%3d |", i * 16, (i + 1) * 16 - 1);
    for (int j = 0; j < bar_len; j++)
      printf("#");
    printf(" %u\n", hist[i]);
  }
  printf("\n");

  // Classification based on average brightness
  printf("Assessment: ");
  if (avg < 30) {
    printf("VERY DARK - Strong enhancement recommended\n");
  } else if (avg < 60) {
    printf("DARK - Moderate enhancement recommended\n");
  } else if (avg < 120) {
    printf("NORMAL - Minor adjustment may help\n");
  } else if (avg < 200) {
    printf("BRIGHT - No enhancement needed\n");
  } else {
    printf("VERY BRIGHT - Consider reducing exposure\n");
  }
}

// Generate gamma curve based on gamma value
// gamma < 1.0 brightens dark areas (useful for low-light)
// gamma > 1.0 darkens image
static void generate_gamma_curve(uint16_t *curve, int size, float gamma) {
  for (int i = 0; i < size; i++) {
    // Normalize input to [0, 1]
    float normalized = (float)i / (size - 1);
    // Apply gamma correction
    float corrected = powf(normalized, gamma);
    // Scale to 12-bit output (0-4095)
    curve[i] = (uint16_t)(corrected * 4095.0f + 0.5f);
  }
}

// HBN error code decoder
// Format: COMBINE_ERRCODE(module_id, err_info) = (module_id << 16) | err_info
static const char *hbn_strerror(int err) {
  static char buf[128];

  if (err == 0)
    return "OK";

  int code = (err < 0) ? -err : err;
  int module = (code >> 16) & 0xFF;
  int status = code & 0xFFFF;

  const char *module_name;
  switch (module) {
  case 0:
    module_name = "VIN";
    break;
  case 1:
    module_name = "ISP";
    break;
  case 2:
    module_name = "VSE";
    break;
  case 3:
    module_name = "GDC";
    break;
  case 0x0B:
    module_name = "VIN";
    break; // Alternative VIN code
  case 0x0C:
    module_name = "ISP";
    break; // Alternative ISP code
  default:
    module_name = "UNKNOWN";
    break;
  }

  const char *status_name;
  switch (status) {
  case 1:
    status_name = "INVALID_NODE";
    break;
  case 2:
    status_name = "INVALID_NODETYPE";
    break;
  case 3:
    status_name = "INVALID_HWID";
    break;
  case 4:
    status_name = "INVALID_CTXID";
    break;
  case 5:
    status_name = "INVALID_OCHNID";
    break;
  case 6:
    status_name = "INVALID_ICHNID";
    break;
  case 7:
    status_name = "INVALID_FORMAT";
    break;
  case 8:
    status_name = "INVALID_NULL_PTR";
    break;
  case 9:
    status_name = "INVALID_PARAMETER";
    break;
  case 10:
    status_name = "ILLEGAL_ATTR";
    break;
  case 11:
    status_name = "INVALID_FLOW";
    break;
  case 15:
    status_name = "NODE_UNEXIST";
    break;
  case 0x22:
    status_name = "SET_CONTROL_FAIL";
    break;
  case 0x23:
    status_name = "GET_CONTROL_FAIL";
    break;
  case 0x80:
    status_name = "ERR_UNKNOWN";
    break;
  default:
    status_name = "UNKNOWN";
    break;
  }

  snprintf(buf, sizeof(buf), "%s_%s (0x%X)", module_name, status_name, code);
  return buf;
}

static void print_usage(const char *prog) {
  printf("Usage: %s --camera <0|1> [options]\n\n", prog);
  printf("Low-light ISP Enhancement Tool\n\n");
  printf("Options:\n");
  printf("  --camera <idx>     Camera index (0 or 1) [required]\n");
  printf("\n[Image Adjustment]\n");
  printf("  --brightness <val> Brightness [-127, 127] (default: %.1f)\n",
         DEFAULT_BRIGHTNESS);
  printf("  --contrast <val>   Contrast [0, 1.999] (default: %.1f)\n",
         DEFAULT_CONTRAST);
  printf("  --saturation <val> Saturation [0, 1.999] (default: %.1f)\n",
         DEFAULT_SATURATION);
  printf("  --gamma <val>      Gamma value (default: %.1f, <1.0 brightens)\n",
         DEFAULT_GAMMA);
  printf("\n[Exposure]\n");
  printf("  --ae-target <val>  AE target brightness [0, 255] (default: %.1f)\n",
         DEFAULT_AE_TARGET);
  printf("  --dgain-max <val>  Max digital gain (default: %.1f)\n",
         DEFAULT_DGAIN_MAX);
  printf("\n[Noise Reduction & Sharpness]\n");
  printf(
      "  --3dnr <val>       3D Noise Reduction strength [0-128] (temporal)\n");
  printf("  --2dnr <val>       2D Noise Reduction blend [0-1.0] (spatial)\n");
  printf("  --sharpness <val>  Edge Enhancement strength [0-255]\n");
  printf("\n[Dynamic Range (Anti-Clipping)]\n");
  printf("  --wdr <val>        WDR strength [0-255] (overall dynamic range "
         "compression)\n");
  printf("  --shadow <val>     Shadow boost [0-2.0] (lifts dark areas)\n");
  printf("  --hlc <val>        Highlight compression [0-255] (prevents "
         "clipping)\n");
  printf("\n[Control]\n");
  printf("  --reset            Reset to default ISP values\n");
  printf("  --dump             Dump current ISP settings only\n");
  printf("  --save             Save before/after frames to %s\n", g_output_dir);
  printf("  --patterns <N>     Test N random patterns (randomize unspecified "
         "params)\n");
  printf("  --help             Show this help\n\n");
  printf("Example (low-light with noise reduction):\n");
  printf("  %s --camera 1 --brightness 30 --gamma 0.7 --3dnr 110 --2dnr 0.6 "
         "--save\n",
         prog);
  printf("\nExample (prevent highlight clipping with aggressive WDR):\n");
  printf("  %s --camera 1 --wdr 200 --hlc 200 --shadow 2.0 --brightness 10 "
         "--save\n",
         prog);
  printf("\nExample (moderate WDR with shadow boost):\n");
  printf("  %s --camera 1 --wdr 150 --shadow 1.5 --hlc 150 --save\n", prog);
  printf("\nExample (test 5 random patterns with fixed brightness):\n");
  printf("  %s --camera 1 --brightness 30 --patterns 5 --save\n", prog);
}

static int parse_args(int argc, char **argv, config_t *cfg) {
  static struct option long_options[] = {
      {"camera", required_argument, 0, 'c'},
      {"brightness", required_argument, 0, 'b'},
      {"contrast", required_argument, 0, 'n'},
      {"saturation", required_argument, 0, 's'},
      {"gamma", required_argument, 0, 'g'},
      {"ae-target", required_argument, 0, 't'},
      {"dgain-max", required_argument, 0, 'd'},
      {"3dnr", required_argument, 0, '3'},
      {"2dnr", required_argument, 0, '2'},
      {"sharpness", required_argument, 0, 'e'},
      {"wdr", required_argument, 0, 'w'},
      {"shadow", required_argument, 0, 'W'},
      {"hlc", required_argument, 0, 'H'},
      {"reset", no_argument, 0, 'r'},
      {"dump", no_argument, 0, 'D'},
      {"save", no_argument, 0, 'S'},
      {"patterns", required_argument, 0, 'P'},
      {"help", no_argument, 0, 'h'},
      {0, 0, 0, 0}};

  // Set defaults
  cfg->camera_index = -1;
  cfg->brightness = DEFAULT_BRIGHTNESS;
  cfg->contrast = DEFAULT_CONTRAST;
  cfg->saturation = DEFAULT_SATURATION;
  cfg->gamma = DEFAULT_GAMMA;
  cfg->ae_target = DEFAULT_AE_TARGET;
  cfg->dgain_max = DEFAULT_DGAIN_MAX;
  cfg->denoise_3d = -1; // -1 = don't change
  cfg->denoise_2d = -1.0f;
  cfg->sharpness = -1;
  cfg->wdr = -1;
  cfg->shadow_boost = 0.0f;
  cfg->hlc = -1;
  cfg->reset = 0;
  cfg->dump_only = 0;
  cfg->save_frames = 0;
  cfg->patterns = 0;
  // Initialize tracking flags
  cfg->brightness_set = false;
  cfg->contrast_set = false;
  cfg->saturation_set = false;
  cfg->gamma_set = false;
  cfg->ae_target_set = false;
  cfg->dgain_max_set = false;
  cfg->denoise_3d_set = false;
  cfg->denoise_2d_set = false;
  cfg->sharpness_set = false;
  cfg->wdr_set = false;
  cfg->shadow_boost_set = false;
  cfg->hlc_set = false;

  int opt;
  while ((opt = getopt_long(argc, argv, "c:b:n:s:g:t:d:3:2:e:w:W:H:rDSP:h",
                            long_options, NULL)) != -1) {
    switch (opt) {
    case 'c':
      cfg->camera_index = atoi(optarg);
      break;
    case 'b':
      cfg->brightness = atof(optarg);
      cfg->brightness_set = true;
      break;
    case 'n':
      cfg->contrast = atof(optarg);
      cfg->contrast_set = true;
      break;
    case 's':
      cfg->saturation = atof(optarg);
      cfg->saturation_set = true;
      break;
    case 'g':
      cfg->gamma = atof(optarg);
      cfg->gamma_set = true;
      break;
    case 't':
      cfg->ae_target = atof(optarg);
      cfg->ae_target_set = true;
      break;
    case 'd':
      cfg->dgain_max = atof(optarg);
      cfg->dgain_max_set = true;
      break;
    case '3':
      cfg->denoise_3d = atoi(optarg);
      cfg->denoise_3d_set = true;
      if (cfg->denoise_3d < 0)
        cfg->denoise_3d = 0;
      if (cfg->denoise_3d > 128)
        cfg->denoise_3d = 128;
      break;
    case '2':
      cfg->denoise_2d = atof(optarg);
      cfg->denoise_2d_set = true;
      if (cfg->denoise_2d < 0)
        cfg->denoise_2d = 0;
      if (cfg->denoise_2d > 1.0f)
        cfg->denoise_2d = 1.0f;
      break;
    case 'e':
      cfg->sharpness = atoi(optarg);
      cfg->sharpness_set = true;
      if (cfg->sharpness < 0)
        cfg->sharpness = 0;
      if (cfg->sharpness > 255)
        cfg->sharpness = 255;
      break;
    case 'w':
      cfg->wdr = atoi(optarg);
      cfg->wdr_set = true;
      if (cfg->wdr < 0)
        cfg->wdr = 0;
      if (cfg->wdr > 255)
        cfg->wdr = 255;
      break;
    case 'W':
      cfg->shadow_boost = atof(optarg);
      cfg->shadow_boost_set = true;
      if (cfg->shadow_boost < 0)
        cfg->shadow_boost = 0;
      if (cfg->shadow_boost > 2.0f)
        cfg->shadow_boost = 2.0f;
      break;
    case 'H':
      cfg->hlc = atoi(optarg);
      cfg->hlc_set = true;
      if (cfg->hlc < 0)
        cfg->hlc = 0;
      if (cfg->hlc > 255)
        cfg->hlc = 255;
      break;
    case 'r':
      cfg->reset = 1;
      break;
    case 'D':
      cfg->dump_only = 1;
      break;
    case 'S':
      cfg->save_frames = 1;
      break;
    case 'P':
      cfg->patterns = atoi(optarg);
      if (cfg->patterns < 1)
        cfg->patterns = 1;
      if (cfg->patterns > 100)
        cfg->patterns = 100;
      break;
    case 'h':
    default:
      print_usage(argv[0]);
      return -1;
    }
  }

  if (cfg->camera_index < 0 || cfg->camera_index > 1) {
    fprintf(stderr, "Error: --camera must be 0 or 1\n");
    print_usage(argv[0]);
    return -1;
  }

  return 0;
}

static int init_vio_pipeline(vio_handles_t *h, int camera_index) {
  int ret;
  uint32_t mipi_host = (camera_index == 1) ? 2 : 0;
  uint32_t hw_id = mipi_host;

  const int sensor_width = 1920;
  const int sensor_height = 1080;
  const int fps = 30;

  printf("[VIO] Initializing pipeline for camera %d (MIPI Host %d)\n",
         camera_index, mipi_host);

  // Initialize memory manager
  ret = hb_mem_module_open();
  if (ret != 0) {
    fprintf(stderr, "[VIO] hb_mem_module_open failed: %d\n", ret);
    return ret;
  }

  // MIPI configuration
  h->mipi_config = (mipi_config_t){.rx_enable = 1,
                                   .rx_attr =
                                       {
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
                                   }};

  // Camera configuration
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

  // Create camera
  ret = hbn_camera_create(&h->camera_config, &h->cam_fd);
  if (ret != 0) {
    fprintf(stderr, "[VIO] hbn_camera_create failed: %d\n", ret);
    return ret;
  }

  // Create VIN node
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
      .vin_basic_attr =
          {
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
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ichn_attr(h->vin_handle, 0, &vin_ichn_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ochn_attr(h->vin_handle, 0, &vin_ochn_attr);
  if (ret != 0)
    return ret;

  hbn_buf_alloc_attr_t alloc_attr = {
      .buffers_num = 3,
      .is_contig = 1,
      .flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
               HB_MEM_USAGE_CACHED,
  };
  ret = hbn_vnode_set_ochn_buf_attr(h->vin_handle, 0, &alloc_attr);
  if (ret != 0)
    return ret;

  // Create ISP node
  isp_attr_t isp_attr = {
      .input_mode = 1,
      .sensor_mode = ISP_NORMAL_M,
      .crop =
          {
              .x = 0,
              .y = 0,
              .w = sensor_width,
              .h = sensor_height,
          },
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
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ichn_attr(h->isp_handle, 0, &isp_ichn_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ochn_attr(h->isp_handle, 0, &isp_ochn_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ochn_buf_attr(h->isp_handle, 0, &alloc_attr);
  if (ret != 0)
    return ret;

  // Create VSE node (simplified, just one channel for testing)
  vse_attr_t vse_attr = {0};
  vse_ichn_attr_t vse_ichn_attr = {
      .width = sensor_width,
      .height = sensor_height,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  vse_ochn_attr_t vse_ochn_attr = {
      .chn_en = CAM_TRUE,
      .roi = {.x = 0, .y = 0, .w = sensor_width, .h = sensor_height},
      .target_w = 640,
      .target_h = 480,
      .fmt = FRM_FMT_NV12,
      .bit_width = 8,
  };

  ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &h->vse_handle);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_attr(h->vse_handle, &vse_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ichn_attr(h->vse_handle, 0, &vse_ichn_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ochn_attr(h->vse_handle, 0, &vse_ochn_attr);
  if (ret != 0)
    return ret;

  ret = hbn_vnode_set_ochn_buf_attr(h->vse_handle, 0, &alloc_attr);
  if (ret != 0)
    return ret;

  // Create vflow and bind nodes
  ret = hbn_vflow_create(&h->vflow_fd);
  if (ret != 0)
    return ret;

  ret = hbn_vflow_add_vnode(h->vflow_fd, h->vin_handle);
  if (ret != 0)
    return ret;

  ret = hbn_vflow_add_vnode(h->vflow_fd, h->isp_handle);
  if (ret != 0)
    return ret;

  ret = hbn_vflow_add_vnode(h->vflow_fd, h->vse_handle);
  if (ret != 0)
    return ret;

  // Bind: VIN -> ISP -> VSE
  ret = hbn_vflow_bind_vnode(h->vflow_fd, h->vin_handle, 1, h->isp_handle, 0);
  if (ret != 0)
    return ret;

  ret = hbn_vflow_bind_vnode(h->vflow_fd, h->isp_handle, 0, h->vse_handle, 0);
  if (ret != 0)
    return ret;

  // Attach camera to VIN
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
  if (h->vse_handle > 0)
    hbn_vnode_close(h->vse_handle);
  if (h->isp_handle > 0)
    hbn_vnode_close(h->isp_handle);
  if (h->vin_handle > 0)
    hbn_vnode_close(h->vin_handle);
  if (h->cam_fd > 0)
    hbn_camera_destroy(h->cam_fd);
  hb_mem_module_close();
  printf("[VIO] Pipeline destroyed\n");
}

static void dump_exposure_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_exposure_attr_t exp_attr = {0};
  int ret = hbn_isp_get_exposure_attr(isp_handle, &exp_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get exposure attr: %s\n",
            hbn_strerror(ret));
    return;
  }

  printf("\n=== Exposure Settings ===\n");
  printf("Mode: %s\n", exp_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");
  printf("Lock state: %u\n", exp_attr.lock_state);

  printf("\nAuto Attr:\n");
  printf("  Exp time range: [%.6f, %.6f] s\n",
         exp_attr.auto_attr.exp_time_range.min,
         exp_attr.auto_attr.exp_time_range.max);
  printf("  Again range: [%.2f, %.2f]\n", exp_attr.auto_attr.again_range.min,
         exp_attr.auto_attr.again_range.max);
  printf("  Dgain range: [%.2f, %.2f]\n", exp_attr.auto_attr.dgain_range.min,
         exp_attr.auto_attr.dgain_range.max);
  printf("  ISP dgain range: [%.2f, %.2f]\n",
         exp_attr.auto_attr.isp_dgain_range.min,
         exp_attr.auto_attr.isp_dgain_range.max);
  printf("  Target brightness: %.1f\n", exp_attr.auto_attr.target);
  printf("  Tolerance: %.2f\n", exp_attr.auto_attr.tolerance);

  printf("\nManual/Current Attr:\n");
  printf("  Exp time: %.6f s\n", exp_attr.manual_attr.exp_time);
  printf("  Again: %.2f\n", exp_attr.manual_attr.again);
  printf("  Dgain: %.2f\n", exp_attr.manual_attr.dgain);
  printf("  ISP gain: %.2f\n", exp_attr.manual_attr.ispgain);
  printf("  Current lux: %u\n", exp_attr.manual_attr.cur_lux);
}

static void dump_color_process_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_color_process_attr_t cproc_attr = {0};
  int ret = hbn_isp_get_color_process_attr(isp_handle, &cproc_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get color process attr: %s\n",
            hbn_strerror(ret));
    return;
  }

  printf("\n=== Color Processing Settings ===\n");
  printf("Mode: %s\n",
         cproc_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr:\n");
  printf("  Brightness: %.2f\n", cproc_attr.manual_attr.bright);
  printf("  Contrast: %.3f\n", cproc_attr.manual_attr.contrast);
  printf("  Saturation: %.3f\n", cproc_attr.manual_attr.saturation);
  printf("  Hue: %.2f\n", cproc_attr.manual_attr.hue);
}

static void dump_gamma_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_gc_attr_t gc_attr = {0};
  int ret = hbn_isp_get_gc_attr(isp_handle, &gc_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get gamma attr: %s\n", hbn_strerror(ret));
    return;
  }

  printf("\n=== Gamma Correction Settings ===\n");
  printf("Mode: %s\n", gc_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr:\n");
  printf("  Standard mode: %s\n",
         gc_attr.manual_attr.standard ? "true" : "false");
  printf("  Standard value: %.3f\n", gc_attr.manual_attr.standard_val);

  // Print first and last few curve points
  printf("  Curve (first 8): ");
  for (int i = 0; i < 8 && i < HBN_GC_CURVE_SIZE; i++) {
    printf("%u ", gc_attr.manual_attr.curve[i]);
  }
  printf("...\n");
  printf("  Curve (last 8): ");
  for (int i = HBN_GC_CURVE_SIZE - 8; i < HBN_GC_CURVE_SIZE; i++) {
    printf("%u ", gc_attr.manual_attr.curve[i]);
  }
  printf("\n");
}

static void dump_3dnr_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_3dnr_attr_t tnr_attr = {0};
  int ret = hbn_isp_get_3dnr_attr(isp_handle, &tnr_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get 3DNR attr: %s\n", hbn_strerror(ret));
    return;
  }

  printf("\n=== 3DNR (Temporal Noise Reduction) Settings ===\n");
  printf("Mode: %s\n", tnr_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr:\n");
  printf("  TNR Strength: %u\n", tnr_attr.manual_attr.tnr_strength);
  printf("  TNR Strength2: %u\n", tnr_attr.manual_attr.tnr_strength2);
  printf("  Filter Len: %u\n", tnr_attr.manual_attr.filter_len);
  printf("  Filter Len2: %u\n", tnr_attr.manual_attr.filter_len2);
  printf("  Motion Smooth Factor: %.3f\n",
         tnr_attr.manual_attr.motion_smooth_factor);
  printf("  VST Factor: %.3f\n", tnr_attr.manual_attr.vst_factor);
  printf("  Noise Level: %u\n", tnr_attr.manual_attr.noise_level);
}

static void dump_2dnr_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_2dnr_attr_t snr_attr = {0};
  int ret = hbn_isp_get_2dnr_attr(isp_handle, &snr_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get 2DNR attr: %s\n", hbn_strerror(ret));
    return;
  }

  printf("\n=== 2DNR (Spatial Noise Reduction) Settings ===\n");
  printf("Mode: %s\n", snr_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr:\n");
  printf("  Blend Static: %.3f\n", snr_attr.manual_attr.blend_static);
  printf("  Blend Motion: %.3f\n", snr_attr.manual_attr.blend_motion);
  printf("  Blend Slope: %.3f\n", snr_attr.manual_attr.blend_slope);
  printf("  VST Factor: %.3f\n", snr_attr.manual_attr.vst_factor);
  printf("  Sigma Offset: %u\n", snr_attr.manual_attr.sigma_offset);
}

static void dump_ee_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_ee_attr_t ee_attr = {0};
  int ret = hbn_isp_get_ee_attr(isp_handle, &ee_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get EE attr: %s\n", hbn_strerror(ret));
    return;
  }

  printf("\n=== Edge Enhancement (Sharpness) Settings ===\n");
  printf("Mode: %s\n", ee_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr:\n");
  printf("  Src Strength: %u\n", ee_attr.manual_attr.src_strength);
  printf("  Src Strength Skin: %u\n", ee_attr.manual_attr.src_strength_skin);
  printf("  Enhancement Strength: %u\n",
         ee_attr.manual_attr.enhancement_attr.strength);
  printf("  Sharp Curve Level: %u\n",
         ee_attr.manual_attr.enhancement_attr.sharp_curve_lvl);
  printf("  Sharp Gain Up: %u\n",
         ee_attr.manual_attr.enhancement_attr.sharp_gain.up);
  printf("  Sharp Gain Down: %u\n",
         ee_attr.manual_attr.enhancement_attr.sharp_gain.down);
  printf("  Edge NR Level: %u\n",
         ee_attr.manual_attr.edge_detail_attr.edge_nr_lvl);
  printf("  Detail Level: %u\n",
         ee_attr.manual_attr.edge_detail_attr.detail_lvl);
}

static void dump_wdr_attr(hbn_vnode_handle_t isp_handle) {
  hbn_isp_wdr_attr_t wdr_attr = {0};
  int ret = hbn_isp_get_wdr_attr(isp_handle, &wdr_attr);
  if (ret != 0) {
    fprintf(stderr, "[ISP] Failed to get WDR attr: %s\n", hbn_strerror(ret));
    return;
  }

  printf("\n=== WDR (Wide Dynamic Range) Settings ===\n");
  printf("Mode: %s\n", wdr_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

  printf("\nManual Attr (Strength):\n");
  printf("  Strength: %u\n", wdr_attr.manual_attr.strength_attr.strength);
  printf("  High Strength: %u\n",
         wdr_attr.manual_attr.strength_attr.high_strength);
  printf("  Low Strength: %u\n",
         wdr_attr.manual_attr.strength_attr.low_strength);

  printf("\nManual Attr (GTM - Global Tone Mapping):\n");
  printf("  Curve Select: %u\n",
         wdr_attr.manual_attr.gtm_attr.wdr_curve_select);
  printf("  Log Weight: %u\n", wdr_attr.manual_attr.gtm_attr.log_weight);
  printf("  Flat Level Global: %u\n",
         wdr_attr.manual_attr.gtm_attr.flat_level_global);
  printf("  Curve2 Lo Factor: %.3f\n",
         wdr_attr.manual_attr.gtm_attr.curve2_lofactor);
  printf("  Curve2 Hi Factor: %.3f\n",
         wdr_attr.manual_attr.gtm_attr.curve2_hifactor);

  printf("\nManual Attr (Highlight Control):\n");
  printf("  HLC Base Log: %.3f\n",
         wdr_attr.manual_attr.high_light_attr.hlc_base_log);
  printf("  HLC Slope: %u\n", wdr_attr.manual_attr.high_light_attr.hlc_slope);

  printf("\nManual Attr (Gain Limitation):\n");
  printf("  Max Gain: %u\n",
         wdr_attr.manual_attr.gain_limitation_attr.max_gain);
  printf("  Min Gain: %u\n",
         wdr_attr.manual_attr.gain_limitation_attr.min_gain);

  printf("\nManual Attr (LTM - Local Tone Mapping):\n");
  printf("  Contrast: %d\n", wdr_attr.manual_attr.ltm_weight_attr.contrast);
  printf("  Dark Attention Level: %u\n",
         wdr_attr.manual_attr.ltm_attr.dark_attention_level);
  printf("  Flat Mode: %s\n",
         wdr_attr.manual_attr.ltm_attr.flat_mode ? "ON" : "OFF");
  printf("  Flat Level: %u\n", wdr_attr.manual_attr.ltm_attr.flat_evel);
}

static int apply_lowlight_enhancement(vio_handles_t *h, config_t *cfg) {
  int ret;

  printf("\n=== Applying Low-Light Enhancement ===\n");

  // 1. Apply Color Processing (Brightness, Contrast, Saturation)
  printf("\n[1] Setting Color Processing (CPROC)...\n");
  printf("  Brightness: %.1f, Contrast: %.2f, Saturation: %.2f\n",
         cfg->brightness, cfg->contrast, cfg->saturation);

  hbn_isp_color_process_attr_t cproc_attr = {0};
  ret = hbn_isp_get_color_process_attr(h->isp_handle, &cproc_attr);
  if (ret != 0) {
    fprintf(stderr, "  Failed to get CPROC attr: %s\n", hbn_strerror(ret));
    return ret;
  }

  // Switch to manual mode and set values
  cproc_attr.mode = HBN_ISP_MODE_MANUAL;
  cproc_attr.manual_attr.bright = cfg->brightness;
  cproc_attr.manual_attr.contrast = cfg->contrast;
  cproc_attr.manual_attr.saturation = cfg->saturation;
  cproc_attr.manual_attr.hue = 0.0f; // No hue shift

  ret = hbn_isp_set_color_process_attr(h->isp_handle, &cproc_attr);
  if (ret != 0) {
    fprintf(stderr, "  Failed to set CPROC attr: %s\n", hbn_strerror(ret));
    return ret;
  }
  printf("  CPROC applied successfully\n");

  // 2. Apply Gamma Correction
  printf("\n[2] Setting Gamma Correction (GC)...\n");
  printf("  Gamma value: %.2f (< 1.0 brightens dark areas)\n", cfg->gamma);

  hbn_isp_gc_attr_t gc_attr = {0};
  ret = hbn_isp_get_gc_attr(h->isp_handle, &gc_attr);
  if (ret != 0) {
    fprintf(stderr, "  Failed to get GC attr: %s\n", hbn_strerror(ret));
    return ret;
  }

  printf("  Current mode: %s, standard: %d, standard_val: %.2f\n",
         gc_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL",
         gc_attr.manual_attr.standard, gc_attr.manual_attr.standard_val);

  // Try approach 1: Keep current mode, just modify standard_val
  float orig_standard_val = gc_attr.manual_attr.standard_val;
  gc_attr.manual_attr.standard = 1;
  gc_attr.manual_attr.standard_val = cfg->gamma;

  ret = hbn_isp_set_gc_attr(h->isp_handle, &gc_attr);
  if (ret != 0) {
    printf("  Approach 1 failed (%s), trying manual mode...\n",
           hbn_strerror(ret));

    // Try approach 2: Switch to manual mode
    gc_attr.mode = HBN_ISP_MODE_MANUAL;
    ret = hbn_isp_set_gc_attr(h->isp_handle, &gc_attr);
    if (ret != 0) {
      printf("  Approach 2 failed (%s), trying custom curve...\n",
             hbn_strerror(ret));

      // Try approach 3: Use custom curve instead of standard formula
      gc_attr.manual_attr.standard = 0;
      gc_attr.manual_attr.standard_val = orig_standard_val;
      generate_gamma_curve(gc_attr.manual_attr.curve, HBN_GC_CURVE_SIZE,
                           cfg->gamma);
      ret = hbn_isp_set_gc_attr(h->isp_handle, &gc_attr);
      if (ret != 0) {
        fprintf(stderr,
                "  Warning: All GC approaches failed: %s (continuing)\n",
                hbn_strerror(ret));
        printf("  Note: Gamma correction may not be supported at runtime.\n");
        printf("  Alternative: Adjust brightness/contrast instead.\n");
      } else {
        printf("  Gamma curve applied successfully\n");
      }
    } else {
      printf("  Gamma applied (manual mode)\n");
    }
  } else {
    printf("  Gamma applied successfully\n");
  }

  // 3. Adjust Exposure settings
  printf("\n[3] Setting Exposure (AE)...\n");
  printf("  Target: %.1f, Max Dgain: %.1f\n", cfg->ae_target, cfg->dgain_max);

  hbn_isp_exposure_attr_t exp_attr = {0};
  ret = hbn_isp_get_exposure_attr(h->isp_handle, &exp_attr);
  if (ret != 0) {
    fprintf(stderr, "  Failed to get exposure attr: %s\n", hbn_strerror(ret));
    return ret;
  }

  // Keep auto mode but adjust parameters
  exp_attr.mode = HBN_ISP_MODE_AUTO;
  exp_attr.auto_attr.target = cfg->ae_target;
  exp_attr.auto_attr.dgain_range.max = cfg->dgain_max;
  exp_attr.auto_attr.isp_dgain_range.max = cfg->dgain_max;

  ret = hbn_isp_set_exposure_attr(h->isp_handle, &exp_attr);
  if (ret != 0) {
    fprintf(stderr, "  Failed to set exposure attr: %s\n", hbn_strerror(ret));
    return ret;
  }
  printf("  Exposure parameters applied successfully\n");

  // 4. Apply 3DNR (Temporal Noise Reduction) if specified
  if (cfg->denoise_3d >= 0) {
    printf("\n[4] Setting 3DNR (Temporal NR)...\n");
    printf("  Strength: %d\n", cfg->denoise_3d);

    hbn_isp_3dnr_attr_t tnr_attr = {0};
    ret = hbn_isp_get_3dnr_attr(h->isp_handle, &tnr_attr);
    if (ret != 0) {
      fprintf(stderr, "  Failed to get 3DNR attr: %s\n", hbn_strerror(ret));
    } else {
      tnr_attr.mode = HBN_ISP_MODE_MANUAL;
      tnr_attr.manual_attr.tnr_strength = (uint8_t)cfg->denoise_3d;
      tnr_attr.manual_attr.tnr_strength2 =
          (uint8_t)(cfg->denoise_3d + 2.5) * 2 / 5;
      // Longer filter for stronger NR (but may cause ghosting)
      tnr_attr.manual_attr.filter_len = (cfg->denoise_3d > 95) ? 20 : 6;
      tnr_attr.manual_attr.filter_len2 = (cfg->denoise_3d > 95) ? 4 : 2;
      tnr_attr.manual_attr.motion_smooth_factor = 3.0;

      ret = hbn_isp_set_3dnr_attr(h->isp_handle, &tnr_attr);
      if (ret != 0) {
        fprintf(stderr, "  Failed to set 3DNR attr: %s\n", hbn_strerror(ret));
      } else {
        printf("  3DNR applied successfully\n");
      }
    }
  }

  // 5. Apply 2DNR (Spatial Noise Reduction) if specified
  if (cfg->denoise_2d >= 0) {
    printf("\n[5] Setting 2DNR (Spatial NR)...\n");
    printf("  Blend: %.2f\n", cfg->denoise_2d);

    hbn_isp_2dnr_attr_t snr_attr = {0};
    ret = hbn_isp_get_2dnr_attr(h->isp_handle, &snr_attr);
    if (ret != 0) {
      fprintf(stderr, "  Failed to get 2DNR attr: %s\n", hbn_strerror(ret));
    } else {
      snr_attr.mode = HBN_ISP_MODE_MANUAL;
      snr_attr.manual_attr.blend_static = cfg->denoise_2d;
      snr_attr.manual_attr.blend_motion =
          cfg->denoise_2d * 0.5f; // Less NR for motion
      snr_attr.manual_attr.blend_slope = 0.5f;

      ret = hbn_isp_set_2dnr_attr(h->isp_handle, &snr_attr);
      if (ret != 0) {
        fprintf(stderr, "  Failed to set 2DNR attr: %s\n", hbn_strerror(ret));
      } else {
        printf("  2DNR applied successfully\n");
      }
    }
  }

  // 6. Apply Edge Enhancement (Sharpness) if specified
  if (cfg->sharpness >= 0) {
    printf("\n[6] Setting Edge Enhancement (Sharpness)...\n");
    printf("  Strength: %d\n", cfg->sharpness);

    hbn_isp_ee_attr_t ee_attr = {0};
    ret = hbn_isp_get_ee_attr(h->isp_handle, &ee_attr);
    if (ret != 0) {
      fprintf(stderr, "  Failed to get EE attr: %s\n", hbn_strerror(ret));
    } else {
      printf("  Current mode: %s\n",
             ee_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

      int ee_ret = -1; // Track EE-specific result

      // Try approach 1: Keep AUTO mode, adjust auto_level
      if (ee_attr.mode == HBN_ISP_MODE_AUTO) {
        // Map sharpness 0-255 to auto_level (typically 0-10 or similar)
        uint8_t auto_level = (uint8_t)(cfg->sharpness * 10 / 255);
        ee_attr.auto_attr.auto_level = auto_level;
        printf("  Trying AUTO mode with level %u...\n", auto_level);

        ee_ret = hbn_isp_set_ee_attr(h->isp_handle, &ee_attr);
        if (ee_ret == 0) {
          printf("  Edge Enhancement applied (AUTO mode)\n");
        }
      }

      if (ee_ret != 0) {
        // Try approach 2: Switch to manual mode, minimal changes
        printf("  Trying MANUAL mode...\n");
        ee_attr.mode = HBN_ISP_MODE_MANUAL;
        // Only modify the strength, preserve other values from get
        ee_attr.manual_attr.enhancement_attr.strength = (uint8_t)cfg->sharpness;

        ee_ret = hbn_isp_set_ee_attr(h->isp_handle, &ee_attr);
        if (ee_ret != 0) {
          fprintf(stderr, "  Warning: Failed to set EE attr: %s (continuing)\n",
                  hbn_strerror(ee_ret));
          printf(
              "  Note: Edge Enhancement may not be adjustable at runtime.\n");
        } else {
          printf("  Edge Enhancement applied (MANUAL mode)\n");
        }
      }
    }
  }

  // 7. Apply WDR (Wide Dynamic Range) for highlight protection
  if (cfg->wdr >= 0 || cfg->shadow_boost > 0 || cfg->hlc >= 0) {
    printf("\n[7] Setting WDR (Wide Dynamic Range)...\n");
    printf("  WDR Strength: %d, Shadow Boost: %.2f, HLC: %d\n", cfg->wdr,
           cfg->shadow_boost, cfg->hlc);

    hbn_isp_wdr_attr_t wdr_attr = {0};
    ret = hbn_isp_get_wdr_attr(h->isp_handle, &wdr_attr);
    if (ret != 0) {
      fprintf(stderr, "  Failed to get WDR attr: %s\n", hbn_strerror(ret));
    } else {
      printf("  Current mode: %s\n",
             wdr_attr.mode == HBN_ISP_MODE_AUTO ? "AUTO" : "MANUAL");

      // Print current values for debugging
      printf("  Current high_strength: %u, low_strength: %u\n",
             wdr_attr.manual_attr.strength_attr.high_strength,
             wdr_attr.manual_attr.strength_attr.low_strength);
      printf("  Current dark_attention: %u, contrast: %d\n",
             wdr_attr.manual_attr.ltm_attr.dark_attention_level,
             wdr_attr.manual_attr.ltm_weight_attr.contrast);
      printf("  Current hlc_base_log: %.3f, hlc_slope: %u\n",
             wdr_attr.manual_attr.high_light_attr.hlc_base_log,
             wdr_attr.manual_attr.high_light_attr.hlc_slope);
      printf("  Current max_gain: %u, min_gain: %u\n",
             wdr_attr.manual_attr.gain_limitation_attr.max_gain,
             wdr_attr.manual_attr.gain_limitation_attr.min_gain);

      int wdr_ret = -1;

      // Try approach 1: Keep AUTO mode, adjust auto_level
      if (wdr_attr.mode == HBN_ISP_MODE_AUTO) {
        uint8_t wdr_level = cfg->wdr >= 0 ? (uint8_t)(cfg->wdr * 10 / 255) : 5;
        wdr_attr.auto_attr.auto_level = wdr_level;
        printf("  Trying AUTO mode with level %u...\n", wdr_level);

        wdr_ret = hbn_isp_set_wdr_attr(h->isp_handle, &wdr_attr);
        if (wdr_ret == 0) {
          printf("  WDR applied (AUTO mode)\n");
        }
      }

      if (wdr_ret != 0) {
        // Try approach 2: Manual mode with aggressive settings
        printf(
            "  Trying MANUAL mode with aggressive highlight compression...\n");
        wdr_attr.mode = HBN_ISP_MODE_MANUAL;

        if (cfg->wdr >= 0) {
          // WDR strength controls overall dynamic range compression
          wdr_attr.manual_attr.strength_attr.strength = (uint8_t)cfg->wdr;
          // high_strength: CRUCIAL for highlight compression
          // Higher value = more aggressive highlight compression
          wdr_attr.manual_attr.strength_attr.high_strength =
              (uint8_t)(cfg->wdr > 128 ? 255 : cfg->wdr * 2);
          // low_strength: for shadow region boost
          wdr_attr.manual_attr.strength_attr.low_strength =
              (uint16_t)(cfg->wdr * 4);
          printf("  Set strength=%u, high_strength=%u, low_strength=%u\n",
                 wdr_attr.manual_attr.strength_attr.strength,
                 wdr_attr.manual_attr.strength_attr.high_strength,
                 wdr_attr.manual_attr.strength_attr.low_strength);
        }

        if (cfg->shadow_boost > 0) {
          // Maximize dark attention for shadow lifting (max 255)
          uint8_t dark_level = (uint8_t)(cfg->shadow_boost * 127);
          if (dark_level < 64)
            dark_level = 64; // Minimum effective value
          wdr_attr.manual_attr.ltm_attr.dark_attention_level = dark_level;
          // Lower contrast for smoother tone mapping (prevents clipping)
          int16_t new_contrast = (int16_t)(30 - cfg->shadow_boost * 20);
          if (new_contrast < 0)
            new_contrast = 0;
          wdr_attr.manual_attr.ltm_weight_attr.contrast = new_contrast;
          // Enable flat mode for more uniform processing
          wdr_attr.manual_attr.ltm_attr.flat_mode = 1;
          wdr_attr.manual_attr.ltm_attr.flat_evel = 128;
          printf("  Set dark_attention=%u, contrast=%d, flat_mode=1\n",
                 dark_level, new_contrast);
        }

        // HLC (Highlight Control) - Key for preventing white clipping
        if (cfg->hlc >= 0) {
          // hlc_slope: Higher = more aggressive highlight compression (0-255)
          wdr_attr.manual_attr.high_light_attr.hlc_slope = (uint8_t)cfg->hlc;
          // hlc_base_log: Threshold for highlight compression
          // Lower value = compress more of the bright range
          // Typical range: 0.0 to 3.0, lower is more aggressive
          float hlc_threshold = 2.0f - (cfg->hlc / 255.0f) * 1.5f;
          if (hlc_threshold < 0.5f)
            hlc_threshold = 0.5f;
          wdr_attr.manual_attr.high_light_attr.hlc_base_log = hlc_threshold;
          printf("  Set hlc_slope=%u, hlc_base_log=%.2f\n", cfg->hlc,
                 hlc_threshold);
        } else if (cfg->wdr >= 0) {
          // Auto-set HLC based on WDR strength if not explicitly set
          wdr_attr.manual_attr.high_light_attr.hlc_slope =
              (uint8_t)(cfg->wdr > 128 ? 200 : cfg->wdr + 50);
          wdr_attr.manual_attr.high_light_attr.hlc_base_log = 1.5f;
          printf("  Auto-set hlc_slope=%u, hlc_base_log=1.5\n",
                 wdr_attr.manual_attr.high_light_attr.hlc_slope);
        }

        // GTM (Global Tone Mapping) for better tonal distribution
        // log_weight: Higher = more compression in highlights
        wdr_attr.manual_attr.gtm_attr.log_weight = 200;
        // flat_level_global: Higher = more uniform output
        wdr_attr.manual_attr.gtm_attr.flat_level_global = 128;
        // curve settings for highlight protection
        wdr_attr.manual_attr.gtm_attr.curve2_hifactor = 0.5f; // Compress highs
        wdr_attr.manual_attr.gtm_attr.curve2_lofactor = 1.5f; // Boost lows
        printf("  Set GTM log_weight=200, flat_level=128, hi_factor=0.5, "
               "lo_factor=1.5\n");

        // Gain limitation - CRITICAL to prevent over-exposure
        // Lower max_gain prevents excessive amplification that causes clipping
        uint16_t max_gain = 512; // Reduced from 1024
        if (cfg->wdr >= 0 && cfg->wdr > 128) {
          max_gain = 256; // Even more conservative for high WDR
        }
        wdr_attr.manual_attr.gain_limitation_attr.max_gain = max_gain;
        wdr_attr.manual_attr.gain_limitation_attr.min_gain = 64;
        printf("  Set max_gain=%u, min_gain=64\n", max_gain);

        wdr_ret = hbn_isp_set_wdr_attr(h->isp_handle, &wdr_attr);
        if (wdr_ret != 0) {
          fprintf(stderr,
                  "  Warning: Failed to set WDR attr: %s (continuing)\n",
                  hbn_strerror(wdr_ret));
          printf("  Note: WDR may not be adjustable at runtime.\n");
          printf("  Alternative: Reduce brightness and use CPROC contrast.\n");
        } else {
          printf("  WDR applied (MANUAL mode)\n");
        }
      }
    }
  }

  printf("\n=== Low-Light Enhancement Applied ===\n");
  return 0;
}

static int reset_to_defaults(vio_handles_t *h) {
  int ret;

  printf("\n=== Resetting ISP to Defaults ===\n");

  // Reset Color Processing to auto
  hbn_isp_color_process_attr_t cproc_attr = {0};
  ret = hbn_isp_get_color_process_attr(h->isp_handle, &cproc_attr);
  if (ret == 0) {
    cproc_attr.mode = HBN_ISP_MODE_AUTO;
    cproc_attr.manual_attr.bright = 0.0f;
    cproc_attr.manual_attr.contrast = 1.0f;
    cproc_attr.manual_attr.saturation = 1.0f;
    cproc_attr.manual_attr.hue = 0.0f;
    ret = hbn_isp_set_color_process_attr(h->isp_handle, &cproc_attr);
    printf("CPROC reset: %s\n", ret == 0 ? "OK" : "FAILED");
  }

  // Reset Gamma to auto
  hbn_isp_gc_attr_t gc_attr = {0};
  ret = hbn_isp_get_gc_attr(h->isp_handle, &gc_attr);
  if (ret == 0) {
    gc_attr.mode = HBN_ISP_MODE_AUTO;
    gc_attr.manual_attr.standard = 1;
    gc_attr.manual_attr.standard_val = 2.2f; // Standard gamma
    ret = hbn_isp_set_gc_attr(h->isp_handle, &gc_attr);
    printf("Gamma reset: %s\n", ret == 0 ? "OK" : "FAILED");
  }

  // Reset Exposure to auto with defaults
  hbn_isp_exposure_attr_t exp_attr = {0};
  ret = hbn_isp_get_exposure_attr(h->isp_handle, &exp_attr);
  if (ret == 0) {
    exp_attr.mode = HBN_ISP_MODE_AUTO;
    exp_attr.auto_attr.target = 50.0f; // Default target
    ret = hbn_isp_set_exposure_attr(h->isp_handle, &exp_attr);
    printf("Exposure reset: %s\n", ret == 0 ? "OK" : "FAILED");
  }

  printf("=== Reset Complete ===\n");
  return 0;
}

// Global config reference for filename generation
static config_t *g_cfg_ptr = NULL;

// Capture a single frame, save it, and show histogram
static int capture_and_analyze(vio_handles_t *h, const char *label,
                               int save_frame) {
  int ret;
  hbn_vnode_image_t frame = {0};

  // Skip first few frames to let AE stabilize
  for (int i = 0; i < 10 && g_running; i++) {
    ret = hbn_vnode_getframe(h->vse_handle, 0, 2000, &frame);
    if (ret == 0) {
      hbn_vnode_releaseframe(h->vse_handle, 0, &frame);
    }
    usleep(33000);
  }

  // Capture the analysis frame
  ret = hbn_vnode_getframe(h->vse_handle, 0, 2000, &frame);
  if (ret != 0) {
    fprintf(stderr, "[VIO] getframe failed: %s\n", hbn_strerror(ret));
    return ret;
  }

  uint8_t *y_data = (uint8_t *)frame.buffer.virt_addr[0];
  uint8_t *uv_data = (uint8_t *)frame.buffer.virt_addr[1];
  size_t y_size = frame.buffer.size[0];
  size_t uv_size = frame.buffer.size[1];

  if (y_data && y_size > 0) {
    // Invalidate cache
    hb_mem_invalidate_buf_with_vaddr((uint64_t)y_data, y_size);
    if (uv_data && uv_size > 0) {
      hb_mem_invalidate_buf_with_vaddr((uint64_t)uv_data, uv_size);
    }

    // Show histogram
    print_histogram(y_data, y_size, label);

    // Save frame if requested
    if (save_frame && g_cfg_ptr) {
      // Create output directory
      mkdir(g_output_dir, 0755);

      char filename[512];
      // Get timestamp for unique filename
      time_t now = time(NULL);
      struct tm *tm_info = localtime(&now);
      char timestamp[32];
      strftime(timestamp, sizeof(timestamp), "%Y%m%d_%H%M%S", tm_info);

      // Determine dimensions from VSE output (640x480)
      int width = 640;
      int height = 480;

      // Create descriptive filename:
      // {timestamp}_cam{N}_{label}_b{B}_c{C}_g{G}_[nr_info]_[wdr_info].nv12
      char nr_info[64] = "";
      if (g_cfg_ptr->denoise_3d >= 0 || g_cfg_ptr->denoise_2d >= 0 ||
          g_cfg_ptr->sharpness >= 0) {
        snprintf(nr_info, sizeof(nr_info), "_3d%d_2d%.0f_sh%d",
                 g_cfg_ptr->denoise_3d >= 0 ? g_cfg_ptr->denoise_3d : 0,
                 g_cfg_ptr->denoise_2d >= 0 ? g_cfg_ptr->denoise_2d * 100 : 0,
                 g_cfg_ptr->sharpness >= 0 ? g_cfg_ptr->sharpness : 0);
      }

      // WDR/HLC/Shadow info for filename
      char wdr_info[64] = "";
      if (g_cfg_ptr->wdr >= 0 || g_cfg_ptr->hlc >= 0 ||
          g_cfg_ptr->shadow_boost > 0) {
        snprintf(wdr_info, sizeof(wdr_info), "_wdr%d_hlc%d_sdw%.0f",
                 g_cfg_ptr->wdr >= 0 ? g_cfg_ptr->wdr : 0,
                 g_cfg_ptr->hlc >= 0 ? g_cfg_ptr->hlc : 0,
                 g_cfg_ptr->shadow_boost * 10);
      }

      snprintf(filename, sizeof(filename),
               "%s/%s_cam%d_%s_b%.0f_c%.1f_g%.1f%s%s.nv12", g_output_dir,
               timestamp, g_cfg_ptr->camera_index, label, g_cfg_ptr->brightness,
               g_cfg_ptr->contrast, g_cfg_ptr->gamma, nr_info, wdr_info);

      save_nv12_frame(filename, y_data, uv_data, y_size, uv_size, width,
                      height);
    }
  }

  hbn_vnode_releaseframe(h->vse_handle, 0, &frame);
  return 0;
}

// Convert NV12 to PNG for easy viewing (helper script generated)
static void generate_convert_script(void) {
  char script_path[512];
  snprintf(script_path, sizeof(script_path), "%s/convert_to_png.sh",
           g_output_dir);

  FILE *fp = fopen(script_path, "w");
  if (!fp)
    return;

  fprintf(fp, "#!/bin/bash\n");
  fprintf(fp, "# Convert NV12 files to PNG for viewing\n");
  fprintf(fp, "# Requires ffmpeg\n\n");
  fprintf(fp, "cd \"%s\"\n", g_output_dir);
  fprintf(fp, "for f in *.nv12; do\n");
  fprintf(fp, "  [ -f \"$f\" ] || continue\n");
  fprintf(fp, "  out=\"${f%%.nv12}.png\"\n");
  fprintf(fp, "  echo \"Converting $f -> $out\"\n");
  fprintf(fp, "  ffmpeg -y -f rawvideo -pixel_format nv12 -video_size 640x480 "
              "-i \"$f\" \"$out\" 2>/dev/null\n");
  fprintf(fp, "done\n");
  fprintf(fp, "echo \"\"\n");
  fprintf(fp, "echo \"Done. PNG files created in %s:\"\n", g_output_dir);
  fprintf(fp, "ls -la *.png 2>/dev/null\n");

  fclose(fp);
  chmod(script_path, 0755);

  printf("\n=== Output Files ===\n");
  printf("Directory: %s\n", g_output_dir);
  printf("Convert script: %s/convert_to_png.sh\n", g_output_dir);
  printf("\nTo view images:\n");
  printf("  1. Run: %s/convert_to_png.sh\n", g_output_dir);
  printf("  2. View PNG files in %s/\n", g_output_dir);
}

// Helper: random float in range [min, max]
static float rand_float(float min, float max) {
  return min + (float)rand() / (float)RAND_MAX * (max - min);
}

// Helper: random int in range [min, max]
static int rand_int(int min, int max) { return min + rand() % (max - min + 1); }

// Randomize unspecified parameters for pattern testing
static void randomize_unset_params(config_t *cfg, const config_t *original) {
  // Brightness: [-50, 80] for low-light enhancement
  if (!original->brightness_set) {
    cfg->brightness = rand_float(-20.0f, 60.0f);
  }

  // Contrast: [0.8, 1.5]
  if (!original->contrast_set) {
    cfg->contrast = rand_float(0.8f, 1.5f);
  }

  // Saturation: [0.5, 1.5]
  if (!original->saturation_set) {
    cfg->saturation = rand_float(0.5f, 1.5f);
  }

  // Gamma: [0.5, 1.2] (< 1.0 for brightening dark areas)
  if (!original->gamma_set) {
    cfg->gamma = rand_float(0.5f, 1.2f);
  }

  // AE target: [40, 100]
  if (!original->ae_target_set) {
    cfg->ae_target = rand_float(40.0f, 100.0f);
  }

  // Dgain max: [4, 32]
  if (!original->dgain_max_set) {
    cfg->dgain_max = rand_float(4.0f, 32.0f);
  }

  // 3DNR: [0, 255] or -1 (disabled) with 20% chance
  if (!original->denoise_3d_set) {
    if (rand() % 5 == 0) {
      cfg->denoise_3d = -1; // 20% chance to disable
    } else {
      cfg->denoise_3d = rand_int(0, 255);
    }
  }

  // 2DNR: [0, 1.0] or -1 (disabled) with 20% chance
  if (!original->denoise_2d_set) {
    if (rand() % 5 == 0) {
      cfg->denoise_2d = -1.0f; // 20% chance to disable
    } else {
      cfg->denoise_2d = rand_float(0.0f, 1.0f);
    }
  }

  // Sharpness: [0, 255] or -1 (disabled) with 20% chance
  if (!original->sharpness_set) {
    if (rand() % 5 == 0) {
      cfg->sharpness = -1; // 20% chance to disable
    } else {
      cfg->sharpness = rand_int(0, 255);
    }
  }
}

// Print current config for pattern testing
static void print_pattern_config(const config_t *cfg, int pattern_num) {
  printf("\n========================================\n");
  printf("Pattern %d Configuration:\n", pattern_num);
  printf("========================================\n");
  printf("  Brightness: %.1f\n", cfg->brightness);
  printf("  Contrast:   %.2f\n", cfg->contrast);
  printf("  Saturation: %.2f\n", cfg->saturation);
  printf("  Gamma:      %.2f\n", cfg->gamma);
  printf("  AE Target:  %.1f\n", cfg->ae_target);
  printf("  Dgain Max:  %.1f\n", cfg->dgain_max);
  printf("  3DNR:       %d%s\n", cfg->denoise_3d,
         cfg->denoise_3d < 0 ? " (disabled)" : "");
  printf("  2DNR:       %.2f%s\n", cfg->denoise_2d,
         cfg->denoise_2d < 0 ? " (disabled)" : "");
  printf("  Sharpness:  %d%s\n", cfg->sharpness,
         cfg->sharpness < 0 ? " (disabled)" : "");
  printf("========================================\n");
}

int main(int argc, char **argv) {
  config_t cfg = {0};
  config_t original_cfg = {0};
  vio_handles_t handles = {0};
  int ret;

  // Parse arguments
  if (parse_args(argc, argv, &cfg) != 0) {
    return 1;
  }

  // Save original config for pattern testing
  memcpy(&original_cfg, &cfg, sizeof(config_t));

  // Setup signal handlers
  signal(SIGINT, signal_handler);
  signal(SIGTERM, signal_handler);

  // Seed random number generator for pattern testing
  srand((unsigned int)time(NULL));

  // Set global config pointer for filename generation
  g_cfg_ptr = &cfg;

  printf("=== ISP Low-Light Enhancement Tool ===\n");
  printf("Camera: %d\n", cfg.camera_index);
  if (cfg.patterns > 0) {
    printf("Pattern testing mode: %d patterns\n", cfg.patterns);
    cfg.save_frames = 1; // Force save in pattern mode
    original_cfg.save_frames = 1;
  }

  // Initialize VIO pipeline
  ret = init_vio_pipeline(&handles, cfg.camera_index);
  if (ret != 0) {
    fprintf(stderr, "Failed to initialize VIO pipeline: %s\n",
            hbn_strerror(ret));
    return 1;
  }

  // Start pipeline for ISP settings to take effect
  ret = hbn_vflow_start(handles.vflow_fd);
  if (ret != 0) {
    fprintf(stderr, "Failed to start vflow: %s\n", hbn_strerror(ret));
    destroy_vio_pipeline(&handles);
    return 1;
  }

  // Let AE stabilize
  printf("Waiting for AE to stabilize...\n");
  sleep(2);

  // Dump current settings
  printf("\n=== Current ISP Settings (Before) ===\n");
  dump_exposure_attr(handles.isp_handle);
  dump_color_process_attr(handles.isp_handle);
  dump_gamma_attr(handles.isp_handle);
  dump_3dnr_attr(handles.isp_handle);
  dump_2dnr_attr(handles.isp_handle);
  dump_ee_attr(handles.isp_handle);
  dump_wdr_attr(handles.isp_handle);

  // Capture and analyze BEFORE frame
  if (g_running && !cfg.dump_only) {
    capture_and_analyze(&handles, "before", cfg.save_frames);
  }

  if (cfg.dump_only) {
    printf("\nDump only mode - no changes applied\n");
    hbn_vflow_stop(handles.vflow_fd);
    destroy_vio_pipeline(&handles);
    return 0;
  }

  // Pattern testing mode
  if (cfg.patterns > 0) {
    printf("\n=== Starting Pattern Testing (%d patterns) ===\n", cfg.patterns);

    for (int p = 1; p <= cfg.patterns && g_running; p++) {
      // Start with original config and randomize unset params
      memcpy(&cfg, &original_cfg, sizeof(config_t));
      randomize_unset_params(&cfg, &original_cfg);

      print_pattern_config(&cfg, p);

      // Apply this pattern's settings
      ret = apply_lowlight_enhancement(&handles, &cfg);
      if (ret != 0) {
        fprintf(stderr, "Pattern %d: Failed to apply settings: %s\n", p,
                hbn_strerror(ret));
        continue; // Try next pattern
      }

      // Wait for settings to take effect
      sleep(1);

      // Capture frame for this pattern
      char label[32];
      snprintf(label, sizeof(label), "pattern%02d", p);
      capture_and_analyze(&handles, label, 1);

      // Reset to defaults before next pattern
      reset_to_defaults(&handles);
      sleep(1);
    }

    printf("\n=== Pattern Testing Complete ===\n");
    printf("Tested %d patterns. Results saved to %s\n", cfg.patterns,
           g_output_dir);
  } else {
    // Single mode (original behavior)
    if (cfg.reset) {
      ret = reset_to_defaults(&handles);
    } else {
      ret = apply_lowlight_enhancement(&handles, &cfg);
    }

    if (ret != 0) {
      fprintf(stderr, "Failed to apply settings: %s\n", hbn_strerror(ret));
      hbn_vflow_stop(handles.vflow_fd);
      destroy_vio_pipeline(&handles);
      return 1;
    }

    // Wait for settings to take effect
    printf("\nWaiting for ISP settings to take effect...\n");
    sleep(2);

    // Dump settings after change
    printf("\n=== ISP Settings (After) ===\n");
    dump_exposure_attr(handles.isp_handle);
    dump_color_process_attr(handles.isp_handle);
    dump_gamma_attr(handles.isp_handle);
    dump_3dnr_attr(handles.isp_handle);
    dump_2dnr_attr(handles.isp_handle);
    dump_ee_attr(handles.isp_handle);
    dump_wdr_attr(handles.isp_handle);

    // Capture and analyze AFTER frame
    if (g_running) {
      capture_and_analyze(&handles, "after", cfg.save_frames);
    }
  }

  // Generate conversion script if frames were saved
  if (cfg.save_frames) {
    generate_convert_script();
  }

  // Cleanup
  hbn_vflow_stop(handles.vflow_fd);
  destroy_vio_pipeline(&handles);

  printf("\nDone.\n");
  return 0;
}
