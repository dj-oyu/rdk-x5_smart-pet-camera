/**
 * shared_memory.c - POSIX shared memory implementation
 *
 * Zero-copy SHM for inter-process frame sharing + detection results.
 */

#include "shared_memory.h"
#include "logger.h"

#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

// ============================================================================
// Internal helpers
// ============================================================================

static void* shm_create_or_open_ex(const char* name, size_t size, bool create, bool* created_new) {
    const int flags = create ? (O_CREAT | O_RDWR) : O_RDWR;
    int fd = shm_open(name, flags, 0666);
    if (fd == -1) {
        if (create)
            LOG_ERROR("SharedMemory", "shm_open failed for %s: %s", name, strerror(errno));
        return NULL;
    }
    if (create && ftruncate(fd, size) == -1) {
        LOG_ERROR("SharedMemory", "ftruncate failed for %s: %s", name, strerror(errno));
        close(fd);
        return NULL;
    }
    void* ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (ptr == MAP_FAILED)
        return NULL;
    if (created_new)
        *created_new = create;
    return ptr;
}

static void* shm_create_or_open(const char* name, size_t size, bool create) {
    return shm_create_or_open_ex(name, size, create, NULL);
}

// ============================================================================
// Detection Results
// ============================================================================

LatestDetectionResult* shm_detection_create(void) {
    bool created_new = false;
    LatestDetectionResult* shm = (LatestDetectionResult*)shm_create_or_open_ex(
        SHM_NAME_DETECTIONS, sizeof(LatestDetectionResult), true, &created_new);
    if (shm && created_new) {
        memset(shm, 0, sizeof(LatestDetectionResult));
        sem_init(&shm->detection_update_sem, 1, 0);
        LOG_INFO("SharedMemory", "Detection SHM created: %s (%zu bytes)", SHM_NAME_DETECTIONS,
                 sizeof(LatestDetectionResult));
    }
    return shm;
}

LatestDetectionResult* shm_detection_open(void) {
    return (LatestDetectionResult*)shm_create_or_open(SHM_NAME_DETECTIONS,
                                                      sizeof(LatestDetectionResult), false);
}

void shm_detection_close(LatestDetectionResult* shm) {
    if (shm)
        munmap(shm, sizeof(LatestDetectionResult));
}

void shm_detection_destroy(LatestDetectionResult* shm) {
    if (shm) {
        sem_destroy(&shm->detection_update_sem);
        munmap(shm, sizeof(LatestDetectionResult));
        shm_unlink(SHM_NAME_DETECTIONS);
    }
}

int shm_detection_write(LatestDetectionResult* shm, const DetectionEntry* detections, int count,
                        uint64_t frame_number, double timestamp) {
    if (!shm || !detections || count < 0)
        return -1;
    if (count > MAX_DETECTIONS)
        count = MAX_DETECTIONS;
    shm->frame_number = frame_number;
    shm->timestamp = timestamp;
    shm->num_detections = count;
    memcpy(shm->detections, detections, count * sizeof(DetectionEntry));
    __atomic_fetch_add(&shm->version, 1, __ATOMIC_RELEASE);
    sem_post(&shm->detection_update_sem);
    return 0;
}

uint32_t shm_detection_read(const LatestDetectionResult* shm, DetectionEntry* out_detections,
                            int* out_count) {
    if (!shm || !out_detections || !out_count)
        return 0;
    const uint32_t version = __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
    int count = shm->num_detections;
    if (count > MAX_DETECTIONS)
        count = MAX_DETECTIONS;
    memcpy(out_detections, shm->detections, count * sizeof(DetectionEntry));
    *out_count = count;
    return version;
}

// ============================================================================
// Zero-Copy Frame (NV12, for YOLO + MJPEG)
// ============================================================================

ZeroCopyFrameBuffer* shm_zerocopy_create(const char* name) {
    bool created_new = false;
    ZeroCopyFrameBuffer* shm = (ZeroCopyFrameBuffer*)shm_create_or_open_ex(
        name, sizeof(ZeroCopyFrameBuffer), true, &created_new);
    if (shm && created_new) {
        sem_init(&shm->new_frame_sem, 1, 0);
        shm->frame.version = 0;
        LOG_INFO("SharedMemory", "Zero-copy SHM created: %s (%zu bytes)", name,
                 sizeof(ZeroCopyFrameBuffer));
    }
    return shm;
}

ZeroCopyFrameBuffer* shm_zerocopy_open(const char* name) {
    ZeroCopyFrameBuffer* shm =
        (ZeroCopyFrameBuffer*)shm_create_or_open(name, sizeof(ZeroCopyFrameBuffer), false);
    if (shm)
        LOG_INFO("SharedMemory", "Zero-copy SHM opened: %s", name);
    return shm;
}

void shm_zerocopy_close(ZeroCopyFrameBuffer* shm) {
    if (shm)
        munmap(shm, sizeof(ZeroCopyFrameBuffer));
}

