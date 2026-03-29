/*
 * encoder_thread.h - Threaded H.264 Encoder
 *
 * Manages background H.264 encoding to maintain 30fps without blocking VIO loop
 */

#ifndef ENCODER_THREAD_H
#define ENCODER_THREAD_H

#include "encoder_lowlevel.h"
#include "shared_memory.h"
#include "vio_lowlevel.h"
#include <hbn_api.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>

#define ENCODER_QUEUE_SIZE 4 // Ring buffer size (small to minimize latency)

/**
 * Frame data for encoder queue
 */
typedef struct {
    // VSE frame held until encoding completes (eliminates pool buffer memcpy)
    hbn_vnode_image_t vse_frame; // VSE output frame (virt_addr used for encoding)

    // Metadata
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
    encoder_context_t* encoder;

    // Output (zero-copy: share_id via SHM, no bitstream memcpy)
    H265ZeroCopyBuffer* shm_h265_zc;

    // Configuration
    int output_width;
    int output_height;

    // Queue (lock-free ring buffer)
    encoder_frame_t queue[ENCODER_QUEUE_SIZE];
    volatile uint32_t write_index; // Producer writes here
    volatile uint32_t read_index;  // Consumer reads here

    // VSE handle (for releasing frames after encoding)
    hbn_vnode_handle_t vse_handle;

    // Previous VPU output (held for Go to import, released on next frame)
    encoder_output_t prev_enc_out;

    // Condition variable for event-driven wakeup (replaces usleep polling)
    pthread_mutex_t queue_mutex;
    pthread_cond_t queue_cond;

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
 *   shm_h264: H.265 shared memory
 *   shm_h264_name: H.265 shared memory name (for logging)
 *   output_width: Output width
 *   output_height: Output height
 *   vse_handle: VSE handle (for releasing frames after encoding)
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int encoder_thread_create(encoder_thread_t* ctx, encoder_context_t* encoder,
                          H265ZeroCopyBuffer* shm_h265_zc, int output_width, int output_height,
                          hbn_vnode_handle_t vse_handle);

/**
 * Start encoder thread
 *
 * Args:
 *   ctx: Encoder thread context
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int encoder_thread_start(encoder_thread_t* ctx);

/**
 * Push VSE frame to encoder queue (zero-copy, non-blocking)
 *
 * Args:
 *   ctx: Encoder thread context
 *   vse_frame: VSE output frame (ownership transferred to encoder thread)
 *   frame_number: Frame number
 *   camera_id: Camera ID
 *   timestamp: Frame timestamp
 *
 * Returns:
 *   0 on success, -1 if queue is full (frame dropped, caller must release)
 *
 * Note:
 *   - Zero-copy: passes VSE phys_addr directly to VPU encoder
 *   - Caller must NOT release vse_frame on success (encoder thread will release)
 *   - Caller MUST release vse_frame on failure (-1 return)
 */
int encoder_thread_push_frame(encoder_thread_t* ctx, hbn_vnode_image_t* vse_frame,
                              uint64_t frame_number, int camera_id, struct timespec timestamp);

/**
 * Stop encoder thread
 *
 * Args:
 *   ctx: Encoder thread context
 */
void encoder_thread_stop(encoder_thread_t* ctx);

/**
 * Destroy encoder thread context
 *
 * Args:
 *   ctx: Encoder thread context
 */
void encoder_thread_destroy(encoder_thread_t* ctx);

#endif // ENCODER_THREAD_H
