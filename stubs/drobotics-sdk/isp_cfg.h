/*
 * isp_cfg.h - IDE STUB ONLY (D-Robotics RDK-X5 ISP config types)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef ISP_CFG_H
#define ISP_CFG_H

#include <stdint.h>

/* Frame format codes */
typedef enum {
    FRM_FMT_RAW  = 0,
    FRM_FMT_NV12 = 1,
    FRM_FMT_YUV  = 2,
} frm_fmt_t;

/* ISP sensor mode */
typedef enum {
    ISP_NORMAL_M = 0,
    ISP_DOL2_M   = 1,
} isp_sensor_mode_t;

/* Crop region */
typedef struct {
    int x;
    int y;
    int w;
    int h;
} isp_crop_t;

/* ISP node attributes */
typedef struct {
    int               input_mode;
    isp_sensor_mode_t sensor_mode;
    isp_crop_t        crop;
} isp_attr_t;

/* ISP input channel attributes */
typedef struct {
    int      width;
    int      height;
    frm_fmt_t fmt;
    int      bit_width;
} isp_ichn_attr_t;

/* ISP output channel attributes */
typedef struct {
    int      ddr_en;
    frm_fmt_t fmt;
    int      bit_width;
} isp_ochn_attr_t;

#endif /* ISP_CFG_H */
