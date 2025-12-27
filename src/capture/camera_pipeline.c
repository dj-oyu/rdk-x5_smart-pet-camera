/*
 * camera_pipeline.c - Camera Pipeline Implementation
 */

#include "camera_pipeline.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "logger.h"
#include "hb_mem_mgr.h"

int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                    int sensor_width, int sensor_height,
                    int output_width, int output_height,
                    int fps, int bitrate,
                    const char *shm_h264_name) {
    int ret = 0;

    if (!pipeline || !shm_h264_name) return -1;

    memset(pipeline, 0, sizeof(camera_pipeline_t));

    pipeline->camera_index = camera_index;
    pipeline->sensor_width = sensor_width;
    pipeline->sensor_height = sensor_height;
    pipeline->output_width = output_width;
    pipeline->output_height = output_height;
    pipeline->fps = fps;
    pipeline->bitrate = bitrate;

    LOG_INFO("Pipeline", "Creating pipeline for Camera %d (%dx%d@%dfps, %dkbps)",
             camera_index, output_width, output_height, fps, bitrate / 1000);

    // Initialize memory manager
    ret = hb_mem_module_open();
    if (ret != 0) {
        LOG_ERROR("Pipeline", "hb_mem_module_open failed: %d", ret);
        return ret;
    }

    // Create VIO context
    ret = vio_create(&pipeline->vio, camera_index,
                     sensor_width, sensor_height,
                     output_width, output_height, fps);
    if (ret != 0) {
        LOG_ERROR("Pipeline", "vio_create failed: %d", ret);
        goto error_cleanup;
    }

    // Create Encoder context
    ret = encoder_create(&pipeline->encoder, camera_index,
                         output_width, output_height, fps, bitrate);
    if (ret != 0) {
        LOG_ERROR("Pipeline", "encoder_create failed: %d", ret);
        goto error_cleanup;
    }

    // Create shared memory for H.264 output
    pipeline->shm_h264 = shm_frame_buffer_create_named(shm_h264_name);
    if (!pipeline->shm_h264) {
        LOG_ERROR("Pipeline", "Failed to create shared memory: %s", shm_h264_name);
        ret = -1;
        goto error_cleanup;
    }

    LOG_INFO("Pipeline", "Pipeline created successfully");
    return 0;

error_cleanup:
    pipeline_destroy(pipeline);
    return ret;
}

int pipeline_start(camera_pipeline_t *pipeline) {
    if (!pipeline) return -1;

    int ret = vio_start(&pipeline->vio);
    if (ret != 0) {
        LOG_ERROR("Pipeline", "vio_start failed: %d", ret);
        return ret;
    }

    LOG_INFO("Pipeline", "Pipeline started");
    return 0;
}

int pipeline_run(camera_pipeline_t *pipeline, volatile bool *running_flag) {
    if (!pipeline || !running_flag) return -1;

    pipeline->running_flag = running_flag;

    int frame_count = 0;
    struct timespec start_time, current_time;
    clock_gettime(CLOCK_MONOTONIC, &start_time);

    hbn_vnode_image_t vio_frame = {0};
    uint8_t *h264_buffer = NULL;
    size_t h264_buffer_size = pipeline->output_width * pipeline->output_height * 3 / 2;

    // Allocate H.264 output buffer
    h264_buffer = (uint8_t *)malloc(h264_buffer_size);
    if (!h264_buffer) {
        LOG_ERROR("Pipeline", "Failed to allocate H.264 buffer");
        return -1;
    }

    LOG_INFO("Pipeline", "Starting capture loop...");

    while (*running_flag) {
        int ret;

        // Get NV12 frame from VIO
        ret = vio_get_frame(&pipeline->vio, &vio_frame, 2000);
        if (ret != 0) {
            LOG_WARN("Pipeline", "vio_get_frame failed: %d", ret);
            continue;
        }

        // Encode NV12 → H.264
        size_t h264_size = 0;
        ret = encoder_encode_frame(&pipeline->encoder,
                                   (uint8_t *)vio_frame.buffer.virt_addr[0],  // Y plane
                                   (uint8_t *)vio_frame.buffer.virt_addr[1],  // UV plane
                                   h264_buffer, &h264_size,
                                   h264_buffer_size, 2000);

        // Release VIO frame immediately
        vio_release_frame(&pipeline->vio, &vio_frame);

        if (ret != 0) {
            LOG_WARN("Pipeline", "encoder_encode_frame failed: %d", ret);
            continue;
        }

        // Write H.264 to shared memory
        if (pipeline->shm_h264 && h264_size > 0) {
            Frame shm_frame = {0};
            shm_frame.width = pipeline->output_width;
            shm_frame.height = pipeline->output_height;
            shm_frame.format = 3;  // H.264
            shm_frame.data_size = h264_size;
            shm_frame.frame_number = frame_count;
            shm_frame.camera_id = pipeline->camera_index;
            clock_gettime(CLOCK_MONOTONIC, &shm_frame.timestamp);

            if (h264_size <= sizeof(shm_frame.data)) {
                memcpy(shm_frame.data, h264_buffer, h264_size);
                shm_frame_buffer_write(pipeline->shm_h264, &shm_frame);
            } else {
                LOG_WARN("Pipeline", "H.264 frame too large (%zu bytes)", h264_size);
            }
        }

        frame_count++;

        // Print FPS every 30 frames
        if (frame_count % 30 == 0) {
            clock_gettime(CLOCK_MONOTONIC, &current_time);
            double elapsed = (current_time.tv_sec - start_time.tv_sec) +
                            (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
            double fps = frame_count / elapsed;
            LOG_INFO("Pipeline", "Frame %d, FPS: %.2f, H.264 size: %zu bytes",
                     frame_count, fps, h264_size);
        }
    }

    // Final statistics
    clock_gettime(CLOCK_MONOTONIC, &current_time);
    double total_elapsed = (current_time.tv_sec - start_time.tv_sec) +
                          (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
    double avg_fps = frame_count / total_elapsed;
    LOG_INFO("Pipeline", "Completed: %d frames in %.2f seconds (avg FPS: %.2f)",
             frame_count, total_elapsed, avg_fps);

    free(h264_buffer);
    return 0;
}

void pipeline_stop(camera_pipeline_t *pipeline) {
    if (!pipeline) return;

    vio_stop(&pipeline->vio);
    encoder_stop(&pipeline->encoder);

    LOG_INFO("Pipeline", "Pipeline stopped");
}

void pipeline_destroy(camera_pipeline_t *pipeline) {
    if (!pipeline) return;

    // Destroy encoder
    encoder_destroy(&pipeline->encoder);

    // Destroy VIO
    vio_destroy(&pipeline->vio);

    // Close shared memory
    if (pipeline->shm_h264) {
        const char *shm_name = "/pet_camera_stream";  // Default name
        shm_frame_buffer_destroy_named(pipeline->shm_h264, shm_name);
        pipeline->shm_h264 = NULL;
    }

    // Close memory manager
    hb_mem_module_close();

    memset(pipeline, 0, sizeof(camera_pipeline_t));
    LOG_INFO("Pipeline", "Pipeline destroyed");
}
