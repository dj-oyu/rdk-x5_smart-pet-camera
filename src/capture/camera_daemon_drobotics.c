// Copyright (c) 2024, D-Robotics.
// Modified for Smart Pet Camera project with hardware H.264 encoding
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

/*
 * camera_daemon_drobotics.c - Camera capture daemon for D-Robotics platform
 *
 * Hardware H.264 encoding using libspcdev
 * Key features:
 * - Uses D-Robotics libspcdev for VIO and hardware H.264 encoder
 * - Supports Camera 0 and Camera 1
 * - Direct VIO → Encoder binding (zero-copy)
 * - H.264 NAL units output to shared memory
 * - POSIX shared memory for IPC
 * - Daemon mode with signal handling
 */

#include <argp.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "sp_codec.h"
#include "sp_sys.h"
#include "sp_vio.h"

#include "shared_memory.h"

// ANSI Color codes for log output (camera differentiation)
#define ANSI_COLOR_RESET "\x1b[0m"
#define ANSI_COLOR_CAM0 "\x1b[32m" // Green for Camera 0
#define ANSI_COLOR_CAM1 "\x1b[36m" // Cyan for Camera 1

#define OPT_NO_RAW 1001
#define OPT_PRESET 2001
#define OPT_SENSOR_WIDTH 3001
#define OPT_SENSOR_HEIGHT 3002
#define OPT_TIMEOUT 3003
#define OPT_DAEMON 4001

#define SENSOR_WIDTH_DEFAULT 1920
#define SENSOR_HEIGHT_DEFAULT 1080
#define SENSOR_FPS_DEFAULT 30
#define H264_BITRATE_DEFAULT 8000                 // kbps
#define H264_STREAM_BUFFER_SIZE (2 * 1024 * 1024) // 2MB for H.264 NAL units

#define ERR_CON_EQ(ret, val)                                                   \
  do {                                                                         \
    if ((ret) != (val)) {                                                      \
      fprintf(stderr, "[Error] %s:%d failed, ret=%d\n", __func__, __LINE__,    \
              ret);                                                            \
      goto error_exit;                                                         \
    }                                                                          \
  } while (0)

typedef struct {
  void *vio_object;     // libspcdev VIO module handle
  void *encoder_object; // libspcdev encoder module handle
  void *decoder_object; // libspcdev decoder module handle

  int camera_index;
  int sensor_width;
  int sensor_height;
  int out_width;
  int out_height;
  int fps;
  int bitrate; // H.264 bitrate in kbps

  // Decoder thread
  pthread_t decoder_thread;
  volatile sig_atomic_t decoder_running;
  uint32_t decode_interval_ms; // Decode sampling interval (0 = max speed)
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
static volatile sig_atomic_t g_is_active = 0;        // Active camera flag (SIGUSR1=1, SIGUSR2=0)
static volatile sig_atomic_t g_probe_requested = 0;  // Probe request flag (SIGRTMIN=1)

// Shared memory pointers
static SharedFrameBuffer *g_shm_active_nv12 = NULL; // Active camera NV12 (only when active)
static SharedFrameBuffer *g_shm_active_h264 = NULL; // Active camera H.264 (only when active)
static SharedFrameBuffer *g_shm_probe_nv12 = NULL;  // Probe NV12 (only on probe request)

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
    args->sensor_width = args->out_width;
  if (args->sensor_height <= 0)
    args->sensor_height = args->out_height;
}

static void populate_context_from_args(camera_context_t *ctx,
                                       const struct arguments *args) {
  ctx->camera_index = args->camera_index;
  ctx->sensor_width = args->sensor_width;
  ctx->sensor_height = args->sensor_height;
  ctx->out_width = args->out_width;
  ctx->out_height = args->out_height;
  ctx->fps = args->fps;
  ctx->bitrate = H264_BITRATE_DEFAULT; // Default H.264 bitrate
  ctx->decode_interval_ms = 1000;      // Default: 1 second sampling

  // Allow bitrate override from environment variable
  const char *bitrate_env = getenv("H264_BITRATE");
  if (bitrate_env) {
    ctx->bitrate = atoi(bitrate_env);
    printf("[Info] H.264 bitrate set to %d kbps\n", ctx->bitrate);
  }

  // Allow decode interval override from environment variable
  const char *decode_interval_env = getenv("DECODE_INTERVAL_MS");
  if (decode_interval_env) {
    ctx->decode_interval_ms = atoi(decode_interval_env);
    printf("[Info] Decode interval set to %u ms\n", ctx->decode_interval_ms);
  }

  // Initialize decoder thread state
  ctx->decoder_running = 0;
  ctx->decoder_object = NULL;
}

