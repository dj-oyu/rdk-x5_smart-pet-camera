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
#include <signal.h>
#include <pthread.h>
#include "vio_lowlevel.h"
#include "encoder_lowlevel.h"
#include "encoder_thread.h"
#include "shared_memory.h"
#include "isp_brightness.h"  // For isp_lowlight_state_t

/**
 * NV12 sampling configuration
 */
typedef struct {
    bool enable_detection;   // Enable detection sampling (27fps)
    bool enable_brightness;  // Enable brightness sampling (10fps)
} nv12_sampling_config_t;

/**
 * Pipeline context - encapsulates complete camera pipeline
 */
typedef struct {
    // Hardware components
    vio_context_t vio;
    encoder_context_t encoder;
    encoder_thread_t encoder_thread;

    // Shared memory output
    // SHM output (only 2 remain)
    H265ZeroCopyBuffer *shm_h265_zc;        // H.265 stream zero-copy (Go streaming)
    ZeroCopyFrameBuffer *shm_yolo_zerocopy; // YOLO zero-copy (Python detector)

    // MJPEG NV12 zero-copy (Go web_monitor)
    ZeroCopyFrameBuffer *shm_mjpeg_zc;

    // Night camera ROI SHM (NULL for day camera)
    ZeroCopyFrameBuffer* shm_roi_zc[NUM_ROI_REGIONS];

    // Shared state (same process, no SHM needed)
    volatile int *active_camera;

    // Condition variable for inactive camera blocking
    pthread_mutex_t switch_mutex;
    pthread_cond_t switch_cond;

    // Runtime control
    volatile bool *running_flag;           // External running flag

    // NV12 sampling configuration (deprecated in new design)
    nv12_sampling_config_t nv12_sampling;

    // Low-light correction state (Phase 2: ISP auto-correction)
    isp_lowlight_state_t lowlight_state;

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
 * Initializes VIO and Encoder, connects to shared memory with fixed names.
 * Does NOT start the pipeline (use pipeline_start()).
 *
 * Args:
 *   pipeline: Pipeline context to initialize
 *   camera_index: Camera index (0 or 1)
 *   sensor_width: Sensor native width (e.g., 1920)
 *   sensor_height: Sensor native height (e.g., 1080)
 *   output_width: Encoder output width (e.g., 640)
 *   output_height: Encoder output height (e.g., 480)
 *   fps: Target frame rate (e.g., 30)
 *   bitrate: Target bitrate in bps (e.g., 600000 for 600kbps)
 *
 * Returns:
 *   0 on success, negative error code on failure
 *
 * Note:
 *   - Each pipeline maintains its own frame_number counter
 *   - Frames are written conditionally based on active camera index
 */
int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height,
                    int output_width, int output_height,
                    int fps, int bitrate,
                    volatile int *active_camera);

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
 * Main capture loop: Get VIO frame → Write NV12 → Push to encoder thread.
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
 *   - H.264 encoding runs in background thread (30fps, no frame drops)
 *   - NV12 written at 30fps to shared memory (optional)
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
