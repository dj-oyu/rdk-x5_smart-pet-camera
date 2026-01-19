/**
 * shared_memory.h - Shared memory structures for camera frame buffer
 *
 * This header defines the POSIX shared memory interface used for
 * inter-process communication between the camera capture daemon (C)
 * and the detection/monitoring processes (Python).
 *
 * Design principles:
 * - Ring buffer for lock-free read/write
 * - Atomic operations for write_index
 * - Compatible with Python ctypes/mmap
 */

#ifndef SHARED_MEMORY_H
#define SHARED_MEMORY_H

#include <stdint.h>
#include <time.h>
#include <stdbool.h>
#include <semaphore.h>

// Configuration constants
// Main shared memory (consumed by detection/monitoring/streaming)
#define SHM_NAME_ACTIVE_FRAME "/pet_camera_active_frame"  // NV12 frame from active camera (30fps)
#define SHM_NAME_STREAM "/pet_camera_stream"              // H.264 stream from active camera (30fps)
#define SHM_NAME_PROBE_FRAME "/pet_camera_probe_frame"    // NV12 frame for brightness probing (on-demand)
#define SHM_NAME_YOLO_INPUT "/pet_camera_yolo_input"      // 640x640 NV12 for YOLO (VSE Channel 1)
#define SHM_NAME_MJPEG_FRAME "/pet_camera_mjpeg_frame"    // 640x480 NV12 for MJPEG/web_monitor (VSE Channel 2)
#define SHM_NAME_DETECTIONS "/pet_camera_detections"      // YOLO detection results

// Legacy name for backward compatibility (keep API names stable)
#define SHM_NAME_FRAMES SHM_NAME_ACTIVE_FRAME

#define RING_BUFFER_SIZE 30  // 30 frames (1 second at 30fps)
#define MAX_DETECTIONS 10    // Maximum detections per frame
#define MAX_FRAME_SIZE (1920 * 1080 * 3 / 2)  // Max NV12 frame size (1080p)

/**
 * Brightness zone classification for low-light detection
 */
typedef enum {
    BRIGHTNESS_ZONE_DARK = 0,    // brightness_avg < 50 (needs correction)
    BRIGHTNESS_ZONE_DIM = 1,     // 50 <= brightness_avg < 70 (mild correction)
    BRIGHTNESS_ZONE_NORMAL = 2,  // 70 <= brightness_avg < 180
    BRIGHTNESS_ZONE_BRIGHT = 3,  // brightness_avg >= 180
} BrightnessZone;

/**
 * Frame structure - represents a single camera frame
 *
 * Layout:
 * - Metadata (frame_number, timestamp, camera_id)
 * - Brightness metrics (ISP statistics)
 * - Frame data (JPEG or raw YUV)
 */
typedef struct {
    uint64_t frame_number;      // Monotonic frame counter
    struct timespec timestamp;  // Capture timestamp (CLOCK_MONOTONIC)
    int camera_id;              // Camera index (0 or 1)
    int width;                  // Frame width in pixels
    int height;                 // Frame height in pixels
    int format;                 // 0=JPEG, 1=NV12, 2=RGB, 3=H264
    size_t data_size;           // Actual data size in bytes

    // Brightness metrics (Phase 0: ISP low-light enhancement)
    // Updated by camera daemon from ISP AE statistics
    float brightness_avg;       // Y-plane average brightness (0-255), from ISP AE stats
    uint32_t brightness_lux;    // Environment illuminance from ISP cur_lux
    uint8_t brightness_zone;    // BrightnessZone enum value
    uint8_t correction_applied; // 1 if ISP low-light correction is active
    uint8_t _reserved[2];       // Padding for alignment

    uint8_t data[MAX_FRAME_SIZE]; // Frame data
} Frame;

/**
 * Shared frame buffer - ring buffer for camera frames
 *
 * Thread-safety:
 * - Writer (camera daemon) atomically updates write_index
 * - Readers can use new_frame_sem for event-driven frame notification (sem_wait)
 * - Polling is still supported via write_index for backward compatibility
 * - frame_interval_ms can be updated by external process for dynamic FPS control
 */
typedef struct {
    volatile uint32_t write_index; // Atomic write pointer (wraps at RING_BUFFER_SIZE)
    volatile uint32_t frame_interval_ms; // Dynamic frame interval control (0 = 30fps, 500 = ~2fps)
    sem_t new_frame_sem; // Semaphore for new frame notification (posted on each write)
    Frame frames[RING_BUFFER_SIZE]; // Ring buffer of frames
} SharedFrameBuffer;

/**
 * Bounding box for object detection
 */
typedef struct {
    int x;      // Left-top X coordinate
    int y;      // Left-top Y coordinate
    int w;      // Width
    int h;      // Height
} BoundingBox;

