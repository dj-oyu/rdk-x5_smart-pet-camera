/*
 * vio_lowlevel.h - Low-level VIO Pipeline Abstraction
 *
 * Hardware Abstraction Layer for D-Robotics VIO (Video Input/Output)
 * Manages VIN (Video Input), ISP (Image Signal Processor), and VSE (Video Scaling Engine)
 */

#ifndef VIO_LOWLEVEL_H
#define VIO_LOWLEVEL_H

#include <stdint.h>
#include "hb_camera_interface.h"
#include "hb_camera_data_config.h"
#include "hbn_api.h"

/**
 * VIO context - encapsulates entire VIO pipeline
 */
typedef struct {
    // Hardware handles
    camera_handle_t cam_fd;
    hbn_vnode_handle_t vin_handle;
    hbn_vnode_handle_t isp_handle;
    hbn_vnode_handle_t vse_handle;
    hbn_vflow_handle_t vflow_fd;

    // Configuration
    int camera_index;      // 0 or 1
    int sensor_width;      // Sensor native resolution
    int sensor_height;
    int output_width;      // VSE output resolution
    int output_height;
    int fps;               // Target frame rate

    // Internal state
    camera_config_t camera_config;
    mipi_config_t mipi_config;
} vio_context_t;

/**
 * Create VIO context and initialize hardware pipeline
 *
 * Creates VIN -> ISP -> VSE pipeline for the specified camera.
 * Does NOT start the pipeline (use vio_start()).
 *
 * Args:
 *   ctx: VIO context to initialize
 *   camera_index: Camera index (0 or 1)
 *   sensor_width: Sensor native width (e.g., 1920)
 *   sensor_height: Sensor native height (e.g., 1080)
 *   output_width: VSE output width (can differ from sensor)
 *   output_height: VSE output height (can differ from sensor)
 *   fps: Target frame rate (e.g., 30)
 *
 * Returns:
 *   0 on success, negative error code on failure
 *
 * Note:
 *   - Camera 0 uses MIPI Host 0
 *   - Camera 1 uses MIPI Host 2
 *   - bus_select is always 0 for both cameras
 */
int vio_create(vio_context_t *ctx, int camera_index,
               int sensor_width, int sensor_height,
               int output_width, int output_height,
               int fps);

/**
 * Start VIO pipeline
 *
 * Starts the hardware pipeline and begins frame capture.
 * After this call, vio_get_frame() can be used to retrieve frames.
 *
 * Args:
 *   ctx: VIO context
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int vio_start(vio_context_t *ctx);

/**
 * Get a frame from VIO pipeline (Channel 0 - main output)
 *
 * Retrieves an NV12 frame from the VSE output.
 * Blocks until a frame is available or timeout occurs.
 *
 * Args:
 *   ctx: VIO context
 *   frame: Output frame buffer (caller-allocated)
 *   timeout_ms: Timeout in milliseconds
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 *
 * Note:
 *   - Must call vio_release_frame() after processing
 *   - Frame data is in NV12 format (Y plane + UV interleaved)
 */
int vio_get_frame(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms);

/**
 * Get a frame from VIO pipeline Channel 1 (YOLO input)
 *
 * Retrieves a 640x360 NV12 frame from VSE Channel 1.
 * Blocks until a frame is available or timeout occurs.
 *
 * Args:
 *   ctx: VIO context
 *   frame: Output frame buffer (caller-allocated)
 *   timeout_ms: Timeout in milliseconds
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 *
 * Note:
 *   - Must call vio_release_frame_ch1() after processing
 */
int vio_get_frame_ch1(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms);

/**
 * Release a frame back to VIO pipeline (Channel 0)
 *
 * Returns the frame buffer to the hardware for reuse.
 * Must be called after vio_get_frame() to avoid buffer starvation.
 *
 * Args:
 *   ctx: VIO context
 *   frame: Frame to release (obtained from vio_get_frame)
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int vio_release_frame(vio_context_t *ctx, hbn_vnode_image_t *frame);

/**
 * Release a frame back to VIO pipeline (Channel 1)
 *
 * Returns the Channel 1 frame buffer to the hardware for reuse.
 * Must be called after vio_get_frame_ch1().
 *
 * Args:
 *   ctx: VIO context
 *   frame: Frame to release (obtained from vio_get_frame_ch1)
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int vio_release_frame_ch1(vio_context_t *ctx, hbn_vnode_image_t *frame);

/**
 * Get a frame from VIO pipeline Channel 2 (MJPEG/web_monitor input)
 *
 * Retrieves a 640x480 NV12 frame from VSE Channel 2.
 * Blocks until a frame is available or timeout occurs.
 *
 * Args:
 *   ctx: VIO context
 *   frame: Output frame buffer (caller-allocated)
 *   timeout_ms: Timeout in milliseconds
 *
 * Returns:
 *   0 on success, negative error code on failure/timeout
 *
 * Note:
 *   - Must call vio_release_frame_ch2() after processing
 */
int vio_get_frame_ch2(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms);

/**
 * Release a frame back to VIO pipeline (Channel 2)
 *
 * Returns the Channel 2 frame buffer to the hardware for reuse.
 * Must be called after vio_get_frame_ch2().
 *
 * Args:
 *   ctx: VIO context
 *   frame: Frame to release (obtained from vio_get_frame_ch2)
 *
 * Returns:
 *   0 on success, negative error code on failure
 */
int vio_release_frame_ch2(vio_context_t *ctx, hbn_vnode_image_t *frame);

/**
 * Stop VIO pipeline
 *
 * Stops frame capture.
 * Can be restarted with vio_start().
 *
 * Args:
 *   ctx: VIO context
 */
void vio_stop(vio_context_t *ctx);

/**
 * Destroy VIO context and cleanup hardware resources
 *
 * Stops pipeline (if running) and releases all hardware resources.
 * ctx becomes invalid after this call.
 *
 * Args:
 *   ctx: VIO context
 */
void vio_destroy(vio_context_t *ctx);

#endif // VIO_LOWLEVEL_H