void shm_zerocopy_destroy(ZeroCopyFrameBuffer* shm, const char* name) {
    if (shm) {
        sem_destroy(&shm->new_frame_sem);
        munmap(shm, sizeof(ZeroCopyFrameBuffer));
        shm_unlink(name);
    }
}

int shm_zerocopy_write(ZeroCopyFrameBuffer* shm, const ZeroCopyFrame* frame) {
    if (!shm || !frame)
        return -1;
    const uint32_t ver = __atomic_load_n(&shm->frame.version, __ATOMIC_ACQUIRE);
    memcpy(&shm->frame, frame, sizeof(ZeroCopyFrame));
    __atomic_store_n(&shm->frame.version, ver + 1, __ATOMIC_RELEASE);
    sem_post(&shm->new_frame_sem);
    return 0;
}

// ============================================================================
// ROI Zero-Copy (night camera pre-cropped 640x640 regions)
// Reuses ZeroCopyFrameBuffer — identical layout to YOLO/MJPEG zero-copy.
// ============================================================================

ZeroCopyFrameBuffer* shm_roi_zc_create(const char* shm_name) {
    bool created_new = false;
    ZeroCopyFrameBuffer* shm = (ZeroCopyFrameBuffer*)shm_create_or_open_ex(
        shm_name, sizeof(ZeroCopyFrameBuffer), true, &created_new);
    if (shm && created_new) {
        sem_init(&shm->new_frame_sem, 1, 0);
        shm->frame.version = 0;
        LOG_INFO("SharedMemory", "ROI zero-copy SHM created: %s (%zu bytes)", shm_name,
                 sizeof(ZeroCopyFrameBuffer));
    }
    return shm;
}

ZeroCopyFrameBuffer* shm_roi_zc_open(const char* shm_name) {
    ZeroCopyFrameBuffer* shm =
        (ZeroCopyFrameBuffer*)shm_create_or_open(shm_name, sizeof(ZeroCopyFrameBuffer), false);
    if (shm)
        LOG_INFO("SharedMemory", "ROI zero-copy SHM opened: %s", shm_name);
    return shm;
}

void shm_roi_zc_destroy(ZeroCopyFrameBuffer* shm, const char* shm_name) {
    if (shm) {
        sem_destroy(&shm->new_frame_sem);
        munmap(shm, sizeof(ZeroCopyFrameBuffer));
        shm_unlink(shm_name);
    }
}

int shm_roi_zc_write(ZeroCopyFrameBuffer* shm, const ZeroCopyFrame* frame) {
    if (!shm || !frame)
        return -1;
    const uint32_t ver = __atomic_load_n(&shm->frame.version, __ATOMIC_ACQUIRE);
    memcpy(&shm->frame, frame, sizeof(ZeroCopyFrame));
    __atomic_store_n(&shm->frame.version, ver + 1, __ATOMIC_RELEASE);
    sem_post(&shm->new_frame_sem);
    return 0;
}

// ============================================================================
// H.265 Zero-Copy (bitstream)
// ============================================================================

H265ZeroCopyBuffer* shm_h265_zc_create(const char* name) {
    bool created_new = false;
    H265ZeroCopyBuffer* shm = (H265ZeroCopyBuffer*)shm_create_or_open_ex(
        name, sizeof(H265ZeroCopyBuffer), true, &created_new);
    if (shm && created_new) {
        sem_init(&shm->new_frame_sem, 1, 0);
        sem_init(&shm->consumed_sem, 1, 0);
        shm->frame.version = 0;
        LOG_INFO("SharedMemory", "H.265 zero-copy SHM created: %s (%zu bytes)", name,
                 sizeof(H265ZeroCopyBuffer));
    }
    return shm;
}

H265ZeroCopyBuffer* shm_h265_zc_open(const char* name) {
    return (H265ZeroCopyBuffer*)shm_create_or_open(name, sizeof(H265ZeroCopyBuffer), false);
}

void shm_h265_zc_close(H265ZeroCopyBuffer* shm) {
    if (shm)
        munmap(shm, sizeof(H265ZeroCopyBuffer));
}

void shm_h265_zc_destroy(H265ZeroCopyBuffer* shm, const char* name) {
    if (shm) {
        sem_destroy(&shm->new_frame_sem);
        sem_destroy(&shm->consumed_sem);
        munmap(shm, sizeof(H265ZeroCopyBuffer));
        shm_unlink(name);
    }
}

int shm_h265_zc_write(H265ZeroCopyBuffer* shm, const H265ZeroCopyFrame* frame) {
    if (!shm || !frame)
        return -1;
    const uint32_t ver = __atomic_load_n(&shm->frame.version, __ATOMIC_ACQUIRE);
    memcpy(&shm->frame, frame, sizeof(H265ZeroCopyFrame));
    __atomic_store_n(&shm->frame.version, ver + 1, __ATOMIC_RELEASE);
    sem_post(&shm->new_frame_sem);
    return 0;
}
