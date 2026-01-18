package webmonitor

/*
#cgo CFLAGS: -I../../../capture
#cgo LDFLAGS: -lrt -lpthread -lturbojpeg

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <semaphore.h>
#include <errno.h>
#include <turbojpeg.h>

#define RING_BUFFER_SIZE 30
#define MAX_DETECTIONS 10
#define MAX_FRAME_SIZE (1920 * 1080 * 3 / 2)

typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width;
    int height;
    int format;
    size_t data_size;
    uint8_t data[MAX_FRAME_SIZE];
} Frame;

typedef struct {
    volatile uint32_t write_index;
    volatile uint32_t frame_interval_ms;
    sem_t new_frame_sem;  // Semaphore for new frame notifications
    Frame frames[RING_BUFFER_SIZE];
} SharedFrameBuffer;

typedef struct {
    int x;
    int y;
    int w;
    int h;
} BoundingBox;

typedef struct {
    char class_name[32];
    float confidence;
    BoundingBox bbox;
} Detection;

typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;
    sem_t detection_update_sem;  // Semaphore for event-driven detection updates
} LatestDetectionResult;

static SharedFrameBuffer* open_frame_shm(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) {
        return NULL;
    }

    SharedFrameBuffer* shm = (SharedFrameBuffer*)mmap(
        NULL,
        sizeof(SharedFrameBuffer),
        PROT_READ | PROT_WRITE,  // Need write permission for sem_wait()
        MAP_SHARED,
        fd,
        0
    );

    close(fd);

    if (shm == MAP_FAILED) {
        return NULL;
    }

    return shm;
}

static void close_frame_shm(SharedFrameBuffer* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(SharedFrameBuffer));
    }
}

static uint32_t frame_write_index(SharedFrameBuffer* shm) {
    if (shm == NULL) {
        return 0;
    }
    return __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
}

static int read_latest_frame(SharedFrameBuffer* shm, Frame* out) {
    if (!shm || !out) {
        return -1;
    }

    uint32_t write_idx = __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
    if (write_idx == 0) {
        return -1;
    }

    uint32_t latest_idx = (write_idx - 1) % RING_BUFFER_SIZE;
    Frame* src = &shm->frames[latest_idx];

    // Copy metadata first
    out->frame_number = src->frame_number;
    out->timestamp = src->timestamp;
    out->camera_id = src->camera_id;
    out->width = src->width;
    out->height = src->height;
    out->format = src->format;
    out->data_size = src->data_size;

    // Only copy actual data
    if (out->data_size > 0 && out->data_size <= MAX_FRAME_SIZE) {
        memcpy(out->data, src->data, out->data_size);
    }

    return 0;
}

// Zero-copy version: returns pointer to frame data in shared memory (read-only)
static Frame* get_latest_frame_ptr(SharedFrameBuffer* shm) {
    if (!shm) {
        return NULL;
    }

    uint32_t write_idx = __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
    if (write_idx == 0) {
        return NULL;
    }

    uint32_t latest_idx = (write_idx - 1) % RING_BUFFER_SIZE;
    return &shm->frames[latest_idx];
}

static LatestDetectionResult* open_detection_shm(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) {
        // fprintf(stderr, "Failed to shm_open detection: %s\n", name);
        return NULL;
    }

    LatestDetectionResult* shm = (LatestDetectionResult*)mmap(
        NULL,
        sizeof(LatestDetectionResult),
        PROT_READ | PROT_WRITE,  // Need write permission for sem_wait()
        MAP_SHARED,
        fd,
        0
    );

    close(fd);

    if (shm == MAP_FAILED) {
        // fprintf(stderr, "Failed to mmap detection shm\n");
        return NULL;
    }

    return shm;
}

static void close_detection_shm(LatestDetectionResult* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(LatestDetectionResult));
    }
}

static uint32_t detection_version(LatestDetectionResult* shm) {
    if (shm == NULL) {
        return 0;
    }
    return __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
}

static int read_detection_snapshot(LatestDetectionResult* shm, LatestDetectionResult* out) {
    if (!shm || !out) {
        return -1;
    }
    memcpy(out, shm, sizeof(LatestDetectionResult));
    return 0;
}

static int wait_new_frame(SharedFrameBuffer* shm) {
    if (shm == NULL) {
        return -1;
    }

    // Use sem_timedwait with 1 second timeout to allow checking stop signal
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 1;  // 1 second timeout

    int ret = sem_timedwait(&shm->new_frame_sem, &ts);
    if (ret == -1 && errno == ETIMEDOUT) {
        return -2;  // Timeout (not an error, just no new frame)
    }
    return ret;
}

static int wait_new_detection(LatestDetectionResult* shm) {
    if (shm == NULL) {
        return -1;
    }

    // Use sem_timedwait with 1 second timeout to allow checking stop signal
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 1;  // 1 second timeout

    int ret = sem_timedwait(&shm->detection_update_sem, &ts);
    if (ret == -1) {
        if (errno == ETIMEDOUT) {
            return -2;  // Timeout (not an error, just no new detection)
        } else if (errno == EINTR) {
            return -3;  // Interrupted by signal
        } else {
            fprintf(stderr, "[SEM_DEBUG] sem_timedwait error: errno=%d (%s)\n", errno, strerror(errno));
            return -1;  // Other error
        }
    }
    return 0;  // Success
}

// 5x7 Bitmap Font - expanded with all necessary characters
static const uint8_t font5x7[][5] = {
    {0x3E, 0x51, 0x49, 0x45, 0x3E}, // '0' = 0
    {0x00, 0x42, 0x7F, 0x40, 0x00}, // '1' = 1
    {0x42, 0x61, 0x51, 0x49, 0x46}, // '2' = 2
    {0x21, 0x41, 0x45, 0x4B, 0x31}, // '3' = 3
    {0x18, 0x14, 0x12, 0x7F, 0x10}, // '4' = 4
    {0x27, 0x45, 0x45, 0x45, 0x39}, // '5' = 5
    {0x3C, 0x4A, 0x49, 0x49, 0x30}, // '6' = 6
    {0x01, 0x71, 0x09, 0x05, 0x03}, // '7' = 7
    {0x36, 0x49, 0x49, 0x49, 0x36}, // '8' = 8
    {0x06, 0x49, 0x49, 0x29, 0x1E}, // '9' = 9
    {0x00, 0x36, 0x36, 0x00, 0x00}, // ':' = 10
    {0x08, 0x08, 0x08, 0x08, 0x08}, // '-' = 11
    {0x00, 0x60, 0x60, 0x00, 0x00}, // '.' = 12
    {0x20, 0x10, 0x08, 0x04, 0x02}, // '/' = 13
    {0x00, 0x00, 0x00, 0x00, 0x00}, // ' ' = 14
    {0x7E, 0x11, 0x11, 0x11, 0x7E}, // 'A' = 15
    {0x7F, 0x49, 0x49, 0x49, 0x36}, // 'B' = 16
    {0x3E, 0x41, 0x41, 0x41, 0x22}, // 'C' = 17
    {0x7F, 0x41, 0x41, 0x22, 0x1C}, // 'D' = 18
    {0x7F, 0x49, 0x49, 0x49, 0x41}, // 'E' = 19
    {0x7F, 0x09, 0x09, 0x09, 0x01}, // 'F' = 20
    {0x3E, 0x41, 0x49, 0x49, 0x7A}, // 'G' = 21
    {0x7F, 0x08, 0x08, 0x08, 0x7F}, // 'H' = 22
    {0x00, 0x41, 0x7F, 0x41, 0x00}, // 'I' = 23
    {0x7F, 0x02, 0x0C, 0x02, 0x7F}, // 'M' = 24
    {0x7F, 0x04, 0x08, 0x10, 0x7F}, // 'N' = 25
    {0x3E, 0x41, 0x41, 0x41, 0x3E}, // 'O' = 26
    {0x01, 0x01, 0x7F, 0x01, 0x01}, // 'T' = 27
    {0x20, 0x54, 0x54, 0x54, 0x78}, // 'a' = 28
    {0x7F, 0x48, 0x44, 0x44, 0x38}, // 'b' = 29
    {0x38, 0x44, 0x44, 0x44, 0x20}, // 'c' = 30
    {0x38, 0x44, 0x44, 0x48, 0x7F}, // 'd' = 31
    {0x38, 0x54, 0x54, 0x54, 0x18}, // 'e' = 32
    {0x00, 0x44, 0x7D, 0x40, 0x00}, // 'i' = 33
    {0x7C, 0x04, 0x18, 0x04, 0x78}, // 'm' = 34
    {0x7C, 0x08, 0x04, 0x04, 0x78}, // 'n' = 35
    {0x38, 0x44, 0x44, 0x44, 0x38}, // 'o' = 36
    {0x7C, 0x14, 0x14, 0x14, 0x08}, // 'p' = 37
    {0x7C, 0x08, 0x04, 0x04, 0x08}, // 'r' = 38
    {0x48, 0x54, 0x54, 0x54, 0x20}, // 's' = 39
    {0x04, 0x3F, 0x44, 0x40, 0x20}, // 't' = 40
};

// Map character to font index
static int get_font_index(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c == ':') return 10;
    if (c == '-') return 11;
    if (c == '.') return 12;
    if (c == '/') return 13;
    if (c == ' ') return 14;
    if (c >= 'A' && c <= 'I') return 15 + (c - 'A');
    if (c == 'M') return 24;
    if (c == 'N') return 25;
    if (c == 'O') return 26;
    if (c == 'T') return 27;
    if (c >= 'a' && c <= 'e') return 28 + (c - 'a');
    if (c == 'i') return 33;
    if (c == 'm') return 34;
    if (c == 'n') return 35;
    if (c == 'o') return 36;
    if (c == 'p') return 37;
    if (c == 'r') return 38;
    if (c == 's') return 39;
    if (c == 't') return 40;
    return 14; // space
}

// Draw filled rectangle on NV12 frame (for text background)
static void draw_filled_rect_nv12(uint8_t* nv12, int width, int height,
                                  int x, int y, int w, int h, uint8_t y_color) {
    uint8_t* y_plane = nv12;

    // Clamp coordinates
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    if (w <= 0 || h <= 0) return;

    // Fill rectangle row by row (cache-friendly)
    for (int py = y; py < y + h; py++) {
        if (py < 0 || py >= height) continue;
        uint8_t* row_ptr = y_plane + py * width;
        for (int px = x; px < x + w; px++) {
            if (px >= 0 && px < width) {
                row_ptr[px] = y_color;
            }
        }
    }
}

// Draw text on NV12 frame (Y plane only)
// Cache-friendly: outer loop is y-direction, inner loop is x-direction for sequential memory access
static void draw_text_nv12(uint8_t* nv12, int width, int height,
                          int x, int y, const char* text, uint8_t y_color, int scale) {
    uint8_t* y_plane = nv12;

    // Calculate text bounds
    int text_len = 0;
    while (text[text_len] != '\0') text_len++;
    int text_width = text_len * 6 * scale;
    int text_height = 7 * scale;

    // Clamp to frame bounds
    int start_y = y < 0 ? 0 : y;
    int end_y = (y + text_height) > height ? height : (y + text_height);

    // Outer loop: y-direction (rows)
    for (int py = start_y; py < end_y; py++) {
        int local_y = py - y;
        int row = local_y / scale;
        int sy = local_y % scale;

        if (row < 0 || row >= 7) continue;

        uint8_t* row_ptr = y_plane + py * width;
        int cur_x = x;

        // Inner loop: x-direction (columns) - sequential memory access
        for (int i = 0; i < text_len; i++) {
            int font_idx = get_font_index(text[i]);
            if (font_idx < 0) {
                cur_x += 6 * scale;
                continue;
            }

            const uint8_t* bitmap = font5x7[font_idx];
            for (int col = 0; col < 5; col++) {
                uint8_t byte = bitmap[col];
                if ((byte >> row) & 1) {
                    for (int sx = 0; sx < scale; sx++) {
                        int px = cur_x + col * scale + sx;
                        if (px >= 0 && px < width) {
                            row_ptr[px] = y_color;
                        }
                    }
                }
            }
            cur_x += 6 * scale;
        }
    }
}

// Draw a colored rectangle on NV12 frame (Y and UV planes for true color)
// Cache-friendly: outer loop is y-direction, inner loop is x-direction for sequential memory access
static void draw_rect_nv12_color(uint8_t* nv12, int width, int height,
                                 int x, int y, int w, int h,
                                 uint8_t y_val, uint8_t u_val, uint8_t v_val, int thickness) {
    uint8_t* y_plane = nv12;
    int y_size = width * height;
    uint8_t* uv_plane = nv12 + y_size;

    // Clamp coordinates
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    if (w <= 0 || h <= 0) return;

    // Clamp thickness
    int eff_thickness = thickness;
    if (eff_thickness > h / 2) eff_thickness = h / 2;
    if (eff_thickness > w / 2) eff_thickness = w / 2;
    if (eff_thickness <= 0) eff_thickness = 1;

    // Draw Y plane (luminance)
    for (int py = y; py < y + h; py++) {
        if (py < 0 || py >= height) continue;

        uint8_t* y_row_ptr = y_plane + py * width;
        int local_y = py - y;

        int is_top_edge = (local_y < eff_thickness);
        int is_bottom_edge = (local_y >= h - eff_thickness);

        if (is_top_edge || is_bottom_edge) {
            for (int px = x; px < x + w; px++) {
                if (px >= 0 && px < width) {
                    y_row_ptr[px] = y_val;
                }
            }
        } else {
            for (int t = 0; t < eff_thickness; t++) {
                int px = x + t;
                if (px >= 0 && px < width) {
                    y_row_ptr[px] = y_val;
                }
            }
            for (int t = 0; t < eff_thickness; t++) {
                int px = x + w - 1 - t;
                if (px >= 0 && px < width) {
                    y_row_ptr[px] = y_val;
                }
            }
        }
    }

    // Draw UV plane (chrominance) - NV12 format: U and V are interleaved
    // UV plane is half resolution (2x2 pixels share same UV)
    int uv_y_start = y / 2;
    int uv_y_end = (y + h + 1) / 2;
    int uv_x_start = x / 2;
    int uv_x_end = (x + w + 1) / 2;
    int uv_thickness = (eff_thickness + 1) / 2;

    for (int uv_y = uv_y_start; uv_y < uv_y_end; uv_y++) {
        if (uv_y < 0 || uv_y >= height / 2) continue;

        uint8_t* uv_row_ptr = uv_plane + uv_y * width;
        int local_uv_y = uv_y - uv_y_start;
        int uv_h = uv_y_end - uv_y_start;

        int is_top_edge = (local_uv_y < uv_thickness);
        int is_bottom_edge = (local_uv_y >= uv_h - uv_thickness);

        if (is_top_edge || is_bottom_edge) {
            for (int uv_x = uv_x_start; uv_x < uv_x_end; uv_x++) {
                if (uv_x >= 0 && uv_x < width / 2) {
                    uv_row_ptr[uv_x * 2] = u_val;
                    uv_row_ptr[uv_x * 2 + 1] = v_val;
                }
            }
        } else {
            for (int t = 0; t < uv_thickness; t++) {
                int uv_x = uv_x_start + t;
                if (uv_x >= 0 && uv_x < width / 2) {
                    uv_row_ptr[uv_x * 2] = u_val;
                    uv_row_ptr[uv_x * 2 + 1] = v_val;
                }
            }
            for (int t = 0; t < uv_thickness; t++) {
                int uv_x = uv_x_end - 1 - t;
                if (uv_x >= 0 && uv_x < width / 2) {
                    uv_row_ptr[uv_x * 2] = u_val;
                    uv_row_ptr[uv_x * 2 + 1] = v_val;
                }
            }
        }
    }
}

// Draw a rectangle on NV12 frame (Y plane only for simplicity)
// Cache-friendly: outer loop is y-direction, inner loop is x-direction for sequential memory access
// Color: Y value (0=black, 255=white, ~76=green, ~150=yellow, ~29=blue, ~225=red)
static void draw_rect_nv12(uint8_t* nv12, int width, int height,
                           int x, int y, int w, int h, uint8_t y_color, int thickness) {
    uint8_t* y_plane = nv12;

    // Clamp coordinates
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    if (w <= 0 || h <= 0) return;

    // Clamp thickness
    int eff_thickness = thickness;
    if (eff_thickness > h / 2) eff_thickness = h / 2;
    if (eff_thickness > w / 2) eff_thickness = w / 2;
    if (eff_thickness <= 0) eff_thickness = 1;

    // Outer loop: y-direction (rows)
    for (int py = y; py < y + h; py++) {
        if (py < 0 || py >= height) continue;

        uint8_t* row_ptr = y_plane + py * width;
        int local_y = py - y;

        // Determine if this row is part of top/bottom edge
        int is_top_edge = (local_y < eff_thickness);
        int is_bottom_edge = (local_y >= h - eff_thickness);

        if (is_top_edge || is_bottom_edge) {
            // Fill entire width for top/bottom edges (horizontal lines)
            for (int px = x; px < x + w; px++) {
                if (px >= 0 && px < width) {
                    row_ptr[px] = y_color;
                }
            }
        } else {
            // Fill only left and right edges (vertical lines)
            // Left edge
            for (int t = 0; t < eff_thickness; t++) {
                int px = x + t;
                if (px >= 0 && px < width) {
                    row_ptr[px] = y_color;
                }
            }
            // Right edge
            for (int t = 0; t < eff_thickness; t++) {
                int px = x + w - 1 - t;
                if (px >= 0 && px < width) {
                    row_ptr[px] = y_color;
                }
            }
        }
    }
}

// NV12 to RGBA conversion (fallback, not used with TurboJPEG optimization)
// Cache-friendly: processes row by row with sequential memory access
static void nv12_to_rgba(const uint8_t* nv12, int width, int height, uint8_t* rgba) {
    int y_size = width * height;
    const uint8_t* y_plane = nv12;
    const uint8_t* uv_plane = nv12 + y_size;

    // Outer loop: y-direction (rows)
    for (int y = 0; y < height; y++) {
        const uint8_t* y_row = y_plane + y * width;
        const uint8_t* uv_row = uv_plane + (y / 2) * width;
        uint8_t* rgba_row = rgba + y * width * 4;

        // Inner loop: x-direction (columns) - sequential memory access
        for (int x = 0; x < width; x++) {
            int y_val = y_row[x];
            int uv_index = (x / 2) * 2;
            int u_val = uv_row[uv_index];
            int v_val = uv_row[uv_index + 1];

            int c = y_val - 16;
            int d = u_val - 128;
            int e = v_val - 128;

            int r = (298 * c + 409 * e + 128) >> 8;
            int g = (298 * c - 100 * d - 208 * e + 128) >> 8;
            int b = (298 * c + 516 * d + 128) >> 8;

            r = r < 0 ? 0 : (r > 255 ? 255 : r);
            g = g < 0 ? 0 : (g > 255 ? 255 : g);
            b = b < 0 ? 0 : (b > 255 ? 255 : b);

            int rgba_index = x * 4;
            rgba_row[rgba_index] = (uint8_t)r;
            rgba_row[rgba_index + 1] = (uint8_t)g;
            rgba_row[rgba_index + 2] = (uint8_t)b;
            rgba_row[rgba_index + 3] = 255;
        }
    }
}

// NV12 to JPEG using TurboJPEG (optimized, avoids RGBA conversion)
// Returns allocated JPEG buffer and size (caller must free)
static int nv12_to_jpeg_turbo(const uint8_t* nv12, int width, int height, uint8_t** jpeg_out, unsigned long* jpeg_size) {
    tjhandle tj = tjInitCompress();
    if (!tj) {
        return -1;
    }

    int y_size = width * height;
    const uint8_t* y_plane = nv12;
    const uint8_t* uv_plane = nv12 + y_size;

    // Prepare plane pointers and strides for NV12
    const uint8_t* planes[3] = {y_plane, uv_plane, NULL};
    int strides[3] = {width, width, 0};  // NV12: Y stride = width, UV stride = width (interleaved U/V)

    unsigned char* jpeg_buf = NULL;
    unsigned long size = 0;

    // Compress NV12 directly to JPEG (TJ_YUV420 with interleaved UV)
    // Note: TurboJPEG doesn't have direct NV12 support, but we can use YUV420 planar
    // For NV12, we need to deinterlace UV first (or use RGB path)
    // Actually, let's use a simpler approach: convert to RGB via TurboJPEG's YUV decoder

    // Alternative: Use tjCompressFromYUVPlanes with proper format
    // TurboJPEG supports TJSAMP_420 which matches NV12 subsampling
    int result = tjCompressFromYUVPlanes(
        tj,
        planes,
        width,
        strides,
        height,
        TJSAMP_420,  // 4:2:0 subsampling (matches NV12)
        &jpeg_buf,
        &size,
        85,  // Quality
        TJFLAG_FASTDCT | TJFLAG_NOREALLOC
    );

    if (result != 0) {
        tjDestroy(tj);
        return -1;
    }

    *jpeg_out = jpeg_buf;
    *jpeg_size = size;
    tjDestroy(tj);
    return 0;
}
*/
import "C"

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	time "time"
	"unsafe"
)

