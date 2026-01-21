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
// Returns pointer to shared memory, and sets *created_new to true if newly created
static void* shm_create_or_open_ex(const char* name, size_t size, bool create, bool* created_new) {
    int shm_fd;
    void* ptr;
    bool is_new = false;

    if (create) {
        // Try to create exclusively first to detect if already exists
        shm_fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0666);
        if (shm_fd == -1 && errno == EEXIST) {
            // Already exists, open it instead
            shm_fd = shm_open(name, O_RDWR, 0666);
            is_new = false;
        } else if (shm_fd != -1) {
            // Successfully created new shared memory
            is_new = true;

            // Set size for new shared memory
            if (ftruncate(shm_fd, size) == -1) {
                LOG_ERROR("SharedMemory", "ftruncate failed: %s", strerror(errno));
                close(shm_fd);
                shm_unlink(name);
                return NULL;
            }
        } else {
            LOG_ERROR("SharedMemory", "shm_open create failed for %s: %s",
                      name, strerror(errno));
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
        is_new = false;
    }

    // Map to memory
    ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    if (ptr == MAP_FAILED) {
        LOG_ERROR("SharedMemory", "mmap failed: %s", strerror(errno));
        close(shm_fd);
        if (is_new) {
            shm_unlink(name);
        }
        return NULL;
    }

    close(shm_fd);  // Can close fd after mmap

    // Initialize to zero on creation
    if (is_new) {
        memset(ptr, 0, size);
    }

    if (created_new) {
        *created_new = is_new;
    }

    return ptr;
}

// Legacy wrapper for backwards compatibility
static void* shm_create_or_open(const char* name, size_t size, bool create) {
    return shm_create_or_open_ex(name, size, create, NULL);
}

// Frame buffer functions

SharedFrameBuffer* shm_frame_buffer_create(void) {
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open(
        SHM_NAME_FRAMES,
        sizeof(SharedFrameBuffer),
        true  // create
    );

    if (shm) {
        // Initialize semaphore for inter-process notification
        // pshared=1 allows use across processes
        if (sem_init(&shm->new_frame_sem, 1, 0) != 0) {
            LOG_ERROR("SharedMemory", "sem_init failed: %s", strerror(errno));
            munmap(shm, sizeof(SharedFrameBuffer));
            shm_unlink(SHM_NAME_FRAMES);
            return NULL;
        }

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
        // Destroy semaphore before unmapping
        sem_destroy(&shm->new_frame_sem);

        munmap(shm, sizeof(SharedFrameBuffer));
        shm_unlink(SHM_NAME_FRAMES);
        LOG_INFO("SharedMemory", "Shared memory destroyed: %s", SHM_NAME_FRAMES);
    }
}

SharedFrameBuffer* shm_frame_buffer_create_named(const char* name) {
    bool created_new = false;
    SharedFrameBuffer* shm = (SharedFrameBuffer*)shm_create_or_open_ex(
        name,
        sizeof(SharedFrameBuffer),
        true,  // create (or open if exists)
        &created_new
    );

    if (shm) {
        if (created_new) {
            // Initialize semaphore only for newly created shared memory
            if (sem_init(&shm->new_frame_sem, 1, 0) != 0) {
                LOG_ERROR("SharedMemory", "sem_init failed for %s: %s",
                          name, strerror(errno));
                munmap(shm, sizeof(SharedFrameBuffer));
                shm_unlink(name);
                return NULL;
            }
            LOG_INFO("SharedMemory", "Shared memory created: %s (size=%zu bytes)",
                     name, sizeof(SharedFrameBuffer));
        } else {
            LOG_INFO("SharedMemory", "Shared memory opened (already exists): %s",
                     name);
        }
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
        // Destroy semaphore before unmapping
        sem_destroy(&shm->new_frame_sem);

        munmap(shm, sizeof(SharedFrameBuffer));
        shm_unlink(name);
        LOG_INFO("SharedMemory", "Shared memory destroyed: %s", name);
    }
}

