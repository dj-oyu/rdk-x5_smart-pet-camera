/*
 * hbn_isp_api.h - IDE STUB ONLY (D-Robotics RDK-X5 ISP API)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef HBN_ISP_API_H
#define HBN_ISP_API_H

#include <stdint.h>
#include "hbn_api.h"

/* ISP mode */
typedef enum {
    HBN_ISP_MODE_AUTO   = 0,
    HBN_ISP_MODE_MANUAL = 1,
} hbn_isp_mode_t;

/* AE statistics: 32x32 grid, 4 channels each = 4096 entries */
typedef struct {
    uint32_t expStat[32 * 32 * 4];
    uint64_t frame_id;
} hbn_isp_ae_statistics_t;

/* 3DNR (temporal noise reduction) */
typedef struct {
    hbn_isp_mode_t mode;
    struct {
        uint8_t tnr_strength;
    } manual_attr;
} hbn_isp_3dnr_attr_t;

/* AWB (auto white balance) */
typedef struct {
    hbn_isp_mode_t mode;
    struct {
        struct {
            float rgain;
            float grgain;
            float gbgain;
            float bgain;
        } gain;
    } manual_attr;
} hbn_isp_awb_attr_t;

/* ISP API functions */
int hbn_isp_get_ae_statistics(hbn_vnode_handle_t isp_handle,
                               hbn_isp_ae_statistics_t *stats);
int hbn_isp_set_3dnr_attr(hbn_vnode_handle_t isp_handle,
                           const hbn_isp_3dnr_attr_t *attr);
int hbn_isp_get_3dnr_attr(hbn_vnode_handle_t isp_handle,
                           hbn_isp_3dnr_attr_t *attr);
int hbn_isp_get_awb_attr(hbn_vnode_handle_t isp_handle,
                          hbn_isp_awb_attr_t *attr);
int hbn_isp_set_awb_attr(hbn_vnode_handle_t isp_handle,
                          const hbn_isp_awb_attr_t *attr);

#endif /* HBN_ISP_API_H */