const (
	formatJPEG   = 0
	formatNV12   = 1
	maxFrameSize = 1920 * 1080 * 3 / 2
)

type frameSnapshot struct {
	FrameNumber uint64
	Timestamp   time.Time
	CameraID    int
	Width       int
	Height      int
	Format      int
	Data        []byte
}

type shmReader struct {
	frameShm      *C.SharedFrameBuffer
	detectionShm  *C.LatestDetectionResult
	detectionName string
	lastDetVer    uint32
}

func newSHMReader(frameName, detectionName string) (*shmReader, error) {
	var frame *C.SharedFrameBuffer
	if frameName != "" {
		cName := C.CString(frameName)
		frame = C.open_frame_shm(cName)
		C.free(unsafe.Pointer(cName))
	}

	r := &shmReader{
		frameShm:      frame,
		detectionName: detectionName,
	}

	r.tryOpenDetection()

	if frame == nil && r.detectionShm == nil {
		return nil, fmt.Errorf("shared memory not available")
	}

	return r, nil
}

func (r *shmReader) tryOpenDetection() {
	if r.detectionShm != nil || r.detectionName == "" {
		return
	}
	cName := C.CString(r.detectionName)
	r.detectionShm = C.open_detection_shm(cName)
	C.free(unsafe.Pointer(cName))
	if r.detectionShm != nil {
		// fmt.Printf("Connected to detection SHM: %s\n", r.detectionName)
	}
}

