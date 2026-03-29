/**
 * shared_memory.h - Shared memory for inter-process communication
 *
 * SHM segments:
 *   h265_zc  — H.265 stream zero-copy (encoder → Go streaming)
 *   yolo_zc  — YOLO NV12 zero-copy (camera → Python detector)
 *   mjpeg_zc — MJPEG NV12 zero-copy (camera → Go web_monitor)
 *   detections — Detection results (Python → Go web_monitor)
 */

#ifndef SHARED_MEMORY_H
#define SHARED_MEMORY_H

#include <stdint.h>
#include <time.h>
#include <stdbool.h>
#include <semaphore.h>

#include "shm_constants.h"

// ============================================================================
// Zero-Copy Frame (NV12, shared via hb_mem share_id)
// Used by: yolo_zc, mjpeg_zc
// ============================================================================

typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width, height;
    float brightness_avg;
    int32_t share_id[ZEROCOPY_MAX_PLANES];
    uint64_t plane_size[ZEROCOPY_MAX_PLANES];
    int32_t plane_cnt;
    uint8_t hb_mem_buf_data[HB_MEM_GRAPHIC_BUF_SIZE];
    volatile uint32_t version;
} ZeroCopyFrame;

typedef struct {
    sem_t new_frame_sem;
    ZeroCopyFrame frame;
} ZeroCopyFrameBuffer;

ZeroCopyFrameBuffer* shm_zerocopy_create(const char* name);
ZeroCopyFrameBuffer* shm_zerocopy_open(const char* name);
void shm_zerocopy_close(ZeroCopyFrameBuffer* shm);
void shm_zerocopy_destroy(ZeroCopyFrameBuffer* shm, const char* name);
int shm_zerocopy_write(ZeroCopyFrameBuffer* shm, const ZeroCopyFrame* frame);

// ROI zero-copy shared memory (night camera pre-cropped 640x640 regions)
// Uses the same ZeroCopyFrameBuffer struct (sem_t + ZeroCopyFrame).
ZeroCopyFrameBuffer* shm_roi_zc_create(const char* shm_name);
int shm_roi_zc_write(ZeroCopyFrameBuffer* shm, const ZeroCopyFrame* frame);
ZeroCopyFrameBuffer* shm_roi_zc_open(const char* shm_name);
void shm_roi_zc_destroy(ZeroCopyFrameBuffer* shm, const char* shm_name);

// ============================================================================
// H.265 Zero-Copy (bitstream, shared via hb_mem share_id)
// Used by: h265_zc
// ============================================================================

#define HB_MEM_COM_BUF_SIZE 48 // sizeof(hb_mem_common_buf_t)

typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width, height;
    uint32_t data_size;
    uint8_t hb_mem_buf_data[HB_MEM_COM_BUF_SIZE]; // Full hb_mem_common_buf_t for import
    volatile uint32_t version;
} H265ZeroCopyFrame;

typedef struct {
    sem_t new_frame_sem;
    sem_t consumed_sem; // Initially 0: encoder skips until Go posts first consumed
    H265ZeroCopyFrame frame;
} H265ZeroCopyBuffer;

H265ZeroCopyBuffer* shm_h265_zc_create(const char* name);
H265ZeroCopyBuffer* shm_h265_zc_open(const char* name);
void shm_h265_zc_close(H265ZeroCopyBuffer* shm);
void shm_h265_zc_destroy(H265ZeroCopyBuffer* shm, const char* name);
int shm_h265_zc_write(H265ZeroCopyBuffer* shm, const H265ZeroCopyFrame* frame);

// ============================================================================
// Detection Results
// ============================================================================

#define MAX_DETECTIONS 10

typedef struct {
    int x, y, w, h;
} DetectionBBox;

typedef struct {
    char class_name[32];
    float confidence;
    DetectionBBox bbox;
} DetectionEntry;

typedef struct {
    uint64_t frame_number;
    double timestamp;
    int num_detections;
    DetectionEntry detections[MAX_DETECTIONS];
    volatile uint32_t version;
    sem_t detection_update_sem;
} LatestDetectionResult;

LatestDetectionResult* shm_detection_create(void);
LatestDetectionResult* shm_detection_open(void);
void shm_detection_close(LatestDetectionResult* shm);
void shm_detection_destroy(LatestDetectionResult* shm);
int shm_detection_write(LatestDetectionResult* shm, const DetectionEntry* detections, int count,
                        uint64_t frame_number, double timestamp);
uint32_t shm_detection_read(LatestDetectionResult* shm, DetectionEntry* out_detections,
                            int* out_count);

#endif // SHARED_MEMORY_H
