/*
 * encoder_thread.c - Threaded H.264 Encoder Implementation
 */

#include "encoder_thread.h"
#include "logger.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Thread worker function
static void *encoder_thread_worker(void *arg) {
    encoder_thread_t *ctx = (encoder_thread_t *)arg;

    uint8_t *h264_buffer = malloc(ctx->output_width * ctx->output_height * 3 / 2);
    if (!h264_buffer) {
        LOG_ERROR("EncoderThread", "Failed to allocate H.264 buffer");
        return NULL;
    }
    size_t h264_buffer_size = ctx->output_width * ctx->output_height * 3 / 2;

    LOG_INFO("EncoderThread", "Worker started");

    while (ctx->running) {
        // Check if queue has data
        uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);
        uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);

        if (read_idx == write_idx) {
            // Queue empty, sleep briefly
            usleep(1000);  // 1ms
            continue;
        }

        // Get frame from queue
        encoder_frame_t *frame = &ctx->queue[read_idx % ENCODER_QUEUE_SIZE];

        // Encode frame
        size_t h264_size = 0;
        int ret = encoder_encode_frame(ctx->encoder,
                                       frame->y_data,
                                       frame->uv_data,
                                       h264_buffer,
                                       &h264_size,
                                       h264_buffer_size,
                                       2000);

        if (ret == 0 && h264_size > 0) {
            // Write to shared memory
            if (ctx->shm_h264) {
                Frame h264_frame = {0};
                h264_frame.width = ctx->output_width;
                h264_frame.height = ctx->output_height;
                h264_frame.format = 3;  // H.264
                h264_frame.data_size = h264_size;
                h264_frame.frame_number = frame->frame_number;
                h264_frame.camera_id = frame->camera_id;
                h264_frame.timestamp = frame->timestamp;

                if (h264_size <= sizeof(h264_frame.data)) {
                    memcpy(h264_frame.data, h264_buffer, h264_size);
                    if (shm_frame_buffer_write(ctx->shm_h264, &h264_frame) < 0) {
                        LOG_WARN("EncoderThread", "Failed to write H.264 to %s", ctx->shm_h264_name);
                    }
                } else {
                    LOG_WARN("EncoderThread", "H.264 frame too large (%zu bytes)", h264_size);
                }
            }

            __atomic_fetch_add(&ctx->frames_encoded, 1, __ATOMIC_RELAXED);
        } else {
            LOG_WARN("EncoderThread", "Encoding failed: ret=%d, size=%zu", ret, h264_size);
        }

        // Free frame data
        free(frame->y_data);
        free(frame->uv_data);
        frame->y_data = NULL;
        frame->uv_data = NULL;

        // Advance read index
        __atomic_store_n(&ctx->read_index, read_idx + 1, __ATOMIC_RELEASE);
    }

    free(h264_buffer);
    LOG_INFO("EncoderThread", "Worker stopped (encoded=%lu, dropped=%lu)",
             ctx->frames_encoded, ctx->frames_dropped);

    return NULL;
}

int encoder_thread_create(encoder_thread_t *ctx,
                         encoder_context_t *encoder,
                         SharedFrameBuffer *shm_h264,
                         const char *shm_h264_name,
                         int output_width,
                         int output_height) {
    if (!ctx || !encoder || !shm_h264) return -1;

    memset(ctx, 0, sizeof(encoder_thread_t));

    ctx->encoder = encoder;
    ctx->shm_h264 = shm_h264;
    snprintf(ctx->shm_h264_name, sizeof(ctx->shm_h264_name), "%s", shm_h264_name);
    ctx->output_width = output_width;
    ctx->output_height = output_height;

    ctx->write_index = 0;
    ctx->read_index = 0;
    ctx->frames_encoded = 0;
    ctx->frames_dropped = 0;

    LOG_INFO("EncoderThread", "Created (queue_size=%d)", ENCODER_QUEUE_SIZE);
    return 0;
}

int encoder_thread_start(encoder_thread_t *ctx) {
    if (!ctx) return -1;

    ctx->running = true;

    int ret = pthread_create(&ctx->thread, NULL, encoder_thread_worker, ctx);
    if (ret != 0) {
        LOG_ERROR("EncoderThread", "pthread_create failed: %d", ret);
        ctx->running = false;
        return ret;
    }

    LOG_INFO("EncoderThread", "Started");
    return 0;
}

int encoder_thread_push_frame(encoder_thread_t *ctx,
                              const uint8_t *y_data,
                              const uint8_t *uv_data,
                              size_t y_size,
                              size_t uv_size,
                              uint64_t frame_number,
                              int camera_id,
                              struct timespec timestamp) {
    if (!ctx || !y_data || !uv_data) return -1;

    // Check if queue is full
    uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
    uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);

    if (write_idx - read_idx >= ENCODER_QUEUE_SIZE) {
        // Queue full, drop frame
        __atomic_fetch_add(&ctx->frames_dropped, 1, __ATOMIC_RELAXED);
        return -1;
    }

    // Allocate and copy frame data
    uint8_t *y_copy = malloc(y_size);
    uint8_t *uv_copy = malloc(uv_size);

    if (!y_copy || !uv_copy) {
        free(y_copy);
        free(uv_copy);
        LOG_ERROR("EncoderThread", "Failed to allocate frame buffer");
        return -1;
    }

    memcpy(y_copy, y_data, y_size);
    memcpy(uv_copy, uv_data, uv_size);

    // Add to queue
    encoder_frame_t *frame = &ctx->queue[write_idx % ENCODER_QUEUE_SIZE];
    frame->y_data = y_copy;
    frame->uv_data = uv_copy;
    frame->y_size = y_size;
    frame->uv_size = uv_size;
    frame->frame_number = frame_number;
    frame->camera_id = camera_id;
    frame->timestamp = timestamp;

    // Advance write index
    __atomic_store_n(&ctx->write_index, write_idx + 1, __ATOMIC_RELEASE);

    return 0;
}

void encoder_thread_stop(encoder_thread_t *ctx) {
    if (!ctx || !ctx->running) return;

    LOG_INFO("EncoderThread", "Stopping...");
    ctx->running = false;

    pthread_join(ctx->thread, NULL);

    LOG_INFO("EncoderThread", "Stopped");
}

void encoder_thread_destroy(encoder_thread_t *ctx) {
    if (!ctx) return;

    // Free any remaining frames in queue
    for (int i = 0; i < ENCODER_QUEUE_SIZE; i++) {
        free(ctx->queue[i].y_data);
        free(ctx->queue[i].uv_data);
    }

    memset(ctx, 0, sizeof(encoder_thread_t));
    LOG_INFO("EncoderThread", "Destroyed");
}
