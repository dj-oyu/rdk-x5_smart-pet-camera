/**
 * dump_layout.c - Emit offsetof()/sizeof() layout facts for the SHM structs
 * defined in src/capture/shared_memory.h, as machine-readable JSON on
 * stdout.
 *
 * This is a standalone introspection tool, NOT part of the capture daemon
 * build (see src/capture/Makefile) — it is compiled on demand by
 * scripts/check_shm_layout.py into a scratch directory and never linked
 * into camera_daemon_drobotics. It only reads compile-time type layout; it
 * never touches /dev/shm and has no runtime SHM dependency at all.
 *
 * Output shape:
 * {
 *   "structs": [
 *     {
 *       "name": "<C tag used by scripts/check_shm_layout.py's mapping>",
 *       "sizeof": <int>,
 *       "fields": [ {"name": "<field>", "offset": <int>, "size": <int>}, ... ]
 *     },
 *     ...
 *   ]
 * }
 *
 * Build flags MUST match src/capture/Makefile's CFLAGS/CPPFLAGS so that any
 * ABI-affecting macro (e.g. _GNU_SOURCE altering <semaphore.h>) is
 * identical to what the real daemon compiles against.
 * scripts/check_shm_layout.py extracts those flags from the Makefile itself
 * rather than hardcoding a second copy.
 */

#include <stdio.h>
#include <stddef.h>

#include "shared_memory.h"

/* One row: field name, offset within its enclosing struct, byte size. */
struct field_row {
    const char *name;
    size_t offset;
    size_t size;
};