func (r *shmReader) Close() {
	if r.frameShm != nil {
		C.close_frame_shm(r.frameShm)
		r.frameShm = nil
	}
	if r.detectionShm != nil {
		C.close_detection_shm(r.detectionShm)
		r.detectionShm = nil
	}
}

// WaitNewFrame blocks until a new frame is available (via semaphore).
// Returns error if interrupted or failed. Returns nil if timeout (no new frame yet).
func (r *shmReader) WaitNewFrame() error {
	if r.frameShm == nil {
		return fmt.Errorf("frame shared memory not available")
	}
	ret := C.wait_new_frame(r.frameShm)
	if ret == -2 {
		// Timeout - not an error, just no new frame within timeout period
		return nil
	}
	if ret != 0 {
		return fmt.Errorf("sem_wait failed")
	}
	return nil
}

// WaitNewDetection blocks until a new detection is available (via semaphore).
// Returns error if interrupted or failed. Returns nil if timeout (no new detection yet).
func (r *shmReader) WaitNewDetection() error {
	// Try to open detection shared memory if not already open
	if r.detectionShm == nil {
		r.tryOpenDetection()
	}

	// Check again after trying to open
	if r.detectionShm == nil {
		return fmt.Errorf("detection shared memory not available")
	}

	// Verify detection version is non-zero (indicates daemon has written at least once)
	version := uint32(C.detection_version(r.detectionShm))
	if version == 0 {
		// Detection daemon hasn't written anything yet, don't try semaphore
		return fmt.Errorf("detection daemon not initialized (version=0)")
	}

	ret := C.wait_new_detection(r.detectionShm)
	if ret == -2 {
		// Timeout - not an error, just no new detection within timeout period
		return nil
	}
	if ret == -3 {
		// Interrupted by signal - not an error, just retry
		return nil
	}
	if ret != 0 {
		return fmt.Errorf("sem_wait failed (ret=%d)", ret)
	}
	return nil
}