// Signal handler
static void signal_handler(int signum) {
  if (signum == SIGUSR1) {
    // Activate camera: start writing to active_frame and stream
    g_is_active = 1;
    fprintf(stderr, "[Signal] SIGUSR1: Camera activated\n");
  } else if (signum == SIGUSR2) {
    // Deactivate camera: stop writing to active_frame and stream
    g_is_active = 0;
    fprintf(stderr, "[Signal] SIGUSR2: Camera deactivated\n");
  } else if (signum == SIGRTMIN) {
    // Probe request: write one frame to probe_frame
    g_probe_requested = 1;
    fprintf(stderr, "[Signal] SIGRTMIN: Probe requested\n");
  } else {
    // SIGINT or SIGTERM
    g_running = 0;
  }
}

// Setup signal handlers
static void setup_signals(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_handler;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGUSR1, &sa, NULL);  // Activate camera
  sigaction(SIGUSR2, &sa, NULL);  // Deactivate camera
  sigaction(SIGRTMIN, &sa, NULL); // Probe request
}

// Note: JPEG encoding removed - using hardware H.264 encoding instead

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

// Forward declarations
static void *decoder_thread_func(void *arg);
static inline const char *get_camera_color(int camera_index);

// Initialize camera configuration (from capture_v2.c)
// -----------------------------
// libspcdev Pipeline Functions
// -----------------------------

