/*
 * encoder_thread.c - Threaded H.264 Encoder Implementation
 */

#include "encoder_thread.h"
#include "logger.h"
#include "vio_lowlevel.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

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
      // Queue empty — wait on condition variable instead of polling
      pthread_mutex_lock(&ctx->queue_mutex);
      // Re-check under lock to avoid missed signal
      write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
      if (read_idx == write_idx && ctx->running) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_nsec += 50 * 1000000; // 50ms timeout
        if (ts.tv_nsec >= 1000000000) {
          ts.tv_sec++;
          ts.tv_nsec -= 1000000000;
        }
        pthread_cond_timedwait(&ctx->queue_cond, &ctx->queue_mutex, &ts);
      }
      pthread_mutex_unlock(&ctx->queue_mutex);
      continue;
    }

    // Get frame from queue
    encoder_frame_t *frame = &ctx->queue[read_idx % ENCODER_QUEUE_SIZE];

    // Log frame being encoded (every 30 frames)
    if (frame->frame_number % 30 == 0) {
      LOG_DEBUG("EncoderThread", "Encoding camera%d frame#%lu (queue_depth=%u)",
                frame->camera_id, frame->frame_number, write_idx - read_idx);
    }

    // Encode frame
    size_t h264_size = 0;
    int ret =
        encoder_encode_frame(ctx->encoder, frame->y_data, frame->uv_data,
                             h264_buffer, &h264_size, h264_buffer_size, 2000);

    if (ret == 0 && h264_size > 0) {
      // Write to shared memory
      if (ctx->shm_h264) {
        Frame h264_frame = {0};
        h264_frame.width = ctx->output_width;
        h264_frame.height = ctx->output_height;
        h264_frame.format = 4; // H.265
        h264_frame.data_size = h264_size;
        h264_frame.frame_number = frame->frame_number;
        h264_frame.camera_id = frame->camera_id;
        h264_frame.timestamp = frame->timestamp;

        if (h264_size <= sizeof(h264_frame.data)) {
          memcpy(h264_frame.data, h264_buffer, h264_size);
          if (shm_frame_buffer_write(ctx->shm_h264, &h264_frame) < 0) {
            LOG_WARN("EncoderThread", "Failed to write H.264 to %s",
                     ctx->shm_h264_name);
          } else {
            // Log every 30 frames to track frame_number
            uint64_t encoded = __atomic_load_n(&ctx->frames_encoded, __ATOMIC_RELAXED);
            if (encoded % 30 == 0) {
              LOG_DEBUG("EncoderThread", "Encoded camera%d frame#%lu to H.264 shm",
                        frame->camera_id, frame->frame_number);
            }
          }
        } else {
          LOG_WARN("EncoderThread", "H.264 frame too large (%zu bytes)",
                   h264_size);
        }
      }

      __atomic_fetch_add(&ctx->frames_encoded, 1, __ATOMIC_RELAXED);
    } else {
      LOG_WARN("EncoderThread", "Encoding failed: ret=%d, size=%zu", ret,
               h264_size);
    }

    // Pool buffers stay allocated — no free needed
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

int encoder_thread_create(encoder_thread_t *ctx, encoder_context_t *encoder,
                          SharedFrameBuffer *shm_h264,
                          const char *shm_h264_name, int output_width,
                          int output_height) {
  if (!ctx || !encoder || !shm_h264)
    return -1;

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

  // Pre-allocate frame buffer pool
  size_t y_cap = (size_t)output_width * output_height;
  size_t uv_cap = y_cap / 2; // NV12: UV is half of Y
  ctx->pool_y_capacity = y_cap;
  ctx->pool_uv_capacity = uv_cap;

  for (int i = 0; i < ENCODER_QUEUE_SIZE; i++) {
    ctx->pool_y[i] = malloc(y_cap);
    ctx->pool_uv[i] = malloc(uv_cap);
    if (!ctx->pool_y[i] || !ctx->pool_uv[i]) {
      LOG_ERROR("EncoderThread", "Failed to pre-allocate frame pool slot %d", i);
      // Clean up already allocated
      for (int j = 0; j <= i; j++) {
        free(ctx->pool_y[j]);
        free(ctx->pool_uv[j]);
      }
      return -1;
    }
  }

  // Initialize condition variable
  pthread_mutex_init(&ctx->queue_mutex, NULL);
  pthread_cond_init(&ctx->queue_cond, NULL);

  LOG_INFO("EncoderThread", "Created (queue_size=%d, pool: %zuKB Y + %zuKB UV per slot)",
           ENCODER_QUEUE_SIZE, y_cap / 1024, uv_cap / 1024);
  return 0;
}

int encoder_thread_start(encoder_thread_t *ctx) {
  if (!ctx)
    return -1;

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

int encoder_thread_push_frame(encoder_thread_t *ctx, const uint8_t *y_data,
                              const uint8_t *uv_data, size_t y_size,
                              size_t uv_size, uint64_t frame_number,
                              int camera_id, struct timespec timestamp) {
  if (!ctx || !y_data || !uv_data)
    return -1;

  // Check if queue is full
  uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
  uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);

  if (write_idx - read_idx >= ENCODER_QUEUE_SIZE) {
    // Queue full, drop frame
    __atomic_fetch_add(&ctx->frames_dropped, 1, __ATOMIC_RELAXED);
    return -1;
  }

  // Use pre-allocated pool buffers instead of malloc
  uint32_t slot = write_idx % ENCODER_QUEUE_SIZE;

  if (y_size > ctx->pool_y_capacity || uv_size > ctx->pool_uv_capacity) {
    LOG_ERROR("EncoderThread", "Frame too large for pool: y=%zu/%zu uv=%zu/%zu",
              y_size, ctx->pool_y_capacity, uv_size, ctx->pool_uv_capacity);
    return -1;
  }

  memcpy(ctx->pool_y[slot], y_data, y_size);
  memcpy(ctx->pool_uv[slot], uv_data, uv_size);

  // Add to queue
  encoder_frame_t *frame = &ctx->queue[slot];
  frame->y_data = ctx->pool_y[slot];
  frame->uv_data = ctx->pool_uv[slot];
  frame->y_size = y_size;
  frame->uv_size = uv_size;
  frame->frame_number = frame_number;
  frame->camera_id = camera_id;
  frame->timestamp = timestamp;

  // Advance write index
  __atomic_store_n(&ctx->write_index, write_idx + 1, __ATOMIC_RELEASE);

  // Signal worker thread
  pthread_cond_signal(&ctx->queue_cond);

  return 0;
}

void encoder_thread_stop(encoder_thread_t *ctx) {
  if (!ctx || !ctx->running)
    return;

  LOG_INFO("EncoderThread", "Stopping...");
  ctx->running = false;

  // Wake up worker if it's waiting on condition
  pthread_cond_signal(&ctx->queue_cond);

  pthread_join(ctx->thread, NULL);

  LOG_INFO("EncoderThread", "Stopped");
}

void encoder_thread_destroy(encoder_thread_t *ctx) {
  if (!ctx)
    return;

  // Free pre-allocated pool
  for (int i = 0; i < ENCODER_QUEUE_SIZE; i++) {
    free(ctx->pool_y[i]);
    free(ctx->pool_uv[i]);
    ctx->pool_y[i] = NULL;
    ctx->pool_uv[i] = NULL;
  }

  pthread_mutex_destroy(&ctx->queue_mutex);
  pthread_cond_destroy(&ctx->queue_cond);

  memset(ctx, 0, sizeof(encoder_thread_t));
  LOG_INFO("EncoderThread", "Destroyed");
}
