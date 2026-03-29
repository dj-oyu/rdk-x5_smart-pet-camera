/*
 * vse_cfg.h - IDE STUB ONLY (D-Robotics RDK-X5 VSE config types)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef VSE_CFG_H
#define VSE_CFG_H

#include <stdint.h>
#include "isp_cfg.h"  /* frm_fmt_t */

typedef enum {
    CAM_FALSE = 0,
    CAM_TRUE  = 1,
} cam_bool_t;

/* ROI region */
typedef struct {
    int x;
    int y;
    int w;
    int h;
} vse_roi_t;

/* VSE node attributes (zero-init, no configurable fields used in project) */
typedef struct {
    int reserved;
} vse_attr_t;

/* VSE input channel attributes */
typedef struct {
    int       width;
    int       height;
    frm_fmt_t fmt;
    int       bit_width;
} vse_ichn_attr_t;

/* VSE output channel attributes */
typedef struct {
    cam_bool_t chn_en;
    vse_roi_t  roi;
    int        target_w;
    int        target_h;
    frm_fmt_t  fmt;
    int        bit_width;
} vse_ochn_attr_t;

#endif /* VSE_CFG_H */
