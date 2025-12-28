/**
 * shared_memory.c - POSIX shared memory implementation
 *
 * Implements lock-free ring buffer for camera frames and detection results
 * using POSIX shared memory (shm_open/mmap).
 */

#include "shared_memory.h"
#include "logger.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

// Helper function to create or open shared memory
static void* shm_create_or_open(const char* name, size_t size, bool create) {
    int shm_fd;
    void* ptr;

    if (create) {
        // Create new shared memory segment
        shm_fd = shm_open(name, O_CREAT | O_RDWR, 0666);
        if (shm_fd == -1) {
            LOG_ERROR("SharedMemory", "shm_open create failed for %s: %s",
                      name, strerror(errno));
            return NULL;
        }

        // Set size
        if (ftruncate(shm_fd, size) == -1) {
            LOG_ERROR("SharedMemory", "ftruncate failed: %s", strerror(errno));
            close(shm_fd);
            shm_unlink(name);
            return NULL;
        }
    } else {
        // Open existing shared memory segment
        shm_fd = shm_open(name, O_RDWR, 0666);
        if (shm_fd == -1) {
            LOG_ERROR("SharedMemory", "shm_open failed for %s: %s",
                      name, strerror(errno));
            return NULL;
        }
    }

    // Map to memory
    ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    if (ptr == MAP_FAILED) {
        LOG_ERROR("SharedMemory", "mmap failed: %s", strerror(errno));
        close(shm_fd);
        if (create) {
            shm_unlink(name);
        }
        return NULL;
    }

    close(shm_fd);  // Can close fd after mmap

    // Initialize to zero on creation
    if (create) {
        memset(ptr, 0, size);
    }

    return ptr;
}

// Frame buffer functions

SharedFrameBuffer* shm_frame_buffer_create(void) {
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open(
        SHM_NAME_FRAMES,
        sizeof(SharedFrameBuffer),
        true  // create
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Shared memory created: %s (size=%zu bytes)",
                 SHM_NAME_FRAMES, sizeof(SharedFrameBuffer));
    }

    return shm;
}

SharedFrameBuffer* shm_frame_buffer_open(void) {
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open(
        SHM_NAME_FRAMES,
        sizeof(SharedFrameBuffer),
        false  // open existing
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Shared memory opened: %s", SHM_NAME_FRAMES);
    }

    return shm;
}

void shm_frame_buffer_close(SharedFrameBuffer* shm) {
    if (shm) {
        munmap(shm, sizeof(SharedFrameBuffer));
    }
}

void shm_frame_buffer_destroy(SharedFrameBuffer* shm) {
    if (shm) {
        munmap(shm, sizeof(SharedFrameBuffer));
        shm_unlink(SHM_NAME_FRAMES);
        LOG_INFO("SharedMemory", "Shared memory destroyed: %s", SHM_NAME_FRAMES);
    }
}

SharedFrameBuffer* shm_frame_buffer_create_named(const char* name) {
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open(
        name,
        sizeof(SharedFrameBuffer),
        true  // create
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Shared memory created: %s (size=%zu bytes)",
                 name, sizeof(SharedFrameBuffer));
    }

    return shm;
}

SharedFrameBuffer* shm_frame_buffer_open_named(const char* name) {
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open(
        name,
        sizeof(SharedFrameBuffer),
        false  // open existing
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Shared memory opened: %s", name);
    }

    return shm;
}

void shm_frame_buffer_destroy_named(SharedFrameBuffer* shm, const char* name) {
    if (shm) {
        munmap(shm, sizeof(SharedFrameBuffer));
        shm_unlink(name);
        LOG_INFO("SharedMemory", "Shared memory destroyed: %s", name);
    }
}

int shm_frame_buffer_write(SharedFrameBuffer* shm, const Frame* frame) {
    if (!shm || !frame) {
        return -1;
    }

    // Atomically increment write_index and get the slot
    uint32_t idx = __atomic_fetch_add(&shm->write_index, 1, __ATOMIC_SEQ_CST);
    idx = idx % RING_BUFFER_SIZE;

    // Copy frame data to the slot
    memcpy(&shm->frames[idx], frame, sizeof(Frame));

    return 0;
}

int shm_frame_buffer_read_latest(SharedFrameBuffer* shm, Frame* frame) {
    if (!shm || !frame) {
        return -1;
    }

    // Atomically read current write_index
    uint32_t write_idx = __atomic_load_n(&shm->write_index, __ATOMIC_SEQ_CST);

    if (write_idx == 0) {
        // No frames written yet
        return -1;
    }

    // Calculate the index of the latest frame
    uint32_t latest_idx = (write_idx - 1) % RING_BUFFER_SIZE;

    // Copy frame data
    memcpy(frame, &shm->frames[latest_idx], sizeof(Frame));

    return (int)latest_idx;
}

uint32_t shm_frame_buffer_get_write_index(SharedFrameBuffer* shm) {
    if (!shm) {
        return 0;
    }
    return __atomic_load_n(&shm->write_index, __ATOMIC_SEQ_CST);
}

// Detection result functions

LatestDetectionResult* shm_detection_create(void) {
    LatestDetectionResult* shm = (LatestDetectionResult*)shm_create_or_open(
        SHM_NAME_DETECTIONS,
        sizeof(LatestDetectionResult),
        true  // create
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Detection shared memory created: %s (size=%zu bytes)",
                 SHM_NAME_DETECTIONS, sizeof(LatestDetectionResult));
    }

    return shm;
}

LatestDetectionResult* shm_detection_open(void) {
    LatestDetectionResult* shm = (LatestDetectionResult*)shm_create_or_open(
        SHM_NAME_DETECTIONS,
        sizeof(LatestDetectionResult),
        false  // open existing
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Detection shared memory opened: %s", SHM_NAME_DETECTIONS);
    }

    return shm;
}

void shm_detection_close(LatestDetectionResult* shm) {
    if (shm) {
        munmap(shm, sizeof(LatestDetectionResult));
    }
}

void shm_detection_destroy(LatestDetectionResult* shm) {
    if (shm) {
        munmap(shm, sizeof(LatestDetectionResult));
        shm_unlink(SHM_NAME_DETECTIONS);
        LOG_INFO("SharedMemory", "Detection shared memory destroyed: %s", SHM_NAME_DETECTIONS);
    }
}

int shm_detection_write(LatestDetectionResult* shm,
                        uint64_t frame_number,
                        const Detection* detections,
                        int num_detections) {
    if (!shm || !detections || num_detections < 0 || num_detections > MAX_DETECTIONS) {
        return -1;
    }

    // Update data
    clock_gettime(CLOCK_MONOTONIC, &shm->timestamp);
    shm->frame_number = frame_number;
    shm->num_detections = num_detections;
    memcpy(shm->detections, detections, sizeof(Detection) * num_detections);

    // Atomically increment version
    __atomic_fetch_add(&shm->version, 1, __ATOMIC_SEQ_CST);

    return 0;
}

uint32_t shm_detection_read(LatestDetectionResult* shm,
                             Detection* detections,
                             int* num_detections) {
    if (!shm || !detections || !num_detections) {
        return 0;
    }

    // Atomically read version
    uint32_t version = __atomic_load_n(&shm->version, __ATOMIC_SEQ_CST);

    // Copy detection data
    *num_detections = shm->num_detections;
    if (*num_detections > 0) {
        memcpy(detections, shm->detections, sizeof(Detection) * (*num_detections));
    }

    return version;
}
