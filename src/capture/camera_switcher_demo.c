/**
 * camera_switcher_demo.c
 *
 * Lightweight interactive demo for CameraSwitchController.
 * No vendor SDK dependencies; uses stdin to feed brightness samples
 * and debug commands to exercise switching + warmup + double buffering.
 *
 * Usage:
 *   make switcher-demo
 *   ./build/camera_switcher_demo
 *
 * Commands (stdin):
 *   day <value>    - record brightness sample for day camera
 *   night <value>  - record brightness sample for night camera
 *   auto           - resume automatic switching
 *   manual day     - force day camera
 *   manual night   - force night camera
 *   status         - print controller status
 *   quit           - exit
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "camera_switcher.h"
#include "shared_memory.h"

static int publish_stub(const Frame* frame, void* user_data) {
    (void)user_data;
    printf("[publish] camera_id=%d frame_number=%llu size=%zu\n",
           frame->camera_id,
           (unsigned long long)frame->frame_number,
           frame->data_size);
    return 0;
}

static void print_status(const CameraSwitchController* ctrl) {
    SwitchMode mode;
    CameraMode active;
    BrightnessStat stats[2];
    char reason[64];
    camera_switcher_get_status(ctrl, &mode, &active, stats, reason, sizeof(reason));

    printf("[status] mode=%s active=%s reason=%s\n",
           mode == SWITCH_MODE_AUTO ? "auto" : "manual",
           active == CAMERA_MODE_DAY ? "day" : "night",
           reason);
    printf("         day: latest=%.1f avg=%.1f samples=%d\n",
           stats[0].latest_value, stats[0].avg, stats[0].samples);
    printf("         night: latest=%.1f avg=%.1f samples=%d\n",
           stats[1].latest_value, stats[1].avg, stats[1].samples);
}

int main(void) {
    CameraSwitchConfig cfg = {
        .day_to_night_threshold = 40.0,
        .night_to_day_threshold = 70.0,
        .day_to_night_hold_seconds = 10.0,
        .night_to_day_hold_seconds = 10.0,
        .warmup_frames = 3,
    };

    CameraSwitchController ctrl;
    camera_switcher_init(&ctrl, &cfg);
    printf("=== Camera Switcher Demo (C) ===\n");
    printf("Commands: day <v>, night <v>, manual day, manual night, auto, status, quit\n");

    char line[128];
    unsigned long long frame_num = 0;

    while (fgets(line, sizeof(line), stdin)) {
        if (strncmp(line, "quit", 4) == 0) {
            break;
        } else if (strncmp(line, "status", 6) == 0) {
            print_status(&ctrl);
            continue;
        } else if (strncmp(line, "auto", 4) == 0) {
            camera_switcher_resume_auto(&ctrl);
            printf("[cmd] auto mode\n");
            continue;
        } else if (strncmp(line, "manual", 6) == 0) {
            if (strstr(line, "day")) {
                camera_switcher_force_manual(&ctrl, CAMERA_MODE_DAY);
                printf("[cmd] manual day\n");
            } else if (strstr(line, "night")) {
                camera_switcher_force_manual(&ctrl, CAMERA_MODE_NIGHT);
                printf("[cmd] manual night\n");
            } else {
                printf("[warn] specify 'day' or 'night'\n");
            }
            continue;
        }

        char cam[16];
        double value = 0.0;
        if (sscanf(line, "%15s %lf", cam, &value) == 2) {
            CameraMode cam_id;
            if (strcmp(cam, "day") == 0) {
                cam_id = CAMERA_MODE_DAY;
            } else if (strcmp(cam, "night") == 0) {
                cam_id = CAMERA_MODE_NIGHT;
            } else {
                printf("[warn] unknown camera '%s'\n", cam);
                continue;
            }

            Frame* frame = calloc(1, sizeof(Frame));
            if (!frame) {
                printf("[error] failed to allocate frame\n");
                continue;
            }
            frame->camera_id = cam_id;
            frame->frame_number = ++frame_num;
            frame->width = 320;
            frame->height = 240;
            frame->format = 1;  // NV12
            frame->data_size = (size_t)frame->width * (size_t)frame->height * 3 / 2;
            if (frame->data_size > sizeof(frame->data)) {
                frame->data_size = sizeof(frame->data);
            }
            memset(frame->data, (uint8_t)value, (size_t)frame->width * (size_t)frame->height);  // Y plane
            memset(frame->data + (size_t)frame->width * (size_t)frame->height, 128,
                   frame->data_size - (size_t)frame->width * (size_t)frame->height);  // UV

            CameraSwitchDecision decision =
                camera_switcher_handle_frame(&ctrl,
                                             frame,
                                             cam_id,
                                             cam_id == ctrl.active_camera,
                                             publish_stub,
                                             NULL);

            if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
                printf("[decision] switch to DAY\n");
                camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_DAY, "auto-day");
            } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
                printf("[decision] switch to NIGHT\n");
                camera_switcher_notify_active_camera(&ctrl, CAMERA_MODE_NIGHT, "auto-night");
            }
            free(frame);
        } else {
            printf("[warn] unrecognized command\n");
        }
    }

    printf("Bye\n");
    camera_switcher_destroy(&ctrl);
    return 0;
}
