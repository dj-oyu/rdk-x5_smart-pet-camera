/*
 * vin_cfg.h - IDE STUB ONLY (D-Robotics RDK-X5 VIN config types)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef VIN_CFG_H
#define VIN_CFG_H

#include <stdint.h>

/* HDR modes */
typedef enum {
    NOT_HDR = 0,
    HDR_2X  = 1,
    HDR_3X  = 2,
} vin_hdr_mode_t;

/* VIN output channel attribute types */
typedef enum {
    VIN_BASIC_ATTR = 0,
} vin_ochn_attr_type_t;

/* CIM functional flags */
typedef struct {
    int enable_frame_id;
    int set_init_frame_id;
    vin_hdr_mode_t hdr_mode;
    int time_stamp_en;
} vin_cim_func_t;

/* CIM (Camera Input Module) attributes */
typedef struct {
    int mipi_rx;
    int vc_index;
    int ipi_channel;
    int cim_isp_flyby;
    vin_cim_func_t func;
} vin_cim_attr_t;

/* VIN node attributes */
typedef struct {
    vin_cim_attr_t cim_attr;
} vin_node_attr_t;

/* VIN input channel attributes */
typedef struct {
    int width;
    int height;
    int format;
} vin_ichn_attr_t;

/* VIN basic output channel attributes */
typedef struct {
    int format;
    int wstride;
} vin_basic_attr_t;

/* VIN output channel attributes */
typedef struct {
    int ddr_en;
    vin_ochn_attr_type_t ochn_attr_type;
    vin_basic_attr_t vin_basic_attr;
} vin_ochn_attr_t;

#endif /* VIN_CFG_H */
