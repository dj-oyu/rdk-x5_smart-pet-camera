/**
 * camera_switcher.c - Brightness-based camera switch controller (C)
 */

#include "camera_switcher.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <setjmp.h>
#include <jpeglib.h>

/**
 * Custom JPEG error manager that uses setjmp/longjmp for error handling
 * instead of exit() to gracefully handle JPEG errors.
 */
struct jpeg_error_mgr_ext {
    struct jpeg_error_mgr pub;  /* "public" fields */
    jmp_buf setjmp_buffer;      /* for return to caller */
};

/**
 * Custom error_exit function that replaces the default libjpeg error handler.
 * Instead of calling exit(), it longjmps back to the setjmp point.
 */
static void jpeg_error_exit(j_common_ptr cinfo) {
    /* cinfo->err really points to a jpeg_error_mgr_ext struct */
    struct jpeg_error_mgr_ext* myerr = (struct jpeg_error_mgr_ext*)cinfo->err;
    
    /* Always display the message (optional, can be removed for silent errors) */
    (*cinfo->err->output_message)(cinfo);
    
    /* Return control to the setjmp point */
    longjmp(myerr->setjmp_buffer, 1);
}

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void reset_stats(BrightnessStat* stat) {
    memset(stat, 0, sizeof(BrightnessStat));
    stat->latest_value = 0.0;
    stat->avg = 0.0;
    stat->samples = 0;
    stat->timestamp.tv_sec = 0;
    stat->timestamp.tv_nsec = 0;
}

void camera_switcher_init(CameraSwitchController* ctrl,
                          const CameraSwitchConfig* cfg) {
    if (!ctrl) {
        return;
    }
    memset(ctrl, 0, sizeof(*ctrl));
    ctrl->cfg = *cfg;
    ctrl->mode = SWITCH_MODE_AUTO;
    ctrl->active_camera = CAMERA_MODE_DAY;
    ctrl->manual_target = -1;
    ctrl->publisher.active_slot = 0;
    ctrl->publisher.warmup_remaining = 0;
    ctrl->publisher.buffers[0] = calloc(1, sizeof(Frame));
    ctrl->publisher.buffers[1] = calloc(1, sizeof(Frame));
    reset_stats(&ctrl->brightness[0]);
    reset_stats(&ctrl->brightness[1]);
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason), "init");
}

void camera_switcher_destroy(CameraSwitchController* ctrl) {
    if (!ctrl) {
        return;
    }
    free(ctrl->publisher.buffers[0]);
    free(ctrl->publisher.buffers[1]);
    ctrl->publisher.buffers[0] = NULL;
    ctrl->publisher.buffers[1] = NULL;
}

void camera_switcher_force_manual(CameraSwitchController* ctrl,
                                  CameraMode camera) {
    if (!ctrl) {
        return;
    }
    ctrl->mode = SWITCH_MODE_MANUAL;
    ctrl->manual_target = (camera == CAMERA_MODE_DAY) ? 0 : 1;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason),
             "manual-%s", camera == CAMERA_MODE_DAY ? "day" : "night");
}

void camera_switcher_resume_auto(CameraSwitchController* ctrl) {
    if (!ctrl) {
        return;
    }
    ctrl->mode = SWITCH_MODE_AUTO;
    ctrl->manual_target = -1;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason),
             "resume-auto");
}

static void update_brightness_stat(BrightnessStat* stat, double value) {
    double ts = now_seconds();
    struct timespec tval;
    tval.tv_sec = (time_t)ts;
    tval.tv_nsec = (long)((ts - tval.tv_sec) * 1e9);
    stat->latest_value = value;
    stat->samples += 1;
    if (stat->samples == 1) {
        stat->avg = value;
    } else {
        stat->avg = ((stat->avg * (stat->samples - 1)) + value) / stat->samples;
    }
    stat->timestamp = tval;
}

