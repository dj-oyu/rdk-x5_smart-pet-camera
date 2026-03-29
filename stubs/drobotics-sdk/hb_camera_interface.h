/*
 * hb_camera_interface.h - IDE STUB ONLY (D-Robotics RDK-X5 camera HAL)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef HB_CAMERA_INTERFACE_H
#define HB_CAMERA_INTERFACE_H

#include <stdint.h>
#include "hb_camera_data_config.h"

typedef int64_t camera_handle_t;

/* MIPI receiver attributes */
typedef struct {
    int phy;
    int lane;
    int datatype;
    int fps;
    int mclk;
    int mipiclk;
    int width;
    int height;
    int linelenth;
    int framelenth;
    int settle;
    int channel_num;
    int channel_sel[4];
} mipi_rx_attr_t;

typedef struct {
    int stop_check_instart;
} mipi_rx_attr_ex_t;

typedef struct {
    int          rx_enable;
    mipi_rx_attr_t rx_attr;
    int          rx_ex_mask;
    mipi_rx_attr_ex_t rx_attr_ex;
} mipi_config_t;

/* Camera configuration */
typedef struct {
    const char  *name;
    int          addr;
    int          isp_addr;
    int          eeprom_addr;
    int          serial_addr;
    int          sensor_mode;
    int          sensor_clk;
    int          gpio_enable_bit;
    int          gpio_level_bit;
    int          bus_select;
    int          bus_timeout;
    int          fps;
    int          width;
    int          height;
    int          format;
    int          flags;
    int          extra_mode;
    int          config_index;
    int          ts_compensate;
    mipi_config_t *mipi_cfg;
    const char  *calib_lname;
    void        *sensor_param;
    int          iparam_mode;
    int          end_flag;
} camera_config_t;

#endif /* HB_CAMERA_INTERFACE_H */