/**
 * Detection result for a single object
 */
typedef struct {
    char class_name[32];    // "cat", "food_bowl", "water_bowl"
    float confidence;       // 0.0 ~ 1.0
    BoundingBox bbox;       // Bounding box
} Detection;

/**
 * Latest detection result - shared by detection process
 *
 * Only stores the most recent detection result to minimize memory usage.
 * Detection process updates this after each inference.
 */
typedef struct {
    uint64_t frame_number;          // Frame number this detection corresponds to
    struct timespec timestamp;      // Detection timestamp
    int num_detections;             // Number of valid detections (0 ~ MAX_DETECTIONS)
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;      // Incremented on each update (atomic)
    sem_t detection_update_sem;     // Semaphore for event-driven detection updates
} LatestDetectionResult;

/**
 * Initialize shared memory for frame buffer
 *
 * Creates and maps POSIX shared memory segment.
 * Should be called once by the camera daemon at startup.
 *
 * Returns:
 *   Pointer to mapped SharedFrameBuffer, or NULL on error
 */
SharedFrameBuffer* shm_frame_buffer_create(void);

/**
 * Open existing shared memory for frame buffer
 *
 * Opens and maps an existing shared memory segment.
 * Used by reader processes (detection, monitor).
 *
 * Returns:
 *   Pointer to mapped SharedFrameBuffer, or NULL on error
 */
SharedFrameBuffer* shm_frame_buffer_open(void);

/**
 * Close and unmap shared memory
 *
 * Unmaps the shared memory segment.
 * Does NOT delete the segment (use shm_frame_buffer_destroy for that).
 */
void shm_frame_buffer_close(SharedFrameBuffer* shm);

/**
 * Destroy shared memory segment
 *
 * Unmaps and deletes the shared memory segment.
 * Should be called by the camera daemon at shutdown.
 */
void shm_frame_buffer_destroy(SharedFrameBuffer* shm);

/**
 * Create shared memory with custom name (for probe)
 *
 * Creates a temporary shared memory segment with a custom name.
 * Useful for probe captures to avoid ring buffer conflicts.
 *
 * Returns:
 *   Pointer to mapped SharedFrameBuffer, or NULL on error
 */
SharedFrameBuffer* shm_frame_buffer_create_named(const char* name);

/**
 * Open shared memory with custom name (for probe)
 *
 * Opens an existing shared memory segment with a custom name.
 *
 * Returns:
 *   Pointer to mapped SharedFrameBuffer, or NULL on error
 */
SharedFrameBuffer* shm_frame_buffer_open_named(const char* name);

/**
 * Destroy shared memory with custom name (for probe)
 *
 * Unmaps and deletes a custom-named shared memory segment.
 */
void shm_frame_buffer_destroy_named(SharedFrameBuffer* shm, const char* name);

/**
 * Write a frame to the ring buffer (camera daemon only)
 *
 * Atomically increments write_index and copies frame data.
 * Lock-free operation.
 *
 * Args:
 *   shm: Shared memory pointer
 *   frame: Frame to write
 *
 * Returns:
 *   0 on success, -1 on error
 */
int shm_frame_buffer_write(SharedFrameBuffer* shm, const Frame* frame);

/**
 * Read the latest frame from ring buffer
 *
 * Non-blocking read of the most recently written frame.
 *
 * Args:
 *   shm: Shared memory pointer
 *   frame: Output buffer for frame data
 *
 * Returns:
 *   Frame index on success, -1 if no frames available
 */
int shm_frame_buffer_read_latest(SharedFrameBuffer* shm, Frame* frame);

/**
 * Get current write index (for polling)
 *
 * Returns the current write_index atomically.
 * Readers can use this to detect new frames.
 */
uint32_t shm_frame_buffer_get_write_index(SharedFrameBuffer* shm);

/**
 * Initialize shared memory for detection results
 */
LatestDetectionResult* shm_detection_create(void);

/**
 * Open existing shared memory for detection results
 */
LatestDetectionResult* shm_detection_open(void);

/**
 * Close detection shared memory
 */
void shm_detection_close(LatestDetectionResult* shm);

/**
 * Destroy detection shared memory
 */
void shm_detection_destroy(LatestDetectionResult* shm);

/**
 * Write detection results (detection process only)
 *
 * Atomically increments version and writes detection data.
 */
int shm_detection_write(LatestDetectionResult* shm,
                        uint64_t frame_number,
                        const Detection* detections,
                        int num_detections);

/**
 * Read detection results
 *
 * Returns the current version number.
 * Readers can compare version to detect updates.
 */
uint32_t shm_detection_read(LatestDetectionResult* shm,
                             Detection* detections,
                             int* num_detections);

#endif // SHARED_MEMORY_H
