/*
 * encoder_thread.h - Threaded H.264 Encoder
 *
 * Manages background H.264 encoding to maintain 30fps without blocking VIO loop
 */

#ifndef ENCODER_THREAD_H
#define ENCODER_THREAD_H

#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include "encoder_lowlevel.h"
#include "shared_memory.h"

#define ENCODER_QUEUE_SIZE 4  // Ring buffer size (small to minimize latency)

/**
 * Frame data for encoder queue
 */
typedef struct {
    uint8_t *y_data;           // Y plane data (owned by queue)
    uint8_t *uv_data;          // UV plane data (owned by queue)
    size_t y_size;             // Y plane size
    size_t uv_size;            // UV plane size
    uint64_t frame_number;     // Frame number
    int camera_id;             // Camera ID
    struct timespec timestamp; // Frame timestamp
} encoder_frame_t;

/**
 * Encoder thread context
 */
typedef struct {
    // Thread control
    pthread_t thread;
    volatile bool running;

    // Encoder
    encoder_context_t *encoder;

    // Output
    SharedFrameBuffer *shm_h264;
    char shm_h264_name[64];

    // Configuration
    int output_width;
    int output_height;

    // Queue (lock-free ring buffer)
    encoder_frame_t queue[ENCODER_QUEUE_SIZE];
    volatile uint32_t write_index;  // Producer writes here
    volatile uint32_t read_index;   // Consumer reads here

    // Statistics
    volatile uint64_t frames_encoded;
    volatile uint64_t frames_dropped;
} encoder_thread_t;

/**
 * Create encoder thread context
 *
 * Args:
 *   ctx: Encoder thread context to initialize
 *   encoder: Encoder context (must be already initialized)
 *   shm_h264: H.264 shared memory
 *   shm_h264_name: H.264 shared memory name (for logging)
 *   output_width: Output width
 *   output_height: Output height
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int encoder_thread_create(encoder_thread_t *ctx,
                         encoder_context_t *encoder,
                         SharedFrameBuffer *shm_h264,
                         const char *shm_h264_name,
                         int output_width,
                         int output_height);

/**
 * Start encoder thread
 *
 * Args:
 *   ctx: Encoder thread context
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int encoder_thread_start(encoder_thread_t *ctx);

/**
 * Push frame to encoder queue (non-blocking)
 *
 * Args:
 *   ctx: Encoder thread context
 *   y_data: Y plane data
 *   uv_data: UV plane data
 *   y_size: Y plane size
 *   uv_size: UV plane size
 *   frame_number: Frame number
 *   camera_id: Camera ID
 *   timestamp: Frame timestamp
 *
 * Returns:
 *   0 on success, -1 if queue is full (frame dropped)
 *
 * Note:
 *   - This function copies the frame data
 *   - Non-blocking (returns immediately if queue is full)
 */
int encoder_thread_push_frame(encoder_thread_t *ctx,
                              const uint8_t *y_data,
                              const uint8_t *uv_data,
                              size_t y_size,
                              size_t uv_size,
                              uint64_t frame_number,
                              int camera_id,
                              struct timespec timestamp);

/**
 * Stop encoder thread
 *
 * Args:
 *   ctx: Encoder thread context
 */
void encoder_thread_stop(encoder_thread_t *ctx);

/**
 * Destroy encoder thread context
 *
 * Args:
 *   ctx: Encoder thread context
 */
void encoder_thread_destroy(encoder_thread_t *ctx);

#endif // ENCODER_THREAD_H