CameraSwitchDecision camera_switcher_record_brightness(CameraSwitchController* ctrl,
                                                       CameraMode camera,
                                                       double brightness) {
    if (!ctrl) {
        return CAMERA_SWITCH_DECISION_NONE;
    }

    update_brightness_stat(&ctrl->brightness[camera], brightness);

    if (ctrl->mode == SWITCH_MODE_MANUAL) {
        return CAMERA_SWITCH_DECISION_NONE;
    }

    double now = now_seconds();
    CameraSwitchDecision decision = CAMERA_SWITCH_DECISION_NONE;

    if (ctrl->active_camera == CAMERA_MODE_DAY) {
        if (brightness < ctrl->cfg.day_to_night_threshold) {
            if (ctrl->below_threshold_since < 0) {
                ctrl->below_threshold_since = now;
            }
            if ((now - ctrl->below_threshold_since) >= ctrl->cfg.day_to_night_hold_seconds) {
                decision = CAMERA_SWITCH_DECISION_TO_NIGHT;
            }
        } else {
            ctrl->below_threshold_since = -1.0;
        }
    } else {  // active is night
        if (brightness > ctrl->cfg.night_to_day_threshold) {
            if (ctrl->above_threshold_since < 0) {
                ctrl->above_threshold_since = now;
            }
            if ((now - ctrl->above_threshold_since) >= ctrl->cfg.night_to_day_hold_seconds) {
                decision = CAMERA_SWITCH_DECISION_TO_DAY;
            }
        } else {
            ctrl->above_threshold_since = -1.0;
        }
    }

    return decision;
}

double frame_calculate_mean_luma(const Frame* frame) {
    if (!frame || frame->data_size == 0) {
        return -1.0;
    }

    if (frame->format == 1) {  // NV12: Y plane first
        size_t expected = (size_t)frame->width * (size_t)frame->height * 3 / 2;
        if (frame->data_size < expected) {
            return -1.0;
        }
        const uint8_t* y_plane = frame->data;
        size_t y_size = (size_t)frame->width * (size_t)frame->height;
        double sum = 0.0;
        for (size_t i = 0; i < y_size; ++i) {
            sum += y_plane[i];
        }
        return sum / (double)y_size;
    } else if (frame->format == 2) {  // RGB
        size_t expected = (size_t)frame->width * (size_t)frame->height * 3;
        if (frame->data_size < expected) {
            return -1.0;
        }
        const uint8_t* rgb = frame->data;
        size_t pixels = (size_t)frame->width * (size_t)frame->height;
        double sum = 0.0;
        for (size_t i = 0; i < pixels; ++i) {
            uint8_t r = rgb[i * 3 + 0];
            uint8_t g = rgb[i * 3 + 1];
            uint8_t b = rgb[i * 3 + 2];
            sum += 0.299 * r + 0.587 * g + 0.114 * b;
        }
        return sum / (double)pixels;
    } else if (frame->format == 0) {  // JPEG
        struct jpeg_decompress_struct cinfo;
        struct jpeg_error_mgr_ext jerr;
        
        /* Set up the custom error handler */
        cinfo.err = jpeg_std_error(&jerr.pub);
        jerr.pub.error_exit = jpeg_error_exit;
        
        /* Initialize the JPEG decompress object before setjmp */
        jpeg_create_decompress(&cinfo);
        
        /* Establish the setjmp return context for jpeg_error_exit to use */
        if (setjmp(jerr.setjmp_buffer)) {
            /* If we get here, the JPEG code has signaled an error.
             * We need to clean up the JPEG object and return error. */
            jpeg_destroy_decompress(&cinfo);
            return -1.0;
        }
        
        jpeg_mem_src(&cinfo, frame->data, frame->data_size);
        /* jpeg_read_header will trigger error handler (longjmp) on failure */
        jpeg_read_header(&cinfo, TRUE);

        jpeg_start_decompress(&cinfo);
        
        /* Verify the JPEG is in RGB format (3 components) */
        if (cinfo.output_components != 3) {
            jpeg_destroy_decompress(&cinfo);
            return -1.0;
        }
        
        size_t row_stride = cinfo.output_width * cinfo.output_components;
        JSAMPARRAY buffer = (*cinfo.mem->alloc_sarray)(
            (j_common_ptr)&cinfo, JPOOL_IMAGE, row_stride, 1);

        double sum = 0.0;
        size_t pixels = (size_t)cinfo.output_width * (size_t)cinfo.output_height;

        while (cinfo.output_scanline < cinfo.output_height) {
            jpeg_read_scanlines(&cinfo, buffer, 1);
            for (size_t x = 0; x < cinfo.output_width; ++x) {
                uint8_t r = buffer[0][x * cinfo.output_components + 0];
                uint8_t g = buffer[0][x * cinfo.output_components + 1];
                uint8_t b = buffer[0][x * cinfo.output_components + 2];
                sum += 0.299 * r + 0.587 * g + 0.114 * b;
            }
        }

        jpeg_finish_decompress(&cinfo);
        jpeg_destroy_decompress(&cinfo);

        if (pixels == 0) {
            return -1.0;
        }
        return sum / (double)pixels;
    }

    return -1.0;
}

