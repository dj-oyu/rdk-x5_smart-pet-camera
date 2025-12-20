/**
 * camera_switcher_runtime.c
 *
 * Orchestrates brightness-based camera switching with real capture callbacks.
 * - Active thread captures frames from the current camera at target interval
 * - Probe thread periodically samples the inactive camera for brightness
 * - Switch decisions call back into user-provided hardware switch routine
 */

#include "camera_switcher_runtime.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void sleep_seconds(double sec) {
    struct timespec ts;
    ts.tv_sec = (time_t)sec;
    ts.tv_nsec = (long)((sec - ts.tv_sec) * 1e9);
    nanosleep(&ts, NULL);
}

static int do_switch(CameraSwitchRuntime* rt, CameraMode target, const char* reason) {
    if (rt->active_camera == target) {
        return 0;
    }
    if (rt->ops.switch_camera) {
        rt->ops.switch_camera(target, rt->ops.user_data);
    }
    camera_switcher_notify_active_camera(&rt->controller, target, reason);
    rt->active_camera = target;
    return 0;
}

static void* active_thread_main(void* arg) {
    CameraSwitchRuntime* rt = (CameraSwitchRuntime*)arg;

    while (!rt->stop_flag) {
        Frame frame;
        memset(&frame, 0, sizeof(Frame));
        frame.camera_id = rt->active_camera;

        if (rt->ops.capture_frame &&
            rt->ops.capture_frame(rt->active_camera, &frame, rt->ops.user_data) == 0) {
            CameraSwitchDecision decision = camera_switcher_handle_frame(
                &rt->controller,
                &frame,
                rt->active_camera,
                true,
                rt->ops.publish_frame,
                rt->ops.user_data);

            if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
                do_switch(rt, CAMERA_MODE_DAY, "auto-day");
            } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
                do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
            }
        }

        sleep_seconds(rt->cfg.active_interval_sec);
    }

    return NULL;
}

static void* probe_thread_main(void* arg) {
    CameraSwitchRuntime* rt = (CameraSwitchRuntime*)arg;

    while (!rt->stop_flag) {
        CameraMode inactive = (rt->active_camera == CAMERA_MODE_DAY)
                                  ? CAMERA_MODE_NIGHT
                                  : CAMERA_MODE_DAY;

        Frame frame;
        memset(&frame, 0, sizeof(Frame));
        frame.camera_id = inactive;

        if (rt->ops.capture_frame &&
            rt->ops.capture_frame(inactive, &frame, rt->ops.user_data) == 0) {
            CameraSwitchDecision decision = camera_switcher_handle_frame(
                &rt->controller,
                &frame,
                inactive,
                false,
                NULL,
                NULL);

            if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
                do_switch(rt, CAMERA_MODE_DAY, "auto-day");
            } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
                do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
            }
        }

        sleep_seconds(rt->cfg.probe_interval_sec);
    }

    return NULL;
}

void camera_switch_runtime_init(CameraSwitchRuntime* rt,
                                const CameraSwitchConfig* ctrl_cfg,
                                const CameraSwitchRuntimeConfig* rt_cfg,
                                const CameraCaptureOps* ops,
                                CameraMode initial_camera) {
    memset(rt, 0, sizeof(*rt));
    CameraSwitchConfig cfg = *ctrl_cfg;
    CameraSwitchRuntimeConfig runtime_cfg = *rt_cfg;

    camera_switcher_init(&rt->controller, &cfg);
    rt->ops = *ops;
    rt->cfg = runtime_cfg;
    rt->active_camera = initial_camera;
    camera_switcher_notify_active_camera(&rt->controller, initial_camera, "init");
}

int camera_switch_runtime_start(CameraSwitchRuntime* rt) {
    rt->stop_flag = false;
    if (pthread_create(&rt->active_thread, NULL, active_thread_main, rt) != 0) {
        return -1;
    }
    if (pthread_create(&rt->probe_thread, NULL, probe_thread_main, rt) != 0) {
        rt->stop_flag = true;
        pthread_join(rt->active_thread, NULL);
        return -1;
    }
    return 0;
}

void camera_switch_runtime_stop(CameraSwitchRuntime* rt) {
    rt->stop_flag = true;
    pthread_join(rt->active_thread, NULL);
    pthread_join(rt->probe_thread, NULL);
    camera_switcher_destroy(&rt->controller);
}