static int create_and_start_pipeline(camera_context_t *ctx) {
  int ret = 0;
  sp_sensors_parameters parms;

  // Determine MIPI host based on camera index
  // Camera 0 → MIPI Host 0, Camera 1 → MIPI Host 2
  int video_index = (ctx->camera_index == 0) ? SP_HOST_0 : SP_HOST_2;

  const char *color = get_camera_color(ctx->camera_index);
  printf("%s[Info] Initializing H.264 hardware encoding pipeline...%s\n", color,
         ANSI_COLOR_RESET);
  printf("%s[Info] Camera %d configuration:%s\n", color, ctx->camera_index,
         ANSI_COLOR_RESET);
  printf("%s  - MIPI Host: %d%s\n", color, video_index, ANSI_COLOR_RESET);
  printf("%s  - Sensor: %dx%d @ %d fps%s\n", color, ctx->sensor_width,
         ctx->sensor_height, ctx->fps, ANSI_COLOR_RESET);
  printf("%s  - Output: %dx%d%s\n", color, ctx->out_width, ctx->out_height,
         ANSI_COLOR_RESET);
  printf("%s  - Bitrate: %d kbps%s\n", color, ctx->bitrate, ANSI_COLOR_RESET);
  if (g_shm_nv12) {
    printf("%s  - Decode interval: %u ms%s\n", color, ctx->decode_interval_ms,
           ANSI_COLOR_RESET);
  }

  // Prepare sensor parameters
  parms.fps = ctx->fps;
  parms.raw_height = ctx->out_height;
  parms.raw_width = ctx->out_width;

  // 1. Initialize VIO module
  ctx->vio_object = sp_init_vio_module();
  if (!ctx->vio_object) {
    fprintf(stderr, "[Error] sp_init_vio_module failed\n");
    return -1;
  }
  printf("[Info] VIO module initialized\n");

  // 2. Open camera with explicit MIPI host
  ret = sp_open_camera_v2(ctx->vio_object, ctx->camera_index, video_index, 1,
                          &parms, &ctx->out_width, &ctx->out_height);
  if (ret != 0) {
    fprintf(stderr, "[Error] sp_open_camera_v2 failed: %d\n", ret);
    fprintf(stderr, "  Camera index: %d, MIPI Host: %d\n",
            ctx->camera_index, video_index);
    goto error_cleanup;
  }
  printf("[Info] Camera opened (actual output: %dx%d)\n", ctx->out_width,
         ctx->out_height);

  // 3. Initialize encoder module
  ctx->encoder_object = sp_init_encoder_module();
  if (!ctx->encoder_object) {
    fprintf(stderr, "[Error] sp_init_encoder_module failed\n");
    goto error_cleanup;
  }
  printf("[Info] Encoder module initialized\n");

  // 4. Start H.264 encoding
  ret = sp_start_encode(ctx->encoder_object, 0, SP_ENCODER_H264, ctx->out_width,
                        ctx->out_height, ctx->bitrate);
  if (ret != 0) {
    fprintf(stderr, "[Error] sp_start_encode failed: %d\n", ret);
    goto error_cleanup;
  }
  printf("[Info] H.264 encoder started\n");

  // 5. Bind VIO to encoder (zero-copy pipeline)
  ret = sp_module_bind(ctx->vio_object, SP_MTYPE_VIO, ctx->encoder_object,
                       SP_MTYPE_ENCODER);
  if (ret != 0) {
    fprintf(stderr, "[Error] sp_module_bind failed: %d\n", ret);
    goto error_cleanup;
  }
  printf("[Info] VIO → Encoder binding complete (zero-copy pipeline)\n");

  // 6. Initialize decoder (if both H.264 and NV12 shared memory are enabled)
  if (g_shm_h264 && g_shm_nv12) {
    ctx->decoder_object = sp_init_decoder_module();
    if (!ctx->decoder_object) {
      fprintf(stderr, "[Error] sp_init_decoder_module failed\n");
      goto error_cleanup;
    }
    printf("[Info] Decoder module initialized\n");

    // Start decoder with dummy path to create decoder channel
    // We'll use sp_decoder_set_image() for actual memory-based decoding
    ret = sp_start_decode(ctx->decoder_object, "", 0, SP_ENCODER_H264,
                          ctx->out_width, ctx->out_height);
    if (ret != 0) {
      fprintf(stderr, "[Error] sp_start_decode failed: %d\n", ret);
      goto error_cleanup;
    }
    printf("[Info] H.264 decoder channel created (memory-based mode)\n");

    // Start decoder thread
    ctx->decoder_running = 1;
    ret = pthread_create(&ctx->decoder_thread, NULL, decoder_thread_func, ctx);
    if (ret != 0) {
      fprintf(stderr, "[Error] Failed to create decoder thread: %d\n", ret);
      ctx->decoder_running = 0;
      goto error_cleanup;
    }
    printf("[Info] Decoder thread started\n");
  }

  printf("[Info] H.264 pipeline started successfully\n");
  return 0;

error_cleanup:
  if (ctx->encoder_object) {
    sp_stop_encode(ctx->encoder_object);
    sp_release_encoder_module(ctx->encoder_object);
    ctx->encoder_object = NULL;
  }
  if (ctx->vio_object) {
    sp_vio_close(ctx->vio_object);
    sp_release_vio_module(ctx->vio_object);
    ctx->vio_object = NULL;
  }
  return -1;
}

static void cleanup_pipeline(camera_context_t *ctx) {
  printf("[Info] Cleaning up H.264 pipeline...\n");

  // Step 1: Stop decoder thread
  if (ctx->decoder_running) {
    ctx->decoder_running = 0;
    pthread_join(ctx->decoder_thread, NULL);
    printf("[Info] Decoder thread stopped\n");
  }

  // Step 2: Stop and release decoder
  if (ctx->decoder_object) {
    sp_stop_decode(ctx->decoder_object);
    sp_release_decoder_module(ctx->decoder_object);
    ctx->decoder_object = NULL;
    printf("[Info] Decoder released\n");
  }

  // Step 3: Close VIO (stops worker thread)
  // Note: Unbind is already done in main() before calling this function
  if (ctx->vio_object) {
    sp_vio_close(ctx->vio_object);
    printf("[Info] VIO closed\n");
  }

  // Step 2: Stop encoder
  if (ctx->encoder_object) {
    sp_stop_encode(ctx->encoder_object);
    printf("[Info] Encoder stopped\n");
  }

  // Step 3: Release resources
  if (ctx->encoder_object) {
    sp_release_encoder_module(ctx->encoder_object);
    ctx->encoder_object = NULL;
    printf("[Info] Encoder released\n");
  }

  if (ctx->vio_object) {
    sp_release_vio_module(ctx->vio_object);
    ctx->vio_object = NULL;
    printf("[Info] VIO released\n");
  }

  printf("[Info] Cleanup complete\n");
}

