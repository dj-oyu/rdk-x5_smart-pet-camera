/**
 * shm_constants.h - Shared memory constants (single source of truth)
 *
 * All SHM name and buffer size constants live here.
 * Included by shared_memory.h, Go CGO, and referenced by Python ctypes.
 *
 * When changing constants:
 * 1. Edit this file only
 * 2. Rebuild C (make -C src/capture)
 * 3. Rebuild Go (go build ./...)
 * 4. Update Python real_shared_memory.py RING_BUFFER_SIZE to match
 * 5. rm /dev/shm/pet_camera_* before testing
 *
 * SHM layout (3 segments):
 *   /pet_camera_h265_zc    — H.265 stream zero-copy (encoder → Go streaming)
 *   /pet_camera_yolo_zc    — YOLO input zero-copy (camera → Python detector)
 *   /pet_camera_detections — Detection results (Python detector → Go web_monitor)
 *   /pet_camera_mjpeg_frame — MJPEG NV12 (camera → Go web_monitor, TODO: zero-copy)
 */

#ifndef SHM_CONSTANTS_H
#define SHM_CONSTANTS_H

// Shared memory segment names
#define SHM_NAME_H265_ZC "/pet_camera_h265_zc"            // H.265 stream zero-copy
#define SHM_NAME_YOLO_ZC "/pet_camera_yolo_zc"            // YOLO input zero-copy (unified, replaces zc_0/zc_1)
#define SHM_NAME_DETECTIONS "/pet_camera_detections"      // YOLO detection results
#define SHM_NAME_MJPEG_FRAME "/pet_camera_mjpeg_frame"    // 768x432 NV12 for MJPEG/web_monitor

// Buffer sizes
#define RING_BUFFER_SIZE 6                                // 200ms buffer at 30fps (MJPEG only)
#define MAX_DETECTIONS 10                                 // Maximum detections per frame
#define MAX_FRAME_SIZE (1920 * 1080 * 3 / 2)             // Max NV12 frame size (1080p)
#define NUM_CAMERAS 2                                     // DAY=0, NIGHT=1

// Zero-copy constants
#define ZEROCOPY_MAX_PLANES 2                             // NV12: Y + UV
#define HB_MEM_GRAPHIC_BUF_SIZE 160                       // sizeof(hb_mem_graphic_buf_t)

#endif // SHM_CONSTANTS_H
