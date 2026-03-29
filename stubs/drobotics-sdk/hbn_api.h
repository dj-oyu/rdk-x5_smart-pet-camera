/*
 * hbn_api.h - IDE STUB ONLY (D-Robotics RDK-X5 HBN VIO API)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef HBN_API_H
#define HBN_API_H

#include <stdint.h>
#include "hb_mem_mgr.h"

typedef int64_t hbn_vnode_handle_t;
typedef int64_t hbn_vflow_handle_t;
typedef int64_t camera_handle_t;  /* also declared in hb_camera_interface.h */

/* Frame image from VIO pipeline */
typedef struct {
    hb_mem_graphic_buf_t buffer;
    struct {
        uint64_t frame_id;
        uint64_t timestamp;
    } info;
} hbn_vnode_image_t;

/* Buffer allocation attributes */
typedef struct {
    int32_t buffers_num;
    int32_t is_contig;
    uint64_t flags;
} hbn_buf_alloc_attr_t;

/* vnode type IDs */
#define HB_VIN   0
#define HB_ISP   1
#define HB_VSE   2
#define AUTO_ALLOC_ID (-1)

/* vnode operations */
int hbn_vnode_open(int type, int hw_id, int id, hbn_vnode_handle_t *handle);
int hbn_vnode_close(hbn_vnode_handle_t handle);
int hbn_vnode_set_attr(hbn_vnode_handle_t handle, const void *attr);
int hbn_vnode_set_ichn_attr(hbn_vnode_handle_t handle, int chn, const void *attr);
int hbn_vnode_set_ochn_attr(hbn_vnode_handle_t handle, int chn, const void *attr);
int hbn_vnode_set_ochn_buf_attr(hbn_vnode_handle_t handle, int chn,
                                 const hbn_buf_alloc_attr_t *attr);
int hbn_vnode_getframe(hbn_vnode_handle_t handle, int chn,
                        int timeout_ms, hbn_vnode_image_t *frame);
int hbn_vnode_releaseframe(hbn_vnode_handle_t handle, int chn,
                            hbn_vnode_image_t *frame);

/* vflow operations */
int hbn_vflow_create(hbn_vflow_handle_t *fd);
int hbn_vflow_add_vnode(hbn_vflow_handle_t fd, hbn_vnode_handle_t handle);
int hbn_vflow_bind_vnode(hbn_vflow_handle_t fd,
                          hbn_vnode_handle_t src, int src_chn,
                          hbn_vnode_handle_t dst, int dst_chn);
int hbn_vflow_start(hbn_vflow_handle_t fd);
int hbn_vflow_stop(hbn_vflow_handle_t fd);
int hbn_vflow_destroy(hbn_vflow_handle_t fd);

/* Camera operations */
int hbn_camera_create(const void *config, camera_handle_t *fd);
int hbn_camera_attach_to_vin(camera_handle_t cam_fd, hbn_vnode_handle_t vin_handle);
int hbn_camera_destroy(camera_handle_t fd);

#endif /* HBN_API_H */
