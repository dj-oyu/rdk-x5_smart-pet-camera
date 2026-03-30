// protocol.h — Wire protocol for ax_yolo_daemon.
// Shared between C++ daemon and Rust client (#[repr(C, packed)]).
#pragma once

#include <cstdint>

// Commands
static constexpr uint16_t CMD_DETECT = 0;
static constexpr uint16_t CMD_LOAD = 1;
static constexpr uint16_t CMD_UNLOAD = 2;
static constexpr uint16_t CMD_STATUS = 3;
static constexpr uint16_t CMD_STREAM = 4;

// Input types for CMD_DETECT
static constexpr uint16_t INPUT_JPEG_PATH = 0;
static constexpr uint16_t INPUT_NV12_RAW = 1;

#pragma pack(push, 1)

struct RequestHeader {
    uint16_t cmd;
    uint16_t input_type;
    uint16_t width;
    uint16_t height;
    uint32_t payload_size;
    uint32_t reserved;
};

struct ResponseHeader {
    uint16_t status;     // 0=ok, 1=error
    uint16_t det_count;  // number of WireDetection following
    float elapsed_ms;
    uint32_t error_len;  // if status=1, bytes of error string following
};

struct WireDetection {
    int16_t x1, y1, x2, y2;
    uint16_t class_id;
    uint16_t confidence; // prob × 10000
};

#pragma pack(pop)

static_assert(sizeof(RequestHeader) == 16, "");
static_assert(sizeof(ResponseHeader) == 12, "");
static_assert(sizeof(WireDetection) == 12, "");
