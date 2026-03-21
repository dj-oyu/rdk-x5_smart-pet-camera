/*
 * encoder_thread.c - Threaded H.265 Encoder (Zero-Copy)
 *
 * Receives VSE frames via phys_addr, encodes with VPU (no memcpy),
 * and releases VSE buffers after encoding completes.
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

  uint8_t *h265_buffer = malloc(ctx->output_width * ctx->output_height * 3 / 2);
  if (!h265_buffer) {
    LOG_ERROR("EncoderThread", "Failed to allocate H.265 buffer");
    return NULL;
  }
  size_t h265_buffer_size = ctx->output_width * ctx->output_height * 3 / 2;

  LOG_INFO("EncoderThread", "Worker started (zero-copy phys_addr mode)");

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

    // Encode frame — single memcpy from VSE virt_addr to VPU input buffer
    size_t h265_size = 0;
    encoder_stats_t enc_stats = {0};
    int ret = encoder_encode_frame_vaddr(
        ctx->encoder,
        (const uint8_t *)frame->vse_frame.buffer.virt_addr[0],
        (const uint8_t *)frame->vse_frame.buffer.virt_addr[1],
        frame->vse_frame.buffer.size[0],
        frame->vse_frame.buffer.size[1],
        h265_buffer, &h265_size, h265_buffer_size, 2000, &enc_stats);

    if (ret == 0 && h265_size > 0) {
      // Write to shared memory
      if (ctx->shm_h264) {
        Frame h265_frame = {0};
        h265_frame.width = ctx->output_width;
        h265_frame.height = ctx->output_height;
        h265_frame.format = 4; // H.265
        h265_frame.data_size = h265_size;
        h265_frame.frame_number = frame->frame_number;
        h265_frame.camera_id = frame->camera_id;
        h265_frame.timestamp = frame->timestamp;

        if (h265_size <= sizeof(h265_frame.data)) {
          memcpy(h265_frame.data, h265_buffer, h265_size);
          if (shm_frame_buffer_write(ctx->shm_h264, &h265_frame) < 0) {
            LOG_WARN("EncoderThread", "Failed to write H.265 to %s",
                     ctx->shm_h264_name);
          } else {
            uint64_t encoded = __atomic_load_n(&ctx->frames_encoded, __ATOMIC_RELAXED);
            if (encoded % 30 == 0) {
              LOG_INFO("EncoderThread", "VPU stats frame#%lu: intra=%u skip=%u qp=%u bytes=%u",
                       frame->frame_number,
                       enc_stats.intra_block_num, enc_stats.skip_block_num,
                       enc_stats.avg_mb_qp, enc_stats.enc_pic_byte);
            }
          }
        } else {
          LOG_WARN("EncoderThread", "H.265 frame too large (%zu bytes)",
                   h265_size);
        }
      }

      __atomic_fetch_add(&ctx->frames_encoded, 1, __ATOMIC_RELAXED);
    } else {
      LOG_WARN("EncoderThread", "Encoding failed: ret=%d, size=%zu", ret,
               h265_size);
    }

    // Release VSE frame back to VIO buffer pool
    hbn_vnode_releaseframe(ctx->vse_handle, 0, &frame->vse_frame);

    // Advance read index
    __atomic_store_n(&ctx->read_index, read_idx + 1, __ATOMIC_RELEASE);
  }

  free(h265_buffer);
  LOG_INFO("EncoderThread", "Worker stopped (encoded=%lu, dropped=%lu)",
           ctx->frames_encoded, ctx->frames_dropped);

  return NULL;
}

int encoder_thread_create(encoder_thread_t *ctx, encoder_context_t *encoder,
                          SharedFrameBuffer *shm_h264,
                          const char *shm_h264_name, int output_width,
                          int output_height, hbn_vnode_handle_t vse_handle) {
  if (!ctx || !encoder || !shm_h264)
    return -1;

  memset(ctx, 0, sizeof(encoder_thread_t));

  ctx->encoder = encoder;
  ctx->shm_h264 = shm_h264;
  snprintf(ctx->shm_h264_name, sizeof(ctx->shm_h264_name), "%s", shm_h264_name);
  ctx->output_width = output_width;
  ctx->output_height = output_height;
  ctx->vse_handle = vse_handle;

  ctx->write_index = 0;
  ctx->read_index = 0;
  ctx->frames_encoded = 0;
  ctx->frames_dropped = 0;

  // Initialize condition variable
  pthread_mutex_init(&ctx->queue_mutex, NULL);
  pthread_cond_init(&ctx->queue_cond, NULL);

  LOG_INFO("EncoderThread", "Created (queue_size=%d, zero-copy phys_addr mode)",
           ENCODER_QUEUE_SIZE);
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

int encoder_thread_push_frame(encoder_thread_t *ctx,
                              hbn_vnode_image_t *vse_frame,
                              uint64_t frame_number,
                              int camera_id,
                              struct timespec timestamp) {
  if (!ctx || !vse_frame)
    return -1;

  // Check if queue is full
  uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
  uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);

  if (write_idx - read_idx >= ENCODER_QUEUE_SIZE) {
    // Queue full, drop frame (caller must release vse_frame)
    __atomic_fetch_add(&ctx->frames_dropped, 1, __ATOMIC_RELAXED);
    return -1;
  }

  // Store VSE frame in queue (zero-copy: no data memcpy)
  uint32_t slot = write_idx % ENCODER_QUEUE_SIZE;
  encoder_frame_t *frame = &ctx->queue[slot];

  frame->vse_frame = *vse_frame;  // Copy frame handle (virt_addr used for encoding)
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

  pthread_mutex_destroy(&ctx->queue_mutex);
  pthread_cond_destroy(&ctx->queue_cond);

  memset(ctx, 0, sizeof(encoder_thread_t));
  LOG_INFO("EncoderThread", "Destroyed");
}