// -----------------------------
// Initialization helpers
// -----------------------------
static int create_shared_memory(void) {
  // Get custom shared memory names via environment variables
  g_shm_name_nv12 = getenv("SHM_NAME_NV12");
  g_shm_name_h264 = getenv("SHM_NAME_H264");
  g_shm_name_legacy = getenv("SHM_NAME");
  g_legacy_h264_only =
      (g_shm_name_legacy && !g_shm_name_nv12 && !g_shm_name_h264);

  if (g_legacy_h264_only) {
    g_shm_h264 = shm_frame_buffer_create_named(g_shm_name_legacy);
    if (!g_shm_h264) {
      fprintf(stderr, "[Error] Failed to create legacy shared memory: %s\n",
              g_shm_name_legacy);
      return -1;
    }
    g_shm_interval = g_shm_h264;
    printf("[Info] Legacy H.264-only shared memory: %s\n", g_shm_name_legacy);
    return 0;
  }

  // Create NV12 shared memory
  const char *nv12_name = g_shm_name_nv12 ? g_shm_name_nv12 : g_shm_name_legacy;
  if (nv12_name) {
    g_shm_nv12 = shm_frame_buffer_create_named(nv12_name);
  } else {
    g_shm_nv12 = shm_frame_buffer_create();
  }
  if (!g_shm_nv12) {
    fprintf(stderr, "[Error] Failed to create NV12 shared memory\n");
    return -1;
  }
  g_shm_interval = g_shm_nv12;
  printf("[Info] Created NV12 shared memory: %s\n",
         nv12_name ? nv12_name : SHM_NAME_FRAMES);

  // Create H.264 shared memory
  if (g_shm_name_h264) {
    g_shm_h264 = shm_frame_buffer_create_named(g_shm_name_h264);
    if (!g_shm_h264) {
      fprintf(stderr, "[Error] Failed to create H.264 shared memory: %s\n",
              g_shm_name_h264);
      // Cleanup NV12 memory before returning
      if (nv12_name) {
        shm_frame_buffer_destroy_named(g_shm_nv12, nv12_name);
      } else {
        shm_frame_buffer_destroy(g_shm_nv12);
      }
      return -1;
    }
    printf("[Info] Created H.264 shared memory: %s\n", g_shm_name_h264);
  } else {
    // H.264 shared memory is optional; if not specified, skip it
    printf("[Info] H.264 shared memory not specified (NV12-only mode)\n");
  }

  return 0;
}

// Note: open_memory_manager() removed - not needed with libspcdev
// Note: initialize_camera() removed - configuration now in
// create_and_start_pipeline() Note: start_pipeline() is now just
// create_and_start_pipeline()

// -----------------------------
// Color helper for log output
// -----------------------------
static inline const char *get_camera_color(int camera_index) {
  return (camera_index == 0) ? ANSI_COLOR_CAM0 : ANSI_COLOR_CAM1;
}

// -----------------------------
// H.264 I-frame detection
// -----------------------------
static bool is_h264_iframe(const uint8_t *data, size_t size) {
  if (!data || size < 5) {
    return false;
  }

  // Search for NAL unit start codes and check NAL type
  for (size_t i = 0; i < size - 4; i++) {
    // Check for start code: 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01
    bool is_start_code = false;
    size_t nal_header_offset = 0;

    if (data[i] == 0x00 && data[i + 1] == 0x00 && data[i + 2] == 0x00 &&
        data[i + 3] == 0x01) {
      is_start_code = true;
      nal_header_offset = i + 4;
    } else if (data[i] == 0x00 && data[i + 1] == 0x00 && data[i + 2] == 0x01) {
      is_start_code = true;
      nal_header_offset = i + 3;
    }

    if (is_start_code && nal_header_offset < size) {
      uint8_t nal_header = data[nal_header_offset];
      uint8_t nal_type = nal_header & 0x1F; // Lower 5 bits

      // Check if it's an IDR I-frame (NAL type 5)
      if (nal_type == 5) {
        return true;
      }
    }
  }

  return false;
}

