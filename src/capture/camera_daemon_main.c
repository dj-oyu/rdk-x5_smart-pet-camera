/*
 * camera_daemon_main.c - Camera Daemon Application Entry Point
 *
 * Simple, clean entry point that orchestrates the camera pipeline.
 * Uses the layered architecture: Application → Pipeline → HAL
 */

#define _POSIX_C_SOURCE 200809L

#include "camera_pipeline.h"
#include "logger.h"
#include <getopt.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

// Default configuration
#define DEFAULT_SENSOR_WIDTH 1920
#define DEFAULT_SENSOR_HEIGHT 1080
#define DEFAULT_OUTPUT_WIDTH 1920
#define DEFAULT_OUTPUT_HEIGHT 1080
#define DEFAULT_FPS 30
#define DEFAULT_BITRATE 600000 // 600 kbps (max is 700000)
#define DEFAULT_SHM_NV12_NAME "/pet_camera_frames"
#define DEFAULT_SHM_H264_NAME "/pet_camera_stream"

static char Main_log_header[8];

// Global state for signal handling
static volatile bool g_running = true;
static volatile sig_atomic_t g_is_active =
    0; // Active camera flag (SIGUSR1=1, SIGUSR2=0)
static volatile sig_atomic_t g_probe_requested =
    0; // Probe request flag (SIGRTMIN=1)
static camera_pipeline_t g_pipeline = {0};

static void signal_handler(int signum) {
  if (signum == SIGUSR1) {
    // Activate camera: start writing to active_frame and stream
    g_is_active = 1;
    LOG_INFO(Main_log_header, "SIGUSR1: Camera activated");
  } else if (signum == SIGUSR2) {
    // Deactivate camera: stop writing to active_frame and stream
    g_is_active = 0;
    LOG_INFO(Main_log_header, "SIGUSR2: Camera deactivated");
  } else if (signum == SIGRTMIN) {
    // Probe request: write one frame to probe_frame
    g_probe_requested = 1;
    LOG_INFO(Main_log_header, "SIGRTMIN: Probe requested");
  } else {
    // SIGINT or SIGTERM
    LOG_INFO(Main_log_header, "Received signal %d, stopping...", signum);
    g_running = false;
  }
}

static void print_usage(const char *prog_name) {
  printf("Usage: %s [OPTIONS]\n", prog_name);
  printf("\n");
  printf("Options:\n");
  printf("  -C, --camera INDEX       Camera index (0 or 1, default: 0)\n");
  printf("  -W, --width WIDTH        Output width (default: %d)\n",
         DEFAULT_OUTPUT_WIDTH);
  printf("  -H, --height HEIGHT      Output height (default: %d)\n",
         DEFAULT_OUTPUT_HEIGHT);
  printf("  -f, --fps FPS            Frame rate (default: %d)\n", DEFAULT_FPS);
  printf("  -b, --bitrate BITRATE    Bitrate in bps (default: %d)\n",
         DEFAULT_BITRATE);
  printf("  -v, --verbose            Enable verbose logging (DEBUG level)\n");
  printf("  -h, --help               Show this help message\n");
  printf("\n");
  printf("Environment Variables:\n");
  printf("  SHM_NAME_NV12            NV12 shared memory name (default: %s)\n",
         DEFAULT_SHM_NV12_NAME);
  printf("  SHM_NAME_H264            H.264 shared memory name (default: %s)\n",
         DEFAULT_SHM_H264_NAME);
  printf("\n");
  printf("Note: Set SHM_NAME_NV12=\"\" to disable NV12 shared memory (H.264 "
         "only mode)\n");
  printf("\n");
}

