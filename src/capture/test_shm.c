/**
 * test_shm.c - Test program for shared memory implementation
 *
 * Tests:
 * 1. Shared memory creation and cleanup
 * 2. Frame buffer write and read
 * 3. Ring buffer wraparound
 * 4. Detection result write and read
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <assert.h>

#include "shared_memory.h"
#include "logger.h"

#define TEST_PASSED() printf("[PASS] %s\n", __func__)
#define TEST_FAILED() do { printf("[FAIL] %s:%d\n", __func__, __LINE__); exit(1); } while(0)

// Test 1: Create and destroy shared memory
void test_shm_create_destroy(void) {
    SharedFrameBuffer* shm = shm_frame_buffer_create();
    assert(shm != NULL);

    // Check initial state
    assert(shm->write_index == 0);

    shm_frame_buffer_destroy(shm);
    TEST_PASSED();
}

// Test 2: Write and read a single frame
void test_shm_write_read_single(void) {
    SharedFrameBuffer* shm = shm_frame_buffer_create();
    assert(shm != NULL);

    // Create a test frame
    Frame write_frame = {0};
    write_frame.frame_number = 42;
    write_frame.camera_id = 0;
    write_frame.width = 640;
    write_frame.height = 480;
    write_frame.format = 0;  // JPEG
    write_frame.data_size = 100;
    clock_gettime(CLOCK_MONOTONIC, &write_frame.timestamp);

    // Fill with test data
    for (size_t i = 0; i < write_frame.data_size; i++) {
        write_frame.data[i] = (uint8_t)(i & 0xFF);
    }

    // Write frame
    int ret = shm_frame_buffer_write(shm, &write_frame);
    assert(ret == 0);

    // Read frame
    Frame read_frame = {0};
    ret = shm_frame_buffer_read_latest(shm, &read_frame);
    assert(ret == 0);  // Should return index 0

    // Verify data
    assert(read_frame.frame_number == 42);
    assert(read_frame.camera_id == 0);
    assert(read_frame.width == 640);
    assert(read_frame.height == 480);
    assert(read_frame.format == 0);
    assert(read_frame.data_size == 100);

    for (size_t i = 0; i < 100; i++) {
        assert(read_frame.data[i] == (uint8_t)(i & 0xFF));
    }

    shm_frame_buffer_destroy(shm);
    TEST_PASSED();
}

// Test 3: Ring buffer wraparound
void test_shm_ring_buffer_wraparound(void) {
    SharedFrameBuffer* shm = shm_frame_buffer_create();
    assert(shm != NULL);

    // Write more than RING_BUFFER_SIZE frames
    for (int i = 0; i < RING_BUFFER_SIZE + 10; i++) {
        Frame frame = {0};
        frame.frame_number = i;
        frame.camera_id = 0;
        frame.width = 640;
        frame.height = 480;
        frame.data_size = 10;

        int ret = shm_frame_buffer_write(shm, &frame);
        assert(ret == 0);
    }

    // Read latest frame (should be frame number 39)
    Frame read_frame = {0};
    int ret = shm_frame_buffer_read_latest(shm, &read_frame);
    assert(ret >= 0);
    assert(read_frame.frame_number == RING_BUFFER_SIZE + 10 - 1);

    // Check write_index
    uint32_t write_idx = shm_frame_buffer_get_write_index(shm);
    assert(write_idx == RING_BUFFER_SIZE + 10);

    shm_frame_buffer_destroy(shm);
    TEST_PASSED();
}

// Test 4: Detection result write and read
void test_detection_write_read(void) {
    LatestDetectionResult* shm = shm_detection_create();
    assert(shm != NULL);

    // Create test detections
    Detection detections[3];
    strcpy(detections[0].class_name, "cat");
    detections[0].confidence = 0.95f;
    detections[0].bbox = (BoundingBox){100, 200, 150, 180};

    strcpy(detections[1].class_name, "food_bowl");
    detections[1].confidence = 0.88f;
    detections[1].bbox = (BoundingBox){300, 400, 100, 80};

    strcpy(detections[2].class_name, "water_bowl");
    detections[2].confidence = 0.92f;
    detections[2].bbox = (BoundingBox){500, 450, 90, 70};

    // Write detections
    int ret = shm_detection_write(shm, 123, detections, 3);
    assert(ret == 0);

    // Read detections
    Detection read_detections[MAX_DETECTIONS];
    int num_detections = 0;
    uint32_t version = shm_detection_read(shm, read_detections, &num_detections);

    assert(version == 1);  // First write
    assert(num_detections == 3);
    assert(shm->frame_number == 123);

    // Verify data
    assert(strcmp(read_detections[0].class_name, "cat") == 0);
    assert(read_detections[0].confidence == 0.95f);
    assert(read_detections[0].bbox.x == 100);
    assert(read_detections[0].bbox.y == 200);

    assert(strcmp(read_detections[1].class_name, "food_bowl") == 0);
    assert(strcmp(read_detections[2].class_name, "water_bowl") == 0);

    shm_detection_destroy(shm);
    TEST_PASSED();
}

// Test 5: Multiple writes increment version
void test_detection_version_increment(void) {
    LatestDetectionResult* shm = shm_detection_create();
    assert(shm != NULL);

    Detection detections[1];
    strcpy(detections[0].class_name, "cat");
    detections[0].confidence = 0.9f;
    detections[0].bbox = (BoundingBox){0, 0, 100, 100};

    // Write multiple times
    for (int i = 0; i < 5; i++) {
        int ret = shm_detection_write(shm, i, detections, 1);
        assert(ret == 0);
    }

    // Read version
    Detection read_detections[MAX_DETECTIONS];
    int num_detections = 0;
    uint32_t version = shm_detection_read(shm, read_detections, &num_detections);

    assert(version == 5);  // Should have incremented 5 times

    shm_detection_destroy(shm);
    TEST_PASSED();
}

int main(void) {
    // Initialize logger
    log_init(LOG_LEVEL_INFO, stdout, 0);

    printf("=== Shared Memory Test Suite ===\n\n");

    test_shm_create_destroy();
    test_shm_write_read_single();
    test_shm_ring_buffer_wraparound();
    test_detection_write_read();
    test_detection_version_increment();

    printf("\n=== All tests passed! ===\n");
    return 0;
}