// -----------------------------
// Decoder thread
// -----------------------------
static void *decoder_thread_func(void *arg) {
  camera_context_t *ctx = (camera_context_t *)arg;
  char *nv12_buffer = NULL;
  size_t nv12_size = (size_t)ctx->out_width * (size_t)ctx->out_height * 3 / 2;

  nv12_buffer = malloc(nv12_size);
  if (!nv12_buffer) {
    fprintf(stderr, "[Decoder] Failed to allocate NV12 buffer\n");
    return NULL;
  }

  const char *color = get_camera_color(ctx->camera_index);
  printf("%s[Decoder] Thread started (interval: %u ms)%s\n", color,
         ctx->decode_interval_ms, ANSI_COLOR_RESET);

  uint32_t last_h264_index = 0;
  struct timespec last_decode_time = {0, 0};

  while (ctx->decoder_running && g_running) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);

    // Check sampling interval
    if (ctx->decode_interval_ms > 0 && last_decode_time.tv_sec > 0) {
      double elapsed_ms = (now.tv_sec - last_decode_time.tv_sec) * 1000.0 +
                          (now.tv_nsec - last_decode_time.tv_nsec) / 1000000.0;
      if (elapsed_ms < ctx->decode_interval_ms) {
        usleep(10000); // Sleep 10ms
        continue;
      }
    }

    // Read latest H.264 frame from shared memory
    if (!g_shm_h264) {
      usleep(100000); // Sleep 100ms if no H.264 shm
      continue;
    }

    uint32_t current_index = shm_frame_buffer_get_write_index(g_shm_h264);
    if (current_index == last_h264_index) {
      usleep(10000); // No new frame
      continue;
    }

    Frame h264_frame;
    int ret = shm_frame_buffer_read_latest(g_shm_h264, &h264_frame);
    if (ret < 0 || h264_frame.format != 3) {
      usleep(10000);
      continue;
    }

    // Check if this is an I-frame (only decode I-frames for efficiency)
    if (!is_h264_iframe(h264_frame.data, h264_frame.data_size)) {
      // Skip non-I-frames (P-frames, B-frames)
      continue;
    }

    last_h264_index = current_index;
    last_decode_time = now;

    // Decode I-frame → NV12 using sp_decoder
    ret = sp_decoder_set_image(ctx->decoder_object, (char *)h264_frame.data, 0,
                               h264_frame.data_size, 0);
    if (ret != 0) {
      fprintf(stderr, "[Decoder] sp_decoder_set_image failed: %d\n", ret);
      continue;
    }

    ret = sp_decoder_get_image(ctx->decoder_object, nv12_buffer);
    if (ret < 0) {
      fprintf(stderr, "[Decoder] sp_decoder_get_image failed: %d\n", ret);
      continue;
    }

    printf("%s[Decoder] I-frame decoded successfully (frame #%lu)%s\n", color,
           h264_frame.frame_number, ANSI_COLOR_RESET);

    // Write NV12 to shared memory
    if (g_shm_nv12) {
      Frame nv12_frame = {0};
      nv12_frame.frame_number = h264_frame.frame_number;
      nv12_frame.timestamp = h264_frame.timestamp;
      nv12_frame.camera_id = h264_frame.camera_id;
      nv12_frame.width = ctx->out_width;
      nv12_frame.height = ctx->out_height;
      nv12_frame.format = 1; // NV12
      nv12_frame.data_size = nv12_size;
      memcpy(nv12_frame.data, nv12_buffer, nv12_size);

      if (shm_frame_buffer_write(g_shm_nv12, &nv12_frame) < 0) {
        fprintf(stderr, "[Decoder] Failed to write NV12 to shared memory\n");
      }
    }
  }

  free(nv12_buffer);
  printf("[Decoder] Thread stopped\n");
  return NULL;
}

