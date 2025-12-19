/**
 * test_daemon_reader.c - Read frames from running camera daemon
 *
 * This program connects to the shared memory created by camera_daemon_drobotics
 * and continuously reads frames to verify the daemon is working correctly.
 *
 * Usage:
 *   ./build/test_daemon_reader [-n NUM_FRAMES] [-s]
 *
 * Options:
 *   -n NUM_FRAMES  Number of frames to read (default: 100)
 *   -s             Save frames to disk as JPEG files
 *   -v             Verbose mode (show detailed frame info)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/stat.h>

#include "shared_memory.h"

static volatile int running = 1;

void signal_handler(int signum) {
    (void)signum;
    running = 0;
    printf("\n[Signal] Shutting down...\n");
}

// Calculate time difference in milliseconds
double timespec_diff_ms(struct timespec *start, struct timespec *end) {
    return (end->tv_sec - start->tv_sec) * 1000.0 +
           (end->tv_nsec - start->tv_nsec) / 1000000.0;
}

// Save frame to JPEG file
int save_frame_to_file(const Frame *frame, const char *output_dir) {
    char filename[256];
    snprintf(filename, sizeof(filename), "%s/frame_%06lu.jpg",
             output_dir, frame->frame_number);

    FILE *fp = fopen(filename, "wb");
    if (!fp) {
        fprintf(stderr, "[Error] Cannot create file: %s\n", filename);
        return -1;
    }

    size_t written = fwrite(frame->data, 1, frame->data_size, fp);
    fclose(fp);

    if (written != frame->data_size) {
        fprintf(stderr, "[Error] Failed to write complete frame\n");
        return -1;
    }

    return 0;
}

void print_usage(const char *prog_name) {
    printf("Usage: %s [OPTIONS]\n", prog_name);
    printf("\nOptions:\n");
    printf("  -n NUM    Number of frames to read (default: 100, 0 = infinite)\n");
    printf("  -s        Save frames to ./frames/ directory\n");
    printf("  -v        Verbose mode (show detailed frame info)\n");
    printf("  -h        Show this help message\n");
    printf("\nExamples:\n");
    printf("  %s                # Read 100 frames\n", prog_name);
    printf("  %s -n 0           # Read continuously until Ctrl+C\n", prog_name);
    printf("  %s -n 30 -s       # Read 30 frames and save them\n", prog_name);
    printf("  %s -n 0 -v        # Continuous read with verbose output\n", prog_name);
}

int main(int argc, char *argv[]) {
    int num_frames = 100;
    int save_frames = 0;
    int verbose = 0;

    // Parse command line arguments
    int opt;
    while ((opt = getopt(argc, argv, "n:svh")) != -1) {
        switch (opt) {
            case 'n':
                num_frames = atoi(optarg);
                break;
            case 's':
                save_frames = 1;
                break;
            case 'v':
                verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    printf("=== Camera Daemon Reader Test ===\n");
    printf("Settings:\n");
    printf("  Frames to read: %s\n", num_frames == 0 ? "infinite" : "");
    if (num_frames > 0) {
        printf("  Frames to read: %d\n", num_frames);
    }
    printf("  Save frames: %s\n", save_frames ? "yes" : "no");
    printf("  Verbose: %s\n", verbose ? "yes" : "no");
    printf("\n");

    // Create output directory if saving frames
    if (save_frames) {
        mkdir("frames", 0755);
        printf("[Info] Saving frames to ./frames/\n");
    }

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Open shared memory (read-only)
    printf("[Info] Opening shared memory...\n");
    SharedFrameBuffer *shm = shm_frame_buffer_open();
    if (!shm) {
        fprintf(stderr, "[Error] Failed to open shared memory\n");
        fprintf(stderr, "[Error] Make sure camera daemon is running:\n");
        fprintf(stderr, "[Error]   make -f Makefile.drobotics run-daemon\n");
        return 1;
    }
    printf("[Info] Successfully connected to shared memory\n");

    // Statistics
    int frames_read = 0;
    int frames_saved = 0;
    uint64_t last_frame_number = 0;
    int dropped_frames = 0;
    struct timespec start_time, current_time;
    clock_gettime(CLOCK_MONOTONIC, &start_time);

    Frame frame = {0};

    printf("\n[Info] Starting to read frames... (Press Ctrl+C to stop)\n\n");

    while (running && (num_frames == 0 || frames_read < num_frames)) {
        int ret = shm_frame_buffer_read_latest(shm, &frame);

        if (ret < 0) {
            // No frames available yet
            if (frames_read == 0 && verbose) {
                printf("[Info] Waiting for first frame...\n");
            }
            usleep(10000);  // Sleep 10ms
            continue;
        }

        // Check for dropped frames
        if (frames_read > 0 && frame.frame_number > last_frame_number + 1) {
            int dropped = frame.frame_number - last_frame_number - 1;
            dropped_frames += dropped;
            if (verbose) {
                printf("[Warning] Dropped %d frames (jump from %lu to %lu)\n",
                       dropped, last_frame_number, frame.frame_number);
            }
        }

        last_frame_number = frame.frame_number;
        frames_read++;

        // Print frame info
        if (verbose) {
            printf("[Frame %06lu] Camera %d, %dx%d, %zu bytes, buffer_index=%d\n",
                   frame.frame_number, frame.camera_id,
                   frame.width, frame.height, frame.data_size, ret);
        } else if (frames_read % 30 == 0) {
            // Print progress every 30 frames
            clock_gettime(CLOCK_MONOTONIC, &current_time);
            double elapsed = timespec_diff_ms(&start_time, &current_time);
            double fps = (frames_read * 1000.0) / elapsed;
            printf("[Progress] Read %d frames (%.1f fps, %d dropped)\n",
                   frames_read, fps, dropped_frames);
        }

        // Save frame if requested
        if (save_frames) {
            if (save_frame_to_file(&frame, "frames") == 0) {
                frames_saved++;
                if (verbose) {
                    printf("  -> Saved as frames/frame_%06lu.jpg\n", frame.frame_number);
                }
            }
        }

        // Sleep to avoid busy-waiting
        usleep(1000);  // 1ms
    }

    // Calculate statistics
    clock_gettime(CLOCK_MONOTONIC, &current_time);
    double total_time = timespec_diff_ms(&start_time, &current_time);
    double avg_fps = (frames_read * 1000.0) / total_time;

    printf("\n=== Test Results ===\n");
    printf("Total frames read: %d\n", frames_read);
    printf("Total time: %.2f seconds\n", total_time / 1000.0);
    printf("Average FPS: %.2f\n", avg_fps);
    printf("Dropped frames: %d\n", dropped_frames);
    if (save_frames) {
        printf("Frames saved: %d\n", frames_saved);
    }

    if (frames_read > 0) {
        printf("\nLast frame info:\n");
        printf("  Frame number: %lu\n", frame.frame_number);
        printf("  Camera ID: %d\n", frame.camera_id);
        printf("  Resolution: %dx%d\n", frame.width, frame.height);
        printf("  Data size: %zu bytes\n", frame.data_size);
        printf("  Format: %s\n", frame.format == 0 ? "JPEG" : "Unknown");
    }

    // Cleanup
    shm_frame_buffer_close(shm);
    printf("\n[Info] Test completed successfully\n");

    return 0;
}
