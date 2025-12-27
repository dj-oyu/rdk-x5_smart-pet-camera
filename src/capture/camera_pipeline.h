/*
 * camera_pipeline.h - Camera Pipeline Orchestration
 *
 * Integrates VIO (Video Input) and Encoder (H.264) into a unified pipeline
 * Manages the capture loop: VIO → Encoder → Shared Memory
 */

#ifndef CAMERA_PIPELINE_H
#define CAMERA_PIPELINE_H

#include <stdint.h>
#include <stdbool.h>
#include "vio_lowlevel.h"
#include "encoder_lowlevel.h"
#include "shared_memory.h"

/**
 * Pipeline context - encapsulates complete camera pipeline
 */
typedef struct {
    // Hardware components
    vio_context_t vio;
    encoder_context_t encoder;

    // Shared memory output
    SharedFrameBuffer *shm_h264;

    // Runtime control
    volatile bool *running_flag;  // External running flag

    // Configuration
    int camera_index;
    int sensor_width;
    int sensor_height;
    int output_width;
    int output_height;
    int fps;
    int bitrate;
} camera_pipeline_t;

/**
 * Create camera pipeline
 *
 * Initializes VIO and Encoder, connects to shared memory.
 * Does NOT start the pipeline (use pipeline_start()).
 *
 * Args:
 *   pipeline: Pipeline context to initialize
 *   camera_index: Camera index (0 or 1)
 *   sensor_width: Sensor native width (e.g., 1920)
 *   sensor_height: Sensor native height (e.g., 1080)
 *   output_width: Encoder output width (e.g., 1920)
 *   output_height: Encoder output height (e.g., 1080)
 *   fps: Target frame rate (e.g., 30)
 *   bitrate: Target bitrate in bps (e.g., 2000000 for 2Mbps)
 *   shm_h264_name: Shared memory name for H.264 output (e.g., "/pet_camera_stream")
 *
 * Returns:
 *   0 on success, negative error code on failure
 *
 * Note:
 *   - Sensor resolution and output resolution can differ (VSE will scale)
 *   - Shared memory is created if it doesn't exist
 */
int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height,
                    int output_width, int output_height,
                    int fps, int bitrate,
                    const char *shm_h264_name);

/**
 * Start camera pipeline
 *
 * Starts VIO capture (encoder is already started in pipeline_create).
 * After this call, pipeline_run() can be used to begin the capture loop.
 *
 * Args:
 *   pipeline: Pipeline context
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int pipeline_start(camera_pipeline_t *pipeline);

/**
 * Run capture loop
 *
 * Main capture loop: Get VIO frame → Encode to H.264 → Write to shared memory.
 * Runs until *running_flag becomes false.
 *
 * Args:
 *   pipeline: Pipeline context
 *   running_flag: Pointer to volatile bool controlling loop execution
 *
 * Returns:
 *   0 on normal termination, negative error code on fatal error
 *
 * Note:
 *   - This function blocks until *running_flag becomes false
 *   - Set *running_flag = false from signal handler to stop cleanly
 *   - Prints FPS statistics every 30 frames
 */
int pipeline_run(camera_pipeline_t *pipeline, volatile bool *running_flag);

/**
 * Stop camera pipeline
 *
 * Stops VIO and encoder.
 * Can be restarted with pipeline_start() if needed.
 *
 * Args:
 *   pipeline: Pipeline context
 */
void pipeline_stop(camera_pipeline_t *pipeline);

/**
 * Destroy camera pipeline
 *
 * Stops pipeline (if running) and releases all resources.
 * pipeline becomes invalid after this call.
 *
 * Args:
 *   pipeline: Pipeline context
 */
void pipeline_destroy(camera_pipeline_t *pipeline);

#endif // CAMERA_PIPELINE_H