func (r *shmReader) Stats() (SharedMemoryStats, bool) {
	if r.frameShm == nil {
		return SharedMemoryStats{}, false
	}

	if r.detectionShm == nil {
		r.tryOpenDetection()
	}

	writeIndex := uint32(C.frame_write_index(r.frameShm))
	frameCount := min(int(writeIndex), 30)

	detVer := uint32(0)
	if r.detectionShm != nil {
		detVer = uint32(C.detection_version(r.detectionShm))
	}

	return SharedMemoryStats{
		FrameCount:         frameCount,
		TotalFramesWritten: int(writeIndex),
		DetectionVersion:   int(detVer),
		HasDetection:       boolToInt(detVer > 0),
	}, true
}

func (r *shmReader) LatestFrame() (*frameSnapshot, bool) {
	if r.frameShm == nil {
		return nil, false
	}

	var cFrame C.Frame
	if C.read_latest_frame(r.frameShm, &cFrame) != 0 {
		return nil, false
	}

	dataSize := int(cFrame.data_size)
	if dataSize < 0 || dataSize > maxFrameSize {
		return nil, false
	}

	// Copy data to avoid holding C memory reference
	data := make([]byte, dataSize)
	cData := (*[maxFrameSize]byte)(unsafe.Pointer(&cFrame.data[0]))[:dataSize:dataSize]
	copy(data, cData)

	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &frameSnapshot{
		FrameNumber: uint64(cFrame.frame_number),
		Timestamp:   timestamp,
		CameraID:    int(cFrame.camera_id),
		Width:       int(cFrame.width),
		Height:      int(cFrame.height),
		Format:      int(cFrame.format),
		Data:        data,
	}, true
}