// -----------------------------
// Capture loop
// -----------------------------
static uint64_t run_capture_loop(camera_context_t *ctx,
                                 const struct arguments *args) {
  int frame_limit = args->count;
  uint64_t frame_counter = 0;
  int stream_size = 0;
  int nv12_ret = 0;
  size_t nv12_size = (size_t)ctx->out_width * (size_t)ctx->out_height * 3 / 2;
  uint8_t *nv12_buffer = NULL;
  const char *color = get_camera_color(ctx->camera_index);

  // Allocate buffer for H.264 NAL units
  char *h264_buffer = NULL;
  if (g_shm_h264) {
    h264_buffer = malloc(H264_STREAM_BUFFER_SIZE);
    if (!h264_buffer) {
      fprintf(stderr, "[Error] Failed to allocate H.264 buffer\n");
      return 0;
    }
  }
  if (g_shm_nv12) {
    if (nv12_size > MAX_FRAME_SIZE) {
      fprintf(stderr, "[Error] NV12 frame too large: %zu > %d bytes\n",
              nv12_size, MAX_FRAME_SIZE);
      free(h264_buffer);
      return 0;
    }
    nv12_buffer = malloc(MAX_FRAME_SIZE);
    if (!nv12_buffer) {
      fprintf(stderr, "[Error] Failed to allocate NV12 buffer\n");
      free(h264_buffer);
      return 0;
    }
  }

  printf("[Info] Starting capture loop (NV12=%s, H.264=%s)...\n",
         g_shm_nv12 ? "on" : "off", g_shm_h264 ? "on" : "off");

  // Initialize frame interval from environment variable
  const char *interval_env = getenv("FRAME_INTERVAL_MS");
  if (interval_env) {
    g_current_interval_ms = atoi(interval_env);
    if (g_current_interval_ms > 0) {
      printf("[Info] Initial frame interval: %d ms\n", g_current_interval_ms);
    }
  }

  // Set initial interval in shared memory for dynamic control
  if (g_shm_interval) {
    __atomic_store_n(&g_shm_interval->frame_interval_ms, g_current_interval_ms,
                     __ATOMIC_RELEASE);
  }

  while (g_running &&
         ((frame_limit == 0) || (frame_counter < (uint64_t)frame_limit))) {
    bool wrote_any = false;
    struct timespec capture_ts;
    clock_gettime(CLOCK_MONOTONIC, &capture_ts);

    // if (g_shm_nv12) {
    //   // Try sp_vio_get_frame instead of sp_vio_get_yuv
    //   // sp_vio_get_yuv may return data in an unexpected format
    //   nv12_ret = sp_vio_get_frame(ctx->vio_object, (char *)nv12_buffer,
    //                               ctx->out_width, ctx->out_height, 2000);
    //   if (nv12_ret == 0) {
    //     Frame nv12_frame = {0};
    //     nv12_frame.frame_number = frame_counter;
    //     nv12_frame.timestamp = capture_ts;
    //     nv12_frame.camera_id = ctx->camera_index;
    //     nv12_frame.width = ctx->out_width;
    //     nv12_frame.height = ctx->out_height;
    //     nv12_frame.format = 1;  // NV12
    //     nv12_frame.data_size = nv12_size;
    //     memcpy(nv12_frame.data, nv12_buffer, nv12_size);
    //     if (shm_frame_buffer_write(g_shm_nv12, &nv12_frame) < 0) {
    //       fprintf(stderr, "[Error] Failed to write NV12 frame to shared
    //       memory\n");
    //     } else {
    //       wrote_any = true;
    //     }
    //   } else {
    //     fprintf(stderr, "[Warn] sp_vio_get_yuv failed: %d\n", nv12_ret);
    //   }
    // }

    if (g_shm_h264) {
      memset(h264_buffer, 0, H264_STREAM_BUFFER_SIZE);
      stream_size = sp_encoder_get_stream(ctx->encoder_object, h264_buffer);

      if (stream_size == -1) {
        fprintf(stderr, "[Error] sp_encoder_get_stream failed\n");
      } else if (stream_size == 0) {
        // No data available yet
      } else if (stream_size > MAX_FRAME_SIZE) {
        fprintf(stderr, "[Error] H.264 frame too large: %d > %d bytes\n",
                stream_size, MAX_FRAME_SIZE);
      } else {
        Frame h264_frame = {0};
        h264_frame.frame_number = frame_counter;
        h264_frame.timestamp = capture_ts;
        h264_frame.camera_id = ctx->camera_index;
        h264_frame.width = ctx->out_width;
        h264_frame.height = ctx->out_height;
        h264_frame.format = 3; // H.264
        h264_frame.data_size = stream_size;
        memcpy(h264_frame.data, h264_buffer, stream_size);
        if (shm_frame_buffer_write(g_shm_h264, &h264_frame) < 0) {
          fprintf(stderr,
                  "[Error] Failed to write H.264 frame to shared memory\n");
        } else {
          wrote_any = true;
        }
      }
    }

    if (!wrote_any) {
      usleep(1000);
      continue;
    }

    frame_counter++;

    // Print status every 30 frames
    if (frame_counter % 30 == 0) {
      printf("%s[Info] Frame %lu captured (nv12=%s, h264=%s)%s\n", color,
             frame_counter, g_shm_nv12 ? "yes" : "no",
             (g_shm_h264 && stream_size > 0) ? "yes" : "no", ANSI_COLOR_RESET);
    }

    // Frame interval control
    // g_current_interval_ms is updated by SIGUSR1 handler for dynamic FPS
    // control
    if (g_current_interval_ms > 0) {
      usleep(g_current_interval_ms * 1000);
    }
  }

  printf("[Info] Capture loop completed: %lu frames\n", frame_counter);

  free(h264_buffer);
  free(nv12_buffer);
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

  // Create shared memory
  if (create_shared_memory() != 0) {
    return 1;
  }

  // Create and start H.264 pipeline
  if (create_and_start_pipeline(&ctx) != 0) {
    cleanup_pipeline(&ctx);
    if (g_shm_nv12) {
      if (g_shm_name_nv12 || g_shm_name_legacy) {
        shm_frame_buffer_close(g_shm_nv12);
      } else {
        shm_frame_buffer_destroy(g_shm_nv12);
      }
    }
    if (g_shm_h264) {
      if (g_shm_name_h264 || g_legacy_h264_only) {
        shm_frame_buffer_close(g_shm_h264);
      } else {
        shm_frame_buffer_destroy(g_shm_h264);
      }
    }
    return 1;
  }

  // Wait for encoder to stabilize
  sleep(2);
  printf("[Info] Camera daemon started (Ctrl+C to stop)\n");
  if (args.daemon_mode || args.count == 0) {
    printf("[Info] Running in daemon mode (infinite loop)\n");
  }

  frame_counter = run_capture_loop(&ctx, &args);

  // Immediately unbind to stop VIO worker from pushing more frames
  if (ctx.encoder_object && ctx.vio_object) {
    sp_module_unbind(ctx.vio_object, SP_MTYPE_VIO, ctx.encoder_object,
                     SP_MTYPE_ENCODER);
    printf("[Info] VIO → Encoder unbound\n");

    // Wait for VIO worker thread to recognize the unbind and stop
    printf("[Info] Waiting for VIO worker to stop...\n");
    sleep(1); // 1 second for worker thread to complete
  }

  // Cleanup
  cleanup_pipeline(&ctx);
  if (g_shm_nv12) {
    if (g_shm_name_nv12 || g_shm_name_legacy) {
      printf("[Info] Preserving custom NV12 shared memory\n");
      shm_frame_buffer_close(g_shm_nv12);
    } else {
      shm_frame_buffer_destroy(g_shm_nv12);
    }
  }
  if (g_shm_h264) {
    if (g_shm_name_h264 || g_legacy_h264_only) {
      printf("[Info] Preserving custom H.264 shared memory\n");
      shm_frame_buffer_close(g_shm_h264);
    } else {
      shm_frame_buffer_destroy(g_shm_h264);
    }
  }

  printf("[Info] Camera daemon stopped (captured %lu frames)\n", frame_counter);
  return 0;
}
