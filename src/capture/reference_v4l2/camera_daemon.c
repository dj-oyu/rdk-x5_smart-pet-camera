/**
 * camera_daemon.c - V4L2 camera capture daemon with shared memory output
 *
 * Features:
 * - V4L2 camera capture (YUYV/MJPEG)
 * - JPEG encoding (for YUYV input)
 * - Shared memory ring buffer output
 * - Signal handling for clean shutdown
 * - Multi-camera support
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <linux/videodev2.h>
#include <jpeglib.h>

#include "shared_memory.h"

#define BUFFER_COUNT 4
#define DEFAULT_DEVICE "/dev/video0"
#define DEFAULT_WIDTH 640
#define DEFAULT_HEIGHT 480
#define DEFAULT_FPS 30
#define JPEG_QUALITY 85

// V4L2 buffer structure
typedef struct {
    void* start;
    size_t length;
} v4l2_buffer_t;

// Camera context
typedef struct {
    int fd;
    int camera_id;
    int width;
    int height;
    int fps;
    uint32_t pixel_format;
    v4l2_buffer_t buffers[BUFFER_COUNT];
    int buffer_count;
    uint64_t frame_counter;
} camera_t;

// Global state
static volatile sig_atomic_t g_running = 1;
static SharedFrameBuffer* g_shm = NULL;

// Signal handler
static void signal_handler(int signum) {
    (void)signum;
    g_running = 0;
    printf("\n[Info] Shutdown signal received\n");
}

// Setup signal handlers
static void setup_signals(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_handler;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
}

// JPEG encoding (YUYV to JPEG)
static int encode_yuyv_to_jpeg(const uint8_t* yuyv_data,
                                int width, int height,
                                uint8_t* jpeg_buffer,
                                size_t* jpeg_size,
                                size_t max_size) {
    struct jpeg_compress_struct cinfo;
    struct jpeg_error_mgr jerr;

    cinfo.err = jpeg_std_error(&jerr);
    jpeg_create_compress(&cinfo);

    // Output to memory buffer
    unsigned long outsize = max_size;
    unsigned char* outbuffer = jpeg_buffer;
    jpeg_mem_dest(&cinfo, &outbuffer, &outsize);

    // Set parameters
    cinfo.image_width = width;
    cinfo.image_height = height;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, JPEG_QUALITY, TRUE);

    jpeg_start_compress(&cinfo, TRUE);

    // Convert YUYV to RGB and compress row by row
    uint8_t* rgb_row = (uint8_t*)malloc(width * 3);
    if (!rgb_row) {
        jpeg_destroy_compress(&cinfo);
        return -1;
    }

    for (int y = 0; y < height; y++) {
        const uint8_t* yuyv_row = yuyv_data + y * width * 2;

        // Convert YUYV to RGB
        for (int x = 0; x < width; x += 2) {
            int y0 = yuyv_row[x * 2 + 0];
            int u  = yuyv_row[x * 2 + 1];
            int y1 = yuyv_row[x * 2 + 2];
            int v  = yuyv_row[x * 2 + 3];

            // YUV to RGB conversion
            int c0 = y0 - 16;
            int c1 = y1 - 16;
            int d = u - 128;
            int e = v - 128;

            // Pixel 0
            int r0 = (298 * c0 + 409 * e + 128) >> 8;
            int g0 = (298 * c0 - 100 * d - 208 * e + 128) >> 8;
            int b0 = (298 * c0 + 516 * d + 128) >> 8;

            rgb_row[x * 3 + 0] = (r0 < 0) ? 0 : (r0 > 255) ? 255 : r0;
            rgb_row[x * 3 + 1] = (g0 < 0) ? 0 : (g0 > 255) ? 255 : g0;
            rgb_row[x * 3 + 2] = (b0 < 0) ? 0 : (b0 > 255) ? 255 : b0;

            // Pixel 1
            if (x + 1 < width) {
                int r1 = (298 * c1 + 409 * e + 128) >> 8;
                int g1 = (298 * c1 - 100 * d - 208 * e + 128) >> 8;
                int b1 = (298 * c1 + 516 * d + 128) >> 8;

                rgb_row[(x + 1) * 3 + 0] = (r1 < 0) ? 0 : (r1 > 255) ? 255 : r1;
                rgb_row[(x + 1) * 3 + 1] = (g1 < 0) ? 0 : (g1 > 255) ? 255 : g1;
                rgb_row[(x + 1) * 3 + 2] = (b1 < 0) ? 0 : (b1 > 255) ? 255 : b1;
            }
        }

        JSAMPROW row_pointer[1] = {rgb_row};
        jpeg_write_scanlines(&cinfo, row_pointer, 1);
    }

    free(rgb_row);
    jpeg_finish_compress(&cinfo);

    *jpeg_size = outsize;
    jpeg_destroy_compress(&cinfo);

    return 0;
}

// Open V4L2 camera
static int camera_open(camera_t* cam, const char* device) {
    cam->fd = open(device, O_RDWR);
    if (cam->fd < 0) {
        fprintf(stderr, "[Error] Cannot open %s: %s\n", device, strerror(errno));
        return -1;
    }

    // Query capabilities
    struct v4l2_capability cap;
    if (ioctl(cam->fd, VIDIOC_QUERYCAP, &cap) < 0) {
        fprintf(stderr, "[Error] VIDIOC_QUERYCAP failed: %s\n", strerror(errno));
        close(cam->fd);
        return -1;
    }

    printf("[Info] Camera: %s\n", cap.card);
    printf("[Info] Driver: %s\n", cap.driver);

    if (!(cap.capabilities & V4L2_CAP_VIDEO_CAPTURE)) {
        fprintf(stderr, "[Error] Not a video capture device\n");
        close(cam->fd);
        return -1;
    }

    if (!(cap.capabilities & V4L2_CAP_STREAMING)) {
        fprintf(stderr, "[Error] Does not support streaming I/O\n");
        close(cam->fd);
        return -1;
    }

    return 0;
}

// Set format and framerate
static int camera_set_format(camera_t* cam) {
    // Try MJPEG first, fallback to YUYV
    struct v4l2_format fmt;
    memset(&fmt, 0, sizeof(fmt));
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    fmt.fmt.pix.width = cam->width;
    fmt.fmt.pix.height = cam->height;
    fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
    fmt.fmt.pix.field = V4L2_FIELD_NONE;

    if (ioctl(cam->fd, VIDIOC_S_FMT, &fmt) < 0) {
        // MJPEG failed, try YUYV
        fmt.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
        if (ioctl(cam->fd, VIDIOC_S_FMT, &fmt) < 0) {
            fprintf(stderr, "[Error] VIDIOC_S_FMT failed: %s\n", strerror(errno));
            return -1;
        }
    }

    cam->pixel_format = fmt.fmt.pix.pixelformat;
    cam->width = fmt.fmt.pix.width;
    cam->height = fmt.fmt.pix.height;

    printf("[Info] Format: %dx%d, fourcc=%c%c%c%c\n",
           cam->width, cam->height,
           (cam->pixel_format >> 0) & 0xFF,
           (cam->pixel_format >> 8) & 0xFF,
           (cam->pixel_format >> 16) & 0xFF,
           (cam->pixel_format >> 24) & 0xFF);

    // Set framerate
    struct v4l2_streamparm parm;
    memset(&parm, 0, sizeof(parm));
    parm.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    parm.parm.capture.timeperframe.numerator = 1;
    parm.parm.capture.timeperframe.denominator = cam->fps;

    if (ioctl(cam->fd, VIDIOC_S_PARM, &parm) < 0) {
        fprintf(stderr, "[Warn] VIDIOC_S_PARM failed: %s\n", strerror(errno));
    }

    return 0;
}

// Initialize MMAP buffers
static int camera_init_mmap(camera_t* cam) {
    struct v4l2_requestbuffers req;
    memset(&req, 0, sizeof(req));
    req.count = BUFFER_COUNT;
    req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    req.memory = V4L2_MEMORY_MMAP;

    if (ioctl(cam->fd, VIDIOC_REQBUFS, &req) < 0) {
        fprintf(stderr, "[Error] VIDIOC_REQBUFS failed: %s\n", strerror(errno));
        return -1;
    }

    if (req.count < 2) {
        fprintf(stderr, "[Error] Insufficient buffer memory\n");
        return -1;
    }

    cam->buffer_count = req.count;

    // Map buffers
    for (int i = 0; i < cam->buffer_count; i++) {
        struct v4l2_buffer buf;
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buf.memory = V4L2_MEMORY_MMAP;
        buf.index = i;

        if (ioctl(cam->fd, VIDIOC_QUERYBUF, &buf) < 0) {
            fprintf(stderr, "[Error] VIDIOC_QUERYBUF failed: %s\n", strerror(errno));
            return -1;
        }

        cam->buffers[i].length = buf.length;
        cam->buffers[i].start = mmap(NULL, buf.length,
                                      PROT_READ | PROT_WRITE,
                                      MAP_SHARED,
                                      cam->fd, buf.m.offset);

        if (cam->buffers[i].start == MAP_FAILED) {
            fprintf(stderr, "[Error] mmap failed: %s\n", strerror(errno));
            return -1;
        }
    }

    printf("[Info] Allocated %d MMAP buffers\n", cam->buffer_count);
    return 0;
}

// Start streaming
static int camera_start(camera_t* cam) {
    // Queue all buffers
    for (int i = 0; i < cam->buffer_count; i++) {
        struct v4l2_buffer buf;
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buf.memory = V4L2_MEMORY_MMAP;
        buf.index = i;

        if (ioctl(cam->fd, VIDIOC_QBUF, &buf) < 0) {
            fprintf(stderr, "[Error] VIDIOC_QBUF failed: %s\n", strerror(errno));
            return -1;
        }
    }

    // Start streaming
    enum v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (ioctl(cam->fd, VIDIOC_STREAMON, &type) < 0) {
        fprintf(stderr, "[Error] VIDIOC_STREAMON failed: %s\n", strerror(errno));
        return -1;
    }

    printf("[Info] Streaming started\n");
    return 0;
}

// Capture and process frames
static void camera_capture_loop(camera_t* cam) {
    struct v4l2_buffer buf;
    Frame frame;

    while (g_running) {
        memset(&buf, 0, sizeof(buf));
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buf.memory = V4L2_MEMORY_MMAP;

        // Dequeue buffer
        if (ioctl(cam->fd, VIDIOC_DQBUF, &buf) < 0) {
            if (errno == EAGAIN) {
                continue;
            }
            fprintf(stderr, "[Error] VIDIOC_DQBUF failed: %s\n", strerror(errno));
            break;
        }

        // Prepare frame metadata
        memset(&frame, 0, sizeof(frame));
        frame.frame_number = cam->frame_counter++;
        clock_gettime(CLOCK_MONOTONIC, &frame.timestamp);
        frame.camera_id = cam->camera_id;
        frame.width = cam->width;
        frame.height = cam->height;

        // Process frame data
        void* buffer_start = cam->buffers[buf.index].start;
        size_t buffer_size = buf.bytesused;

        if (cam->pixel_format == V4L2_PIX_FMT_MJPEG) {
            // Already JPEG, copy directly
            frame.format = 0;  // JPEG
            frame.data_size = buffer_size;
            if (frame.data_size <= MAX_FRAME_SIZE) {
                memcpy(frame.data, buffer_start, frame.data_size);
            } else {
                fprintf(stderr, "[Warn] JPEG too large: %zu bytes\n", frame.data_size);
            }
        } else if (cam->pixel_format == V4L2_PIX_FMT_YUYV) {
            // Convert YUYV to JPEG
            frame.format = 0;  // JPEG
            if (encode_yuyv_to_jpeg((uint8_t*)buffer_start, cam->width, cam->height,
                                     frame.data, &frame.data_size,
                                     MAX_FRAME_SIZE) < 0) {
                fprintf(stderr, "[Error] JPEG encoding failed\n");
            }
        }

        // Write to shared memory
        if (shm_frame_buffer_write(g_shm, &frame) < 0) {
            fprintf(stderr, "[Error] Failed to write frame to shared memory\n");
        }

        // Requeue buffer
        if (ioctl(cam->fd, VIDIOC_QBUF, &buf) < 0) {
            fprintf(stderr, "[Error] VIDIOC_QBUF failed: %s\n", strerror(errno));
            break;
        }

        // Print status every 30 frames
        if (frame.frame_number % 30 == 0) {
            printf("[Info] Frame %lu captured (%zu bytes)\n",
                   frame.frame_number, frame.data_size);
        }
    }
}

// Stop streaming
static void camera_stop(camera_t* cam) {
    enum v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (ioctl(cam->fd, VIDIOC_STREAMOFF, &type) < 0) {
        fprintf(stderr, "[Error] VIDIOC_STREAMOFF failed: %s\n", strerror(errno));
    }
    printf("[Info] Streaming stopped\n");
}

// Cleanup
static void camera_cleanup(camera_t* cam) {
    for (int i = 0; i < cam->buffer_count; i++) {
        if (cam->buffers[i].start != MAP_FAILED) {
            munmap(cam->buffers[i].start, cam->buffers[i].length);
        }
    }
    if (cam->fd >= 0) {
        close(cam->fd);
    }
}

// Main
int main(int argc, char* argv[]) {
    const char* device = DEFAULT_DEVICE;
    int camera_id = 0;
    int width = DEFAULT_WIDTH;
    int height = DEFAULT_HEIGHT;
    int fps = DEFAULT_FPS;

    // Parse arguments
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-d") == 0 && i + 1 < argc) {
            device = argv[++i];
        } else if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) {
            camera_id = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-w") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-h") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-f") == 0 && i + 1 < argc) {
            fps = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--help") == 0) {
            printf("Usage: %s [options]\n", argv[0]);
            printf("Options:\n");
            printf("  -d <device>   Camera device (default: %s)\n", DEFAULT_DEVICE);
            printf("  -c <id>       Camera ID (default: 0)\n");
            printf("  -w <width>    Frame width (default: %d)\n", DEFAULT_WIDTH);
            printf("  -h <height>   Frame height (default: %d)\n", DEFAULT_HEIGHT);
            printf("  -f <fps>      Framerate (default: %d)\n", DEFAULT_FPS);
            return 0;
        }
    }

    // Setup signals
    setup_signals();

    // Create shared memory
    g_shm = shm_frame_buffer_create();
    if (!g_shm) {
        fprintf(stderr, "[Error] Failed to create shared memory\n");
        return 1;
    }

    // Initialize camera
    camera_t cam = {0};
    cam.camera_id = camera_id;
    cam.width = width;
    cam.height = height;
    cam.fps = fps;

    if (camera_open(&cam, device) < 0) {
        shm_frame_buffer_destroy(g_shm);
        return 1;
    }

    if (camera_set_format(&cam) < 0) {
        camera_cleanup(&cam);
        shm_frame_buffer_destroy(g_shm);
        return 1;
    }

    if (camera_init_mmap(&cam) < 0) {
        camera_cleanup(&cam);
        shm_frame_buffer_destroy(g_shm);
        return 1;
    }

    if (camera_start(&cam) < 0) {
        camera_cleanup(&cam);
        shm_frame_buffer_destroy(g_shm);
        return 1;
    }

    printf("[Info] Camera daemon started (Ctrl+C to stop)\n");

    // Capture loop
    camera_capture_loop(&cam);

    // Cleanup
    camera_stop(&cam);
    camera_cleanup(&cam);
    shm_frame_buffer_destroy(g_shm);

    printf("[Info] Camera daemon stopped\n");
    return 0;
}