// LatestFrameZeroCopy returns the latest frame with zero-copy optimization
// WARNING: The returned data points to shared memory. Caller MUST copy if modifying.
func (r *shmReader) LatestFrameZeroCopy() (*frameSnapshot, bool) {
	if r.frameShm == nil {
		return nil, false
	}

	// True zero-copy: Get pointer to frame in shared memory (no memcpy in C!)
	cFramePtr := C.get_latest_frame_ptr(r.frameShm)
	if cFramePtr == nil {
		return nil, false
	}

	dataSize := int(cFramePtr.data_size)
	if dataSize < 0 || dataSize > maxFrameSize {
		return nil, false
	}

	// Zero-copy: Direct reference to shared memory (read-only!)
	cData := (*[maxFrameSize]byte)(unsafe.Pointer(&cFramePtr.data[0]))[:dataSize:dataSize]

	timestamp := time.Unix(
		int64(cFramePtr.timestamp.tv_sec),
		int64(cFramePtr.timestamp.tv_nsec),
	)

	return &frameSnapshot{
		FrameNumber: uint64(cFramePtr.frame_number),
		Timestamp:   timestamp,
		CameraID:    int(cFramePtr.camera_id),
		Width:       int(cFramePtr.width),
		Height:      int(cFramePtr.height),
		Format:      int(cFramePtr.format),
		Data:        cData,  // Zero-copy reference to shared memory
	}, true
}