int main(int argc, char *argv[]) {
  int ret = 0;

  // Configuration
  int camera_index = 0;
  int sensor_width = DEFAULT_SENSOR_WIDTH;
  int sensor_height = DEFAULT_SENSOR_HEIGHT;
  int output_width = DEFAULT_OUTPUT_WIDTH;
  int output_height = DEFAULT_OUTPUT_HEIGHT;
  int fps = DEFAULT_FPS;
  int bitrate = DEFAULT_BITRATE;
  const char *shm_nv12_name = DEFAULT_SHM_NV12_NAME;
  const char *shm_h264_name = DEFAULT_SHM_H264_NAME;
  log_level_t log_level = LOG_LEVEL_INFO;

  // Parse command line arguments
  static struct option long_options[] = {{"camera", required_argument, 0, 'C'},
                                         {"width", required_argument, 0, 'W'},
                                         {"height", required_argument, 0, 'H'},
                                         {"fps", required_argument, 0, 'f'},
                                         {"bitrate", required_argument, 0, 'b'},
                                         {"verbose", no_argument, 0, 'v'},
                                         {"help", no_argument, 0, 'h'},
                                         {0, 0, 0, 0}};

  int opt;
  while ((opt = getopt_long(argc, argv, "C:W:H:f:b:vh", long_options, NULL)) !=
         -1) {
    switch (opt) {
    case 'C':
      camera_index = atoi(optarg);
      if (camera_index != 0 && camera_index != 1) {
        fprintf(stderr, "Error: Camera index must be 0 or 1\n");
        return 1;
      }
      break;
    case 'W':
      output_width = atoi(optarg);
      break;
    case 'H':
      output_height = atoi(optarg);
      break;
    case 'f':
      fps = atoi(optarg);
      break;
    case 'b':
      bitrate = atoi(optarg);
      break;
    case 'v':
      log_level = LOG_LEVEL_DEBUG;
      break;
    case 'h':
      print_usage(argv[0]);
      return 0;
    default:
      print_usage(argv[0]);
      return 1;
    }
  }

  // Check for environment variable overrides
  const char *env_nv12_name = getenv("SHM_NAME_NV12");
  if (env_nv12_name) {
    shm_nv12_name = env_nv12_name;
    // Empty string means disable NV12 shared memory
    if (shm_nv12_name[0] == '\0') {
      shm_nv12_name = NULL;
    }
  }

  const char *env_h264_name = getenv("SHM_NAME_H264");
  if (env_h264_name) {
    shm_h264_name = env_h264_name;
  }

  // Initialize logger
  log_init(log_level, stdout, 0); // No timestamp for embedded system
  snprintf(Main_log_header, sizeof(Main_log_header), "Main %d", camera_index);

  LOG_INFO(Main_log_header, "Camera Daemon Starting");
  LOG_INFO(Main_log_header,
           "Camera: %d, Resolution: %dx%d@%dfps, Bitrate: %dkbps", camera_index,
           output_width, output_height, fps, bitrate / 1000);
  LOG_INFO(Main_log_header, "Shared Memory: NV12=%s, H.264=%s",
           shm_nv12_name ? shm_nv12_name : "(disabled)", shm_h264_name);

  // Setup signal handlers
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_handler;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGUSR1, &sa, NULL);  // Activate camera
  sigaction(SIGUSR2, &sa, NULL);  // Deactivate camera
  sigaction(SIGRTMIN, &sa, NULL); // Probe request

  // Create pipeline (new design: fixed shm names, conditional write based on
  // signals)
  ret = pipeline_create(&g_pipeline, camera_index, sensor_width, sensor_height,
                        output_width, output_height, fps, bitrate, &g_is_active,
                        &g_probe_requested);
  if (ret != 0) {
    LOG_ERROR(Main_log_header, "Failed to create pipeline: %d", ret);
    return 1;
  }

  // Start pipeline
  ret = pipeline_start(&g_pipeline);
  if (ret != 0) {
    LOG_ERROR(Main_log_header, "Failed to start pipeline: %d", ret);
    pipeline_destroy(&g_pipeline);
    return 1;
  }

  // Run capture loop
  ret = pipeline_run(&g_pipeline, &g_running);
  if (ret != 0) {
    LOG_ERROR(Main_log_header, "Pipeline run failed: %d", ret);
  }

  // Cleanup
  pipeline_stop(&g_pipeline);
  pipeline_destroy(&g_pipeline);

  LOG_INFO(Main_log_header, "Camera Daemon Stopped");
  return 0;
}
