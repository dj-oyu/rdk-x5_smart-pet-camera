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

// Test 6: Camera control create and destroy
void test_camera_control_create_destroy(void) {
    CameraControl* ctrl = shm_control_create();
    assert(ctrl != NULL);

    // Check initial state (should be DAY camera)
    assert(ctrl->active_camera_index == 0);
    assert(ctrl->version == 0);

    shm_control_destroy(ctrl);
    TEST_PASSED();
}

// Test 7: Camera control set and get active
void test_camera_control_set_get(void) {
    CameraControl* ctrl = shm_control_create();
    assert(ctrl != NULL);

    // Initial state should be DAY (0)
    int active = shm_control_get_active(ctrl);
    assert(active == 0);

    // Switch to NIGHT (1)
    shm_control_set_active(ctrl, 1);
    active = shm_control_get_active(ctrl);
    assert(active == 1);

    // Check version incremented
    uint32_t version = shm_control_get_version(ctrl);
    assert(version == 1);

    // Switch back to DAY (0)
    shm_control_set_active(ctrl, 0);
    active = shm_control_get_active(ctrl);
    assert(active == 0);

    // Version should be 2 now
    version = shm_control_get_version(ctrl);
    assert(version == 2);

    shm_control_destroy(ctrl);
    TEST_PASSED();
}

// Test 8: Camera control invalid values
void test_camera_control_invalid_values(void) {
    CameraControl* ctrl = shm_control_create();
    assert(ctrl != NULL);

    // Try to set invalid camera index (-1)
    shm_control_set_active(ctrl, -1);
    // Should not change (still 0)
    assert(shm_control_get_active(ctrl) == 0);

    // Try to set invalid camera index (2)
    shm_control_set_active(ctrl, 2);
    // Should not change (still 0)
    assert(shm_control_get_active(ctrl) == 0);

    // Version should not have changed (0)
    assert(shm_control_get_version(ctrl) == 0);

    shm_control_destroy(ctrl);
    TEST_PASSED();
}

// Test 9: Camera control producer-consumer simulation
void test_camera_control_producer_consumer(void) {
    // Producer creates
    CameraControl* producer = shm_control_create();
    assert(producer != NULL);

    // Consumer opens
    CameraControl* consumer = shm_control_open();
    assert(consumer != NULL);

    // Producer sets to NIGHT
    shm_control_set_active(producer, 1);

    // Consumer should see NIGHT
    int active = shm_control_get_active(consumer);
    assert(active == 1);

    // Consumer should see version 1
    uint32_t version = shm_control_get_version(consumer);
    assert(version == 1);

    // Cleanup
    shm_control_close(consumer);
    shm_control_destroy(producer);
    TEST_PASSED();
}

// Test 10: ZeroCopyFrame struct layout with hb_mem_buf_data
void test_zerocopy_frame_layout(void) {
    // Verify hb_mem_buf_data field exists and has correct size
    ZeroCopyFrame frame = {0};

    // Verify hb_mem_buf_data is 160 bytes
    assert(sizeof(frame.hb_mem_buf_data) == HB_MEM_GRAPHIC_BUF_SIZE);
    assert(HB_MEM_GRAPHIC_BUF_SIZE == 160);

    // Write a test pattern to hb_mem_buf_data
    for (int i = 0; i < HB_MEM_GRAPHIC_BUF_SIZE; i++) {
        frame.hb_mem_buf_data[i] = (uint8_t)(i & 0xFF);
    }

    // Set other fields to known values
    frame.frame_number = 12345;
    frame.plane_cnt = 2;
    frame.share_id[0] = 100;
    frame.share_id[1] = 200;
    frame.version = 42;
    frame.consumed = 0;

    // Verify hb_mem_buf_data didn't corrupt other fields
    assert(frame.frame_number == 12345);
    assert(frame.plane_cnt == 2);
    assert(frame.share_id[0] == 100);
    assert(frame.share_id[1] == 200);
    assert(frame.version == 42);
    assert(frame.consumed == 0);

    // Verify hb_mem_buf_data content is intact
    for (int i = 0; i < HB_MEM_GRAPHIC_BUF_SIZE; i++) {
        assert(frame.hb_mem_buf_data[i] == (uint8_t)(i & 0xFF));
    }

    // Verify the field sits between plane_cnt and version
    // (hb_mem_buf_data offset should be > plane_cnt offset and < version offset)
    size_t offset_plane_cnt = (size_t)((char*)&frame.plane_cnt - (char*)&frame);
    size_t offset_buf_data = (size_t)((char*)frame.hb_mem_buf_data - (char*)&frame);
    size_t offset_version = (size_t)((char*)&frame.version - (char*)&frame);

    assert(offset_buf_data > offset_plane_cnt);
    assert(offset_buf_data + HB_MEM_GRAPHIC_BUF_SIZE <= offset_version);

    printf("  ZeroCopyFrame size: %zu bytes\n", sizeof(ZeroCopyFrame));
    printf("  hb_mem_buf_data offset: %zu, size: %d\n", offset_buf_data, HB_MEM_GRAPHIC_BUF_SIZE);
    printf("  version offset: %zu\n", offset_version);

    TEST_PASSED();
}

// Test 11: ZeroCopyFrameBuffer with hb_mem_buf_data via shared memory
void test_zerocopy_shm_roundtrip(void) {
    const char *test_name = "/pet_camera_test_zc";

    ZeroCopyFrameBuffer *producer = shm_zerocopy_create(test_name);
    assert(producer != NULL);

    // Write a frame with hb_mem_buf_data
    ZeroCopyFrame frame = {0};
    frame.frame_number = 999;
    frame.width = 640;
    frame.height = 360;
    frame.plane_cnt = 2;
    for (int i = 0; i < HB_MEM_GRAPHIC_BUF_SIZE; i++) {
        frame.hb_mem_buf_data[i] = (uint8_t)((i * 7) & 0xFF);
    }

    int ret = shm_zerocopy_write(producer, &frame);
    assert(ret == 0);

    // Verify the data is in shared memory
    assert(producer->frame.frame_number == 999);
    assert(producer->frame.width == 640);
    assert(producer->frame.height == 360);
    assert(producer->frame.plane_cnt == 2);

    // Verify hb_mem_buf_data roundtrip
    for (int i = 0; i < HB_MEM_GRAPHIC_BUF_SIZE; i++) {
        assert(producer->frame.hb_mem_buf_data[i] == (uint8_t)((i * 7) & 0xFF));
    }

    // Verify version increments correctly across multiple writes
    assert(producer->frame.version == 1);  // First write → version 1

    shm_zerocopy_mark_consumed(producer);
    frame.frame_number = 1000;
    ret = shm_zerocopy_write(producer, &frame);
    assert(ret == 0);
    assert(producer->frame.version == 2);  // Second write → version 2

    shm_zerocopy_mark_consumed(producer);
    frame.frame_number = 1001;
    ret = shm_zerocopy_write(producer, &frame);
    assert(ret == 0);
    assert(producer->frame.version == 3);  // Third write → version 3

    printf("  version after 3 writes: %u (expected 3)\n", producer->frame.version);

    shm_zerocopy_destroy(producer, test_name);
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

    printf("\n--- Camera Control Tests ---\n");
    test_camera_control_create_destroy();
    test_camera_control_set_get();
    test_camera_control_invalid_values();
    test_camera_control_producer_consumer();

    printf("\n--- ZeroCopy Layout Tests ---\n");
    test_zerocopy_frame_layout();
    test_zerocopy_shm_roundtrip();

    printf("\n=== All tests passed! ===\n");
    return 0;
}