func (r *shmReader) LatestDetection() (*DetectionResult, bool) {
	if r.detectionShm == nil {
		r.tryOpenDetection()
	}

	if r.detectionShm == nil {
		return nil, false
	}

	var snapshot C.LatestDetectionResult
	if C.read_detection_snapshot(r.detectionShm, &snapshot) != 0 {
		return nil, false
	}

	version := uint32(snapshot.version)

	if version == 0 || version == r.lastDetVer {
		return nil, false
	}

	r.lastDetVer = version

	result := DetectionResult{
		FrameNumber: int(snapshot.frame_number),
		Timestamp: float64(snapshot.timestamp.tv_sec) +
			float64(snapshot.timestamp.tv_nsec)/1e9,
		NumDetections: int(snapshot.num_detections),
		Version:       int(version),
	}

	if result.NumDetections > 0 {
		result.Detections = make([]Detection, 0, result.NumDetections)
		for i := 0; i < result.NumDetections && i < int(C.MAX_DETECTIONS); i++ {
			det := snapshot.detections[i]
			classBytes := C.GoBytes(unsafe.Pointer(&det.class_name[0]), 32)
			className := string(bytes.TrimRight(classBytes, "\x00"))
			result.Detections = append(result.Detections, Detection{
				ClassName:  className,
				Confidence: float64(det.confidence),
				BBox: BoundingBox{
					X: int(det.bbox.x),
					Y: int(det.bbox.y),
					W: int(det.bbox.w),
					H: int(det.bbox.h),
				},
			})
		}
	}

	return &result, true
}