int shm_frame_buffer_write(SharedFrameBuffer* shm, const Frame* frame) {
    if (!shm || !frame) {
        return -1;
    }

    // 1. Read current write_index to determine slot
    uint32_t current_idx = __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
    uint32_t slot = current_idx % RING_BUFFER_SIZE;

    // 2. Copy frame data FIRST (before incrementing write_index)
    memcpy(&shm->frames[slot], frame, sizeof(Frame));

    // 3. Memory barrier: ensure memcpy visible before index update
    __atomic_thread_fence(__ATOMIC_RELEASE);

    // 4. Increment write_index AFTER data is ready
    // Reader sees write_index = N only AFTER slot (N-1) % 30 is fully written
    __atomic_store_n(&shm->write_index, current_idx + 1, __ATOMIC_RELEASE);

    // Notify waiting readers that a new frame is available
    sem_post(&shm->new_frame_sem);

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
        // Initialize semaphore for event-driven detection updates
        // pshared=1 (inter-process), initial value=0 (starts empty)
        if (sem_init(&shm->detection_update_sem, 1, 0) != 0) {
            LOG_ERROR("SharedMemory", "Failed to initialize detection semaphore: %s", strerror(errno));
            munmap(shm, sizeof(LatestDetectionResult));
            shm_unlink(SHM_NAME_DETECTIONS);
            return NULL;
        }

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
        // Destroy semaphore before unmapping
        sem_destroy(&shm->detection_update_sem);

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

    // Signal semaphore to notify event-driven consumers
    sem_post(&shm->detection_update_sem);

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

// Brightness shared memory functions

SharedBrightnessData* shm_brightness_create(void) {
    bool created_new = false;
    SharedBrightnessData* shm = (SharedBrightnessData*)shm_create_or_open_ex(
        SHM_NAME_BRIGHTNESS,
        sizeof(SharedBrightnessData),
        true,  // create
        &created_new
    );

    if (shm) {
        if (created_new) {
            // Initialize semaphore for inter-process notification
            if (sem_init(&shm->update_sem, 1, 0) != 0) {
                LOG_ERROR("SharedMemory", "sem_init failed for brightness: %s", strerror(errno));
                munmap(shm, sizeof(SharedBrightnessData));
                shm_unlink(SHM_NAME_BRIGHTNESS);
                return NULL;
            }
            LOG_INFO("SharedMemory", "Brightness shared memory created: %s (size=%zu bytes)",
                     SHM_NAME_BRIGHTNESS, sizeof(SharedBrightnessData));
        } else {
            LOG_INFO("SharedMemory", "Brightness shared memory opened (already exists): %s",
                     SHM_NAME_BRIGHTNESS);
        }
    }

    return shm;
}

SharedBrightnessData* shm_brightness_open(void) {
    SharedBrightnessData* shm = (SharedBrightnessData*)shm_create_or_open(
        SHM_NAME_BRIGHTNESS,
        sizeof(SharedBrightnessData),
        false  // open existing
    );

    if (shm) {
        LOG_INFO("SharedMemory", "Brightness shared memory opened: %s", SHM_NAME_BRIGHTNESS);
    }

    return shm;
}

void shm_brightness_close(SharedBrightnessData* shm) {
    if (shm) {
        munmap(shm, sizeof(SharedBrightnessData));
    }
}

void shm_brightness_write(SharedBrightnessData* shm, int camera_id,
                          const CameraBrightness* brightness) {
    if (!shm || !brightness || camera_id < 0 || camera_id >= NUM_CAMERAS) {
        return;
    }

    // Copy brightness data for this camera
    memcpy(&shm->cameras[camera_id], brightness, sizeof(CameraBrightness));

    // Memory barrier
    __atomic_thread_fence(__ATOMIC_RELEASE);

    // Atomically increment version
    __atomic_fetch_add(&shm->version, 1, __ATOMIC_SEQ_CST);

    // Notify waiting readers
    sem_post(&shm->update_sem);
}

uint32_t shm_brightness_read(SharedBrightnessData* shm, int camera_id,
                              CameraBrightness* brightness) {
    if (!shm || !brightness || camera_id < 0 || camera_id >= NUM_CAMERAS) {
        return 0;
    }

    // Atomically read version
    uint32_t version = __atomic_load_n(&shm->version, __ATOMIC_SEQ_CST);

    // Copy brightness data
    memcpy(brightness, &shm->cameras[camera_id], sizeof(CameraBrightness));

    return version;
}