CameraSwitchDecision camera_switcher_handle_frame(CameraSwitchController* ctrl,
                                                  const Frame* frame,
                                                  CameraMode camera,
                                                  bool is_active_camera,
                                                  camera_publish_fn publish_cb,
                                                  void* user_data) {
    if (!ctrl || !frame) {
        return CAMERA_SWITCH_DECISION_NONE;
    }

    double brightness = frame_calculate_mean_luma(frame);
    CameraSwitchDecision decision = CAMERA_SWITCH_DECISION_NONE;
    if (brightness >= 0) {
        decision = camera_switcher_record_brightness(ctrl, camera, brightness);
    }

    if (is_active_camera && publish_cb) {
        camera_switcher_publish_frame(ctrl, frame, publish_cb, user_data);
    }

    return decision;
}

void camera_switcher_notify_active_camera(CameraSwitchController* ctrl,
                                          CameraMode camera,
                                          const char* reason) {
    if (!ctrl) {
        return;
    }
    ctrl->active_camera = camera;
    ctrl->publisher.warmup_remaining = ctrl->cfg.warmup_frames;
    ctrl->publisher.active_slot = 0;
    ctrl->below_threshold_since = -1.0;
    ctrl->above_threshold_since = -1.0;
    snprintf(ctrl->last_switch_reason, sizeof(ctrl->last_switch_reason),
             "%s", reason ? reason : "switch");
}

int camera_switcher_publish_frame(CameraSwitchController* ctrl,
                                  const Frame* frame,
                                  camera_publish_fn publish_cb,
                                  void* user_data) {
    if (!ctrl || !frame || !publish_cb) {
        return -1;
    }

    if (ctrl->publisher.warmup_remaining > 0) {
        ctrl->publisher.warmup_remaining--;
        return 0;  // drop warmup frames
    }

    int next_slot = 1 - ctrl->publisher.active_slot;
    if (!ctrl->publisher.buffers[next_slot]) {
        return -1;
    }
    memcpy(ctrl->publisher.buffers[next_slot], frame, sizeof(Frame));
    ctrl->publisher.active_slot = next_slot;

    return publish_cb(ctrl->publisher.buffers[next_slot], user_data);
}

void camera_switcher_get_status(const CameraSwitchController* ctrl,
                                SwitchMode* mode,
                                CameraMode* active,
                                BrightnessStat out_stats[2],
                                char* reason_buf,
                                size_t reason_buf_len) {
    if (!ctrl) {
        return;
    }
    if (mode) {
        *mode = ctrl->mode;
    }
    if (active) {
        *active = ctrl->active_camera;
    }
    if (out_stats) {
        out_stats[0] = ctrl->brightness[0];
        out_stats[1] = ctrl->brightness[1];
    }
    if (reason_buf && reason_buf_len > 0) {
        snprintf(reason_buf, reason_buf_len, "%s", ctrl->last_switch_reason);
    }
}