func (r *shmReader) LatestJPEG() ([]byte, bool) {
	frame, ok := r.LatestFrame()
	if !ok {
		return nil, false
	}

	// If already JPEG, return as-is
	if frame.Format == formatJPEG && len(frame.Data) > 0 {
		return frame.Data, true
	}

	// If NV12, convert to JPEG
	if frame.Format == formatNV12 && len(frame.Data) > 0 {
		jpegData, err := nv12ToJPEG(frame.Data, frame.Width, frame.Height)
		if err != nil {
			return nil, false
		}
		return jpegData, true
	}

	return nil, false
}

// nv12ToJPEG converts NV12 format to JPEG
func nv12ToJPEG(nv12Data []byte, width, height int) ([]byte, error) {
	// Convert NV12 to RGBA in C
	img := nv12ToRGBAImg(nv12Data, width, height)

	// Encode to JPEG
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

// nv12ToRGBAImg converts NV12 format to RGBA image using C
func nv12ToRGBAImg(nv12Data []byte, width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	C.nv12_to_rgba(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		(*C.uint8_t)(unsafe.Pointer(&img.Pix[0])),
	)
	return img
}

// drawRectOnNV12 draws a rectangle on NV12 frame data (in-place modification)
func drawRectOnNV12(nv12Data []byte, width, height, x, y, w, h int, yColor uint8, thickness int) {
	if len(nv12Data) < width*height*3/2 {
		return
	}
	C.draw_rect_nv12(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		C.int(x),
		C.int(y),
		C.int(w),
		C.int(h),
		C.uint8_t(yColor),
		C.int(thickness),
	)
}

// drawRectColorNV12 draws a colored rectangle on NV12 frame (Y and UV planes)
func drawRectColorNV12(nv12Data []byte, width, height, x, y, w, h int, yVal, uVal, vVal uint8, thickness int) {
	if len(nv12Data) < width*height*3/2 {
		return
	}
	C.draw_rect_nv12_color(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		C.int(x),
		C.int(y),
		C.int(w),
		C.int(h),
		C.uint8_t(yVal),
		C.uint8_t(uVal),
		C.uint8_t(vVal),
		C.int(thickness),
	)
}

// drawTextOnNV12 draws text on NV12 frame data (in-place modification)
func drawTextOnNV12(nv12Data []byte, width, height, x, y int, text string, yColor uint8, scale int) {
	if len(nv12Data) < width*height*3/2 {
		return
	}
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))

	C.draw_text_nv12(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		C.int(x),
		C.int(y),
		cText,
		C.uint8_t(yColor),
		C.int(scale),
	)
}

// drawTextWithBackgroundNV12 draws text with a background rectangle
func drawTextWithBackgroundNV12(nv12Data []byte, width, height, x, y int, text string, textColor, bgColor uint8, scale int) {
	if len(nv12Data) < width*height*3/2 {
		return
	}

	// Calculate text dimensions
	textWidth := len(text) * 6 * scale
	textHeight := 7 * scale
	padding := 4

	// Draw background rectangle
	C.draw_filled_rect_nv12(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		C.int(x-padding),
		C.int(y-padding),
		C.int(textWidth+padding*2),
		C.int(textHeight+padding*2),
		C.uint8_t(bgColor),
	)

	// Draw text on top
	drawTextOnNV12(nv12Data, width, height, x, y, text, textColor, scale)
}