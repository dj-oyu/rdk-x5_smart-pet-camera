/*
 * test_fps_reader.c - Test FPS reading from shared memory
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "shared_memory.h"

int main(int argc, char *argv[]) {
    const char *shm_name = (argc > 1) ? argv[1] : SHM_NAME_ACTIVE_FRAME;
    double duration = (argc > 2) ? atof(argv[2]) : 5.0;

    printf("Opening shared memory: %s\n", shm_name);
    SharedFrameBuffer *shm = shm_frame_buffer_open_named(shm_name);
    if (!shm) {
        fprintf(stderr, "Failed to open shared memory: %s\n", shm_name);
        return 1;
    }

    uint32_t initial_write_index = shm_frame_buffer_get_write_index(shm);
    printf("Initial write_index: %u\n", initial_write_index);
    printf("Reading for %.1f seconds...\n\n", duration);

    struct timespec start_time, current_time;
    clock_gettime(CLOCK_MONOTONIC, &start_time);
    double end_time = start_time.tv_sec + start_time.tv_nsec / 1e9 + duration;

    int frames_read = 0;
    int same_frame_count = 0;
    uint64_t last_frame_number = UINT64_MAX;
    Frame frame;

    while (1) {
        clock_gettime(CLOCK_MONOTONIC, &current_time);
        double now = current_time.tv_sec + current_time.tv_nsec / 1e9;
        if (now >= end_time) {
            break;
        }

        int ret = shm_frame_buffer_read_latest(shm, &frame);
        if (ret >= 0) {
            if (frame.frame_number != last_frame_number) {
                frames_read++;
                last_frame_number = frame.frame_number;

                if (frames_read % 30 == 0) {
                    printf("Read frame #%lu (camera=%d, size=%u)\n",
                           frame.frame_number, frame.camera_id, frame.data_size);
                }
            } else {
                same_frame_count++;
            }
        }

        usleep(100);  // 0.1ms poll interval
    }

    uint32_t final_write_index = shm_frame_buffer_get_write_index(shm);

    clock_gettime(CLOCK_MONOTONIC, &current_time);
    double elapsed = (current_time.tv_sec - start_time.tv_sec) +
                    (current_time.tv_nsec - start_time.tv_nsec) / 1e9;
    double fps = frames_read / elapsed;

    printf("\n=== Results ===\n");
    printf("Duration: %.2f seconds\n", elapsed);
    printf("Unique frames read: %d\n", frames_read);
    printf("Same frame count: %d\n", same_frame_count);
    printf("FPS: %.2f\n", fps);
    printf("Write index: %u -> %u (delta: %u)\n",
           initial_write_index, final_write_index,
           final_write_index - initial_write_index);
    printf("Expected frames at 30fps: %.0f\n", elapsed * 30.0);

    shm_frame_buffer_close(shm);
    return 0;
}
