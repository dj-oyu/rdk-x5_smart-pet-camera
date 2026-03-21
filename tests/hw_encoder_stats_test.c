/*
 * hw_encoder_stats_test.c - Read VPU encoder motion statistics
 *
 * Reads intra_block_num / skip_block_num from H.265 encoder output.
 * These are computed by VPU during encoding — zero CPU cost.
 *
 * Build:
 *   cd src/capture && gcc -I. -I/usr/include -O2 -o ../../tests/hw_encoder_stats_test \
 *     ../../tests/hw_encoder_stats_test.c shared_memory.o logger.o \
 *     -L/usr/hobot/lib -lrt -lpthread -lhbmem
 *
 * Run (requires camera_switcher_daemon running):
 *   ./tests/hw_encoder_stats_test [num_frames]
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include "shared_memory.h"

static volatile int running = 1;

static void signal_handler(int sig) {
    (void)sig;
    running = 0;
}

int main(int argc, char *argv[]) {
    int max_frames = 300; // 10 seconds at 30fps
    if (argc > 1) max_frames = atoi(argv[1]);

    signal(SIGINT, signal_handler);

    // Open H.265 stream SHM
    SharedFrameBuffer *shm = shm_frame_buffer_open_named("/pet_camera_stream");
    if (!shm) {
        fprintf(stderr, "Failed to open /pet_camera_stream SHM\n");
        fprintf(stderr, "Start camera_switcher_daemon first\n");
        return 1;
    }

    printf("=== VPU Encoder Stats Test ===\n");
    printf("Reading H.265 frames from /pet_camera_stream\n");
    printf("Max frames: %d\n\n", max_frames);
    printf("%-6s %-10s %-8s %-12s %-12s %-10s %-10s\n",
           "Frame", "Size", "Type", "IntraBlocks", "SkipBlocks", "MotionPct", "AvgQP");
    printf("----------------------------------------------------------------------\n");

    uint64_t last_frame_number = 0;
    int frames_read = 0;
    Frame frame = {0};

    while (running && frames_read < max_frames) {
        uint32_t write_idx = shm_frame_buffer_get_write_index(shm);
        if (write_idx == 0) {
            usleep(10000);
            continue;
        }

        int ret = shm_frame_buffer_read_latest(shm, &frame);
        if (ret < 0 || frame.frame_number == last_frame_number) {
            usleep(5000);
            continue;
        }
        last_frame_number = frame.frame_number;

        if (frame.format != 4 || frame.data_size == 0) {
            continue;
        }

        // Parse H.265 NAL type from bitstream
        const char *frame_type = "?";
        if (frame.data_size >= 5 &&
            frame.data[0] == 0 && frame.data[1] == 0 &&
            frame.data[2] == 0 && frame.data[3] == 1) {
            int nal_type = (frame.data[4] >> 1) & 0x3F;
            switch (nal_type) {
                case 1:  frame_type = "P"; break;
                case 19: frame_type = "IDR"; break;
                case 20: frame_type = "IDR"; break;
                case 32: frame_type = "VPS"; break;
                case 33: frame_type = "SPS"; break;
                case 34: frame_type = "PPS"; break;
                default: frame_type = "?"; break;
            }
        }

        // Estimate motion from frame size variance
        // Large P-frames indicate more motion (more residual data)
        // Small P-frames indicate static scene (most blocks skipped)
        //
        // For actual intra_block_num/skip_block_num, we need to modify
        // encoder_thread.c to write these to SHM metadata.
        // This test uses frame size as a proxy.
        int total_blocks_8x8 = (frame.width / 8) * (frame.height / 8);
        // Heuristic: frame size relative to I-frame size indicates motion
        // P-frame with ~same size as I-frame = lots of motion
        // P-frame with much smaller size = mostly static
        float motion_pct = 0.0f;
        if (strcmp(frame_type, "P") == 0 && total_blocks_8x8 > 0) {
            // Rough heuristic: bytes per block
            float bytes_per_block = (float)frame.data_size / total_blocks_8x8;
            // Typical: static ~1-3 bytes/block, motion ~10-50 bytes/block
            motion_pct = bytes_per_block / 50.0f * 100.0f;
            if (motion_pct > 100.0f) motion_pct = 100.0f;
        }

        printf("%-6lu %-10zu %-8s %-12s %-12s %-9.1f%% %-10s\n",
               frame.frame_number,
               frame.data_size,
               frame_type,
               "(need SHM)", "(need SHM)",
               motion_pct,
               "(need SHM)");

        frames_read++;
        usleep(30000); // ~30fps
    }

    shm_frame_buffer_close(shm);

    printf("\n=== Summary ===\n");
    printf("Frames read: %d\n", frames_read);
    printf("\nTo get actual intra_block_num/skip_block_num:\n");
    printf("  1. encoder_thread.c: read output_info.video_stream_info\n");
    printf("  2. Write to Frame metadata or separate SHM\n");
    printf("  3. Python detector reads from SHM\n");

    return 0;
}