#define FIELD(struct_type, field_name) \
    { #field_name, offsetof(struct_type, field_name), sizeof(((struct_type *)0)->field_name) }

static void print_struct(const char *name, size_t struct_size,
                          const struct field_row *fields, size_t nfields,
                          int is_last) {
    size_t i;
    printf("    {\n");
    printf("      \"name\": \"%s\",\n", name);
    printf("      \"sizeof\": %zu,\n", struct_size);
    printf("      \"fields\": [\n");
    for (i = 0; i < nfields; i++) {
        printf("        {\"name\": \"%s\", \"offset\": %zu, \"size\": %zu}%s\n",
               fields[i].name, fields[i].offset, fields[i].size,
               (i + 1 < nfields) ? "," : "");
    }
    printf("      ]\n");
    printf("    }%s\n", is_last ? "" : ",");
}

int main(void) {
    /* struct timespec (time.h) — mirrored by Python's CTimespec. */
    static const struct field_row timespec_fields[] = {
        FIELD(struct timespec, tv_sec),
        FIELD(struct timespec, tv_nsec),
    };

    /* ZeroCopyFrame — mirrored by Python's CZeroCopyFrame. */
    static const struct field_row zerocopyframe_fields[] = {
        FIELD(ZeroCopyFrame, frame_number),
        FIELD(ZeroCopyFrame, timestamp),
        FIELD(ZeroCopyFrame, camera_id),
        FIELD(ZeroCopyFrame, width),
        FIELD(ZeroCopyFrame, height),
        FIELD(ZeroCopyFrame, brightness_avg),
        FIELD(ZeroCopyFrame, share_id),
        FIELD(ZeroCopyFrame, plane_size),
        FIELD(ZeroCopyFrame, plane_cnt),
        FIELD(ZeroCopyFrame, hb_mem_buf_data),
        FIELD(ZeroCopyFrame, version),
    };

    /* ZeroCopyFrameBuffer — mirrored by Python's CZeroCopyFrameBuffer. */
    static const struct field_row zerocopyframebuffer_fields[] = {
        FIELD(ZeroCopyFrameBuffer, new_frame_sem),
        FIELD(ZeroCopyFrameBuffer, frame),
    };

    /* DetectionBBox — mirrored by Python's CBoundingBox. */
    static const struct field_row detectionbbox_fields[] = {
        FIELD(DetectionBBox, x),
        FIELD(DetectionBBox, y),
        FIELD(DetectionBBox, w),
        FIELD(DetectionBBox, h),
    };

    /* DetectionEntry — mirrored by Python's CDetection. */
    static const struct field_row detectionentry_fields[] = {
        FIELD(DetectionEntry, class_name),
        FIELD(DetectionEntry, confidence),
        FIELD(DetectionEntry, bbox),
    };

    /* LatestDetectionResult — mirrored by Python's CLatestDetectionResult. */
    static const struct field_row latestdetectionresult_fields[] = {
        FIELD(LatestDetectionResult, frame_number),
        FIELD(LatestDetectionResult, timestamp),
        FIELD(LatestDetectionResult, num_detections),
        FIELD(LatestDetectionResult, detections),
        FIELD(LatestDetectionResult, version),
        FIELD(LatestDetectionResult, detection_update_sem),
    };

    /* H265ZeroCopyFrame — mirrored by Python's CH265ZeroCopyFrame. */
    static const struct field_row h265zerocopyframe_fields[] = {
        FIELD(H265ZeroCopyFrame, frame_number),
        FIELD(H265ZeroCopyFrame, timestamp),
        FIELD(H265ZeroCopyFrame, camera_id),
        FIELD(H265ZeroCopyFrame, width),
        FIELD(H265ZeroCopyFrame, height),
        FIELD(H265ZeroCopyFrame, data_size),
        FIELD(H265ZeroCopyFrame, hb_mem_buf_data),
        FIELD(H265ZeroCopyFrame, version),
    };

    /* H265ZeroCopyBuffer — mirrored by Python's CH265ZeroCopyBuffer. */
    static const struct field_row h265zerocopybuffer_fields[] = {
        FIELD(H265ZeroCopyBuffer, new_frame_sem),
        FIELD(H265ZeroCopyBuffer, consumed_sem),
        FIELD(H265ZeroCopyBuffer, frame),
    };

    printf("{\n");
    printf("  \"structs\": [\n");

    print_struct("timespec", sizeof(struct timespec),
                 timespec_fields,
                 sizeof(timespec_fields) / sizeof(timespec_fields[0]), 0);
    print_struct("ZeroCopyFrame", sizeof(ZeroCopyFrame),
                 zerocopyframe_fields,
                 sizeof(zerocopyframe_fields) / sizeof(zerocopyframe_fields[0]), 0);
    print_struct("ZeroCopyFrameBuffer", sizeof(ZeroCopyFrameBuffer),
                 zerocopyframebuffer_fields,
                 sizeof(zerocopyframebuffer_fields) / sizeof(zerocopyframebuffer_fields[0]), 0);
    print_struct("DetectionBBox", sizeof(DetectionBBox),
                 detectionbbox_fields,
                 sizeof(detectionbbox_fields) / sizeof(detectionbbox_fields[0]), 0);
    print_struct("DetectionEntry", sizeof(DetectionEntry),
                 detectionentry_fields,
                 sizeof(detectionentry_fields) / sizeof(detectionentry_fields[0]), 0);
    print_struct("LatestDetectionResult", sizeof(LatestDetectionResult),
                 latestdetectionresult_fields,
                 sizeof(latestdetectionresult_fields) / sizeof(latestdetectionresult_fields[0]), 0);
    print_struct("H265ZeroCopyFrame", sizeof(H265ZeroCopyFrame),
                 h265zerocopyframe_fields,
                 sizeof(h265zerocopyframe_fields) / sizeof(h265zerocopyframe_fields[0]), 0);
    print_struct("H265ZeroCopyBuffer", sizeof(H265ZeroCopyBuffer),
                 h265zerocopybuffer_fields,
                 sizeof(h265zerocopybuffer_fields) / sizeof(h265zerocopybuffer_fields[0]), 1);

    printf("  ]\n");
    printf("}\n");

    return 0;
}
