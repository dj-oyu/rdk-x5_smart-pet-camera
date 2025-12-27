/*
 * camera_daemon_main.c - Camera Daemon Application Entry Point
 *
 * Simple, clean entry point that orchestrates the camera pipeline.
 * Uses the layered architecture: Application → Pipeline → HAL
 */

#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <getopt.h>
#include <string.h>
#include "camera_pipeline.h"
#include "logger.h"

// Default configuration
#define DEFAULT_SENSOR_WIDTH  1920
#define DEFAULT_SENSOR_HEIGHT 1080
#define DEFAULT_OUTPUT_WIDTH  1920
#define DEFAULT_OUTPUT_HEIGHT 1080
#define DEFAULT_FPS           30
#define DEFAULT_BITRATE       600000  // 600 kbps (max is 700000)
#define DEFAULT_SHM_NAME      "/pet_camera_stream"

// Global state for signal handling
static volatile bool g_running = true;
static camera_pipeline_t g_pipeline = {0};

static void signal_handler(int signum) {
    (void)signum;
    LOG_INFO("Main", "Received signal, stopping...");
    g_running = false;
}

static void print_usage(const char *prog_name) {
    printf("Usage: %s [OPTIONS]\n", prog_name);
    printf("\n");
    printf("Options:\n");
    printf("  -C, --camera INDEX       Camera index (0 or 1, default: 0)\n");
    printf("  -W, --width WIDTH        Output width (default: %d)\n", DEFAULT_OUTPUT_WIDTH);
    printf("  -H, --height HEIGHT      Output height (default: %d)\n", DEFAULT_OUTPUT_HEIGHT);
    printf("  -f, --fps FPS            Frame rate (default: %d)\n", DEFAULT_FPS);
    printf("  -b, --bitrate BITRATE    Bitrate in bps (default: %d)\n", DEFAULT_BITRATE);
    printf("  -s, --shm-name NAME      Shared memory name (default: %s)\n", DEFAULT_SHM_NAME);
    printf("  -v, --verbose            Enable verbose logging (DEBUG level)\n");
    printf("  -h, --help               Show this help message\n");
    printf("\n");
    printf("Environment Variables:\n");
    printf("  SHM_NAME_H264            Override shared memory name\n");
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
    const char *shm_name = DEFAULT_SHM_NAME;
    log_level_t log_level = LOG_LEVEL_INFO;

    // Parse command line arguments
    static struct option long_options[] = {
        {"camera",   required_argument, 0, 'C'},
        {"width",    required_argument, 0, 'W'},
        {"height",   required_argument, 0, 'H'},
        {"fps",      required_argument, 0, 'f'},
        {"bitrate",  required_argument, 0, 'b'},
        {"shm-name", required_argument, 0, 's'},
        {"verbose",  no_argument,       0, 'v'},
        {"help",     no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "C:W:H:f:b:s:vh", long_options, NULL)) != -1) {
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
            case 's':
                shm_name = optarg;
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

    // Check for environment variable override
    const char *env_shm_name = getenv("SHM_NAME_H264");
    if (env_shm_name) {
        shm_name = env_shm_name;
    }

    // Initialize logger
    log_init(log_level, stdout, 0);  // No timestamp for embedded system

    LOG_INFO("Main", "Camera Daemon Starting");
    LOG_INFO("Main", "Camera: %d, Resolution: %dx%d@%dfps, Bitrate: %dkbps",
             camera_index, output_width, output_height, fps, bitrate / 1000);
    LOG_INFO("Main", "Shared Memory: %s", shm_name);

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Create pipeline
    ret = pipeline_create(&g_pipeline, camera_index,
                          sensor_width, sensor_height,
                          output_width, output_height,
                          fps, bitrate, shm_name);
    if (ret != 0) {
        LOG_ERROR("Main", "Failed to create pipeline: %d", ret);
        return 1;
    }

    // Start pipeline
    ret = pipeline_start(&g_pipeline);
    if (ret != 0) {
        LOG_ERROR("Main", "Failed to start pipeline: %d", ret);
        pipeline_destroy(&g_pipeline);
        return 1;
    }

    // Run capture loop
    ret = pipeline_run(&g_pipeline, &g_running);
    if (ret != 0) {
        LOG_ERROR("Main", "Pipeline run failed: %d", ret);
    }

    // Cleanup
    pipeline_stop(&g_pipeline);
    pipeline_destroy(&g_pipeline);

    LOG_INFO("Main", "Camera Daemon Stopped");
    return 0;
}
