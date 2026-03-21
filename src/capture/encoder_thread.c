/*
 * encoder_thread.c - Threaded H.265 Encoder (Full Zero-Copy)
 *
 * VSE frame → VPU encode → share_id via SHM → Go imports directly.
 * No h265_buffer malloc, no memcpy of bitstream data.
 */

#include "encoder_thread.h"
#include "logger.h"
#include "vio_lowlevel.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static void *encoder_thread_worker(void *arg) {
  encoder_thread_t *ctx = (encoder_thread_t *)arg;

  LOG_INFO("EncoderThread", "Worker started (full zero-copy mode)");

  while (ctx->running) {
    uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);
    uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);

    if (read_idx == write_idx) {
      pthread_mutex_lock(&ctx->queue_mutex);
      write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
      if (read_idx == write_idx && ctx->running) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_nsec += 50 * 1000000;
        if (ts.tv_nsec >= 1000000000) {
          ts.tv_sec++;
          ts.tv_nsec -= 1000000000;
        }
        pthread_cond_timedwait(&ctx->queue_cond, &ctx->queue_mutex, &ts);
      }
      pthread_mutex_unlock(&ctx->queue_mutex);
      continue;
    }

    encoder_frame_t *frame = &ctx->queue[read_idx % ENCODER_QUEUE_SIZE];

    // Encode FIRST, then release prev (so SHM always has valid share_id)
    encoder_output_t enc_out = {0};
    int ret = encoder_encode_frame_zerocopy(
        ctx->encoder,
        (const uint8_t *)frame->vse_frame.buffer.virt_addr[0],
        (const uint8_t *)frame->vse_frame.buffer.virt_addr[1],
        frame->vse_frame.buffer.size[0],
        frame->vse_frame.buffer.size[1],
        2000, &enc_out);

    // Release VSE frame (input side, always release)
    hbn_vnode_releaseframe(ctx->vse_handle, 0, &frame->vse_frame);

    if (ret == 0 && enc_out.data_size > 0 && enc_out.share_id >= 0) {
      // Check if consumer (Go) is ready to receive
      // If not ready, skip zero-copy and just release VPU buffer
      // Write share_id to SHM (non-blocking, no semaphore wait)
      if (ctx->shm_h265_zc) {
        H265ZeroCopyFrame zc = {
            .frame_number = frame->frame_number,
            .timestamp = frame->timestamp,
            .camera_id = frame->camera_id,
            .width = ctx->output_width,
            .height = ctx->output_height,
            .share_id = enc_out.share_id,
            .data_size = enc_out.data_size,
            .buf_size = enc_out.buf_size,
            .phy_ptr = enc_out.phy_ptr,
        };
        shm_h265_zc_write(ctx->shm_h265_zc, &zc);
      }

      // NOW release previous VPU buffer (SHM has new share_id, prev is safe to free)
      if (ctx->prev_enc_out.vir_ptr) {
        encoder_release_output(ctx->encoder, &ctx->prev_enc_out, 2000);
      }
      ctx->prev_enc_out = enc_out;
      __atomic_fetch_add(&ctx->frames_encoded, 1, __ATOMIC_RELAXED);
    } else {
      if (ret != 0) {
        LOG_WARN("EncoderThread", "Encoding failed: %d", ret);
      }
      // Release VPU output if dequeued but unusable
      if (enc_out.vir_ptr) {
        encoder_release_output(ctx->encoder, &enc_out, 2000);
      }
    }

    __atomic_store_n(&ctx->read_index, read_idx + 1, __ATOMIC_RELEASE);
  }

  LOG_INFO("EncoderThread", "Worker stopped (encoded=%lu, dropped=%lu)",
           ctx->frames_encoded, ctx->frames_dropped);
  return NULL;
}

int encoder_thread_create(encoder_thread_t *ctx, encoder_context_t *encoder,
                          H265ZeroCopyBuffer *shm_h265_zc,
                          int output_width, int output_height,
                          hbn_vnode_handle_t vse_handle) {
  if (!ctx || !encoder)
    return -1;

  memset(ctx, 0, sizeof(encoder_thread_t));

  ctx->encoder = encoder;
  ctx->shm_h265_zc = shm_h265_zc;
  ctx->output_width = output_width;
  ctx->output_height = output_height;
  ctx->vse_handle = vse_handle;

  pthread_mutex_init(&ctx->queue_mutex, NULL);
  pthread_cond_init(&ctx->queue_cond, NULL);

  LOG_INFO("EncoderThread", "Created (queue_size=%d, full zero-copy mode)",
           ENCODER_QUEUE_SIZE);
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
                              hbn_vnode_image_t *vse_frame,
                              uint64_t frame_number,
                              int camera_id,
                              struct timespec timestamp) {
  if (!ctx || !vse_frame) return -1;

  uint32_t write_idx = __atomic_load_n(&ctx->write_index, __ATOMIC_ACQUIRE);
  uint32_t read_idx = __atomic_load_n(&ctx->read_index, __ATOMIC_ACQUIRE);

  if (write_idx - read_idx >= ENCODER_QUEUE_SIZE) {
    __atomic_fetch_add(&ctx->frames_dropped, 1, __ATOMIC_RELAXED);
    return -1;
  }

  uint32_t slot = write_idx % ENCODER_QUEUE_SIZE;
  encoder_frame_t *frame = &ctx->queue[slot];
  frame->vse_frame = *vse_frame;
  frame->frame_number = frame_number;
  frame->camera_id = camera_id;
  frame->timestamp = timestamp;

  __atomic_store_n(&ctx->write_index, write_idx + 1, __ATOMIC_RELEASE);
  pthread_cond_signal(&ctx->queue_cond);
  return 0;
}

void encoder_thread_stop(encoder_thread_t *ctx) {
  if (!ctx || !ctx->running) return;
  LOG_INFO("EncoderThread", "Stopping...");
  ctx->running = false;
  pthread_cond_signal(&ctx->queue_cond);
  pthread_join(ctx->thread, NULL);
  LOG_INFO("EncoderThread", "Stopped");
}

void encoder_thread_destroy(encoder_thread_t *ctx) {
  if (!ctx) return;
  pthread_mutex_destroy(&ctx->queue_mutex);
  pthread_cond_destroy(&ctx->queue_cond);
  memset(ctx, 0, sizeof(encoder_thread_t));
  LOG_INFO("EncoderThread", "Destroyed");
}
