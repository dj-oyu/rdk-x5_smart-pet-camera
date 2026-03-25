/*
 * nano2D Letterbox Visual Verification
 * Produces NV12 output files for correctness check
 * Also tests VSE → nano2D pipeline integration
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "GC820/nano2D.h"
#include "hbn_api.h"
#include "hb_mem_mgr.h"
#include "vse_cfg.h"
#include "cam_def.h"

// Save NV12 buffer to file for verification
static void save_n2d_nv12(const char *path, n2d_buffer_t *buf, int w, int h) {
    FILE *f = fopen(path, "wb");
    if (!f) { printf("Cannot write %s\n", path); return; }
    // n2d buffers may have stride != width
    uint8_t *base = (uint8_t*)buf->memory;
    // Y plane
    for (int y = 0; y < h; y++)
        fwrite(base + y * buf->stride, 1, w, f);
    // UV plane (NV12: interleaved, half height)
    // UV starts after Y (stride * height for Y plane in n2d)
    uint8_t *uv = base + buf->stride * buf->alignedh;
    for (int y = 0; y < h/2; y++)
        fwrite(uv + y * buf->stride, 1, w, f);
    fclose(f);
    printf("  Saved %s (%dx%d)\n", path, w, h);
}

static void save_hbmem_nv12(const char *path, hb_mem_graphic_buf_t *buf, int w, int h) {
    FILE *f = fopen(path, "wb");
    if (!f) { printf("Cannot write %s\n", path); return; }
    if (buf->virt_addr[0]) fwrite(buf->virt_addr[0], 1, w * h, f);
    if (buf->virt_addr[1]) fwrite(buf->virt_addr[1], 1, w * h / 2, f);
    fclose(f);
    printf("  Saved %s (%dx%d)\n", path, w, h);
}

// Create n2d buffer and wrap hbmem graphic buffer into it
// Returns 0 on success
static int wrap_hbmem_to_n2d(hb_mem_graphic_buf_t *hb, n2d_buffer_t *n2d, int w, int h) {
    memset(n2d, 0, sizeof(*n2d));
    // Use n2d_wrap to wrap existing physical memory
    n2d_error_t err = n2d_util_allocate_buffer(w, h, N2D_NV12, N2D_0,
                                                N2D_LINEAR, N2D_TSC_DISABLE, n2d);
    if (N2D_IS_ERROR(err)) return -1;
    // Copy data from hbmem to n2d buffer
    uint8_t *dst_y = (uint8_t*)n2d->memory;
    for (int y = 0; y < h; y++)
        memcpy(dst_y + y * n2d->stride, (uint8_t*)hb->virt_addr[0] + y * w, w);
    uint8_t *dst_uv = dst_y + n2d->stride * n2d->alignedh;
    for (int y = 0; y < h/2; y++)
        memcpy(dst_uv + y * n2d->stride, (uint8_t*)hb->virt_addr[1] + y * w, w);
    return 0;
}

// nano2D letterbox: src (WxH) → dst (640x640) with black bars
static n2d_error_t n2d_letterbox(n2d_buffer_t *dst, n2d_buffer_t *src,
                                  int src_w, int src_h, int dst_size) {
    int pad_top = (dst_size - (src_h * dst_size / src_w)) / 2;
    int scaled_h = src_h * dst_size / src_w;
    if (scaled_h > dst_size) { scaled_h = dst_size; pad_top = 0; }

    // Fill black
    n2d_error_t err = n2d_fill(dst, N2D_NULL, 0x00108080, N2D_BLEND_NONE);
    // 0x00108080 = NV12 black: Y=16(studio black), U=128, V=128
    if (N2D_IS_ERROR(err)) return err;

    // Blit source into center (aspect-preserving resize + position)
    n2d_rectangle_t dst_rect = { .x = 0, .y = pad_top, .width = dst_size, .height = scaled_h };
    err = n2d_blit(dst, &dst_rect, src, N2D_NULL, N2D_BLEND_NONE);
    if (N2D_IS_ERROR(err)) return err;

    return n2d_commit();
}

int main() {
    int ret;
    printf("=== Part 1: nano2D Letterbox Visual Verification ===\n\n");

    // --- nano2D init ---
    n2d_error_t nerr = n2d_open();
    if (N2D_IS_ERROR(nerr)) { printf("n2d_open failed: %d\n", nerr); return 1; }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    // Load real NV12 test image (1280x720)
    int orig_w = 1280, orig_h = 720;
    n2d_buffer_t orig_buf = {0};
    nerr = n2d_util_allocate_buffer(orig_w, orig_h, N2D_NV12, N2D_0,
                                     N2D_LINEAR, N2D_TSC_DISABLE, &orig_buf);
    if (N2D_IS_ERROR(nerr)) { printf("alloc orig failed\n"); goto n2d_close; }

    // Load from file
    {
        FILE *f = fopen("/app/multimedia_samples/sample_codec/1280x720_NV12.yuv", "rb");
        if (f) {
            uint8_t *base = (uint8_t*)orig_buf.memory;
            // Read Y plane row by row (handle stride)
            for (int y = 0; y < orig_h; y++)
                fread(base + y * orig_buf.stride, 1, orig_w, f);
            // Read UV plane
            uint8_t *uv = base + orig_buf.stride * orig_buf.alignedh;
            for (int y = 0; y < orig_h/2; y++)
                fread(uv + y * orig_buf.stride, 1, orig_w, f);
            fclose(f);
            printf("Loaded 1280x720 NV12 source\n");
        } else {
            printf("Cannot open source, using blank\n");
        }
    }

    // --- Test A: 1280x720 → 640x360 (downscale) → letterbox 640x640 ---
    printf("\n--- Test A: 1280x720 → 640x360 → letterbox 640x640 ---\n");
    {
        // Step 1: Downscale to 640x360
        n2d_buffer_t scaled = {0};
        n2d_util_allocate_buffer(640, 360, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &scaled);
        n2d_blit(&scaled, N2D_NULL, &orig_buf, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
        save_n2d_nv12("/tmp/vse_n2d_test/01_scaled_640x360.yuv", &scaled, 640, 360);

        // Step 2: Letterbox to 640x640
        n2d_buffer_t letterboxed = {0};
        n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &letterboxed);
        n2d_letterbox(&letterboxed, &scaled, 640, 360, 640);
        save_n2d_nv12("/tmp/vse_n2d_test/02_letterbox_640x640.yuv", &letterboxed, 640, 640);

        n2d_free(&scaled);
        n2d_free(&letterboxed);
    }

    // --- Test B: 1280x720 → letterbox 640x640 (one-shot scale+letterbox) ---
    printf("\n--- Test B: 1280x720 → 640x640 letterbox (one-shot) ---\n");
    {
        n2d_buffer_t lb = {0};
        n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &lb);
        n2d_letterbox(&lb, &orig_buf, orig_w, orig_h, 640);
        save_n2d_nv12("/tmp/vse_n2d_test/03_oneshot_640x640.yuv", &lb, 640, 640);
        n2d_free(&lb);
    }

    // --- Test C: ROI crop (left third of 1280x720) → letterbox 640x640 ---
    printf("\n--- Test C: ROI crop 427x720 → letterbox 640x640 ---\n");
    {
        // Crop left third
        n2d_buffer_t cropped = {0};
        n2d_util_allocate_buffer(428, 720, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &cropped);
        n2d_rectangle_t src_roi = {0, 0, 428, 720};
        n2d_blit(&cropped, N2D_NULL, &orig_buf, &src_roi, N2D_BLEND_NONE);
        n2d_commit();
        save_n2d_nv12("/tmp/vse_n2d_test/04_roi_crop_428x720.yuv", &cropped, 428, 720);

        // Letterbox: 428x720 → 640x640 (tall image, pad left/right)
        n2d_buffer_t lb = {0};
        n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &lb);
        // For tall image: scale height to 640, width = 428*640/720 = 380
        int scaled_w = 428 * 640 / 720;
        int pad_left = (640 - scaled_w) / 2;
        n2d_fill(&lb, N2D_NULL, 0x00108080, N2D_BLEND_NONE);
        n2d_rectangle_t dst_rect = {pad_left, 0, scaled_w, 640};
        n2d_blit(&lb, &dst_rect, &cropped, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
        save_n2d_nv12("/tmp/vse_n2d_test/05_roi_letterbox_640x640.yuv", &lb, 640, 640);

        n2d_free(&cropped);
        n2d_free(&lb);
    }

    n2d_free(&orig_buf);

    // === Part 2: VSE multi-channel → nano2D letterbox pipeline ===
    printf("\n=== Part 2: VSE → nano2D Letterbox Pipeline ===\n\n");

    // VSE setup
    hbn_vnode_handle_t vse_h;
    ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &vse_h);
    if (ret != 0) { printf("VSE open failed: %d\n", ret); goto n2d_close; }

    vse_attr_t va = {0};
    hbn_vnode_set_attr(vse_h, &va);

    int input_w = 1920, input_h = 1080;
    vse_ichn_attr_t ic = {0};
    ic.width = input_w; ic.height = input_h;
    ic.fmt = FRM_FMT_NV12; ic.bit_width = 8;
    ret = hbn_vnode_set_ichn_attr(vse_h, 0, &ic);
    if (ret != 0) { printf("VSE ichn failed: %d\n", ret); goto vse_close; }

    // Channel configs
    struct { int tw, th, rx, ry, rw, rh; const char *name; } chcfg[] = {
        {640, 360, 0, 0, 1920, 1080, "day-scaled"},       // Ch0: full→640x360
        {640, 480, 0, 0, 960,  720,  "night-roi0"},        // Ch1: left crop→640x480
        {640, 480, 480,180, 960, 720, "night-roi1"},        // Ch2: center crop→640x480
        {640, 480, 960,0, 960, 720,  "night-roi2"},         // Ch3: right crop→640x480
    };
    int nch = sizeof(chcfg)/sizeof(chcfg[0]);

    hbn_buf_alloc_attr_t ba = {0};
    ba.buffers_num = 8; ba.is_contig = 1;
    ba.flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN;

    int active = 0;
    for (int i = 0; i < nch; i++) {
        vse_ochn_attr_t oa = {0};
        oa.chn_en = CAM_TRUE;
        oa.roi.x = chcfg[i].rx; oa.roi.y = chcfg[i].ry;
        oa.roi.w = chcfg[i].rw; oa.roi.h = chcfg[i].rh;
        oa.target_w = chcfg[i].tw; oa.target_h = chcfg[i].th;
        oa.fmt = FRM_FMT_NV12; oa.bit_width = 8;
        ret = hbn_vnode_set_ochn_attr(vse_h, i, &oa);
        if (ret != 0) { printf("  Ch%d [%s] ochn FAILED: %d\n", i, chcfg[i].name, ret); continue; }
        ret = hbn_vnode_set_ochn_buf_attr(vse_h, i, &ba);
        if (ret != 0) { printf("  Ch%d buf FAILED: %d\n", i, ret); continue; }
        printf("  Ch%d [%s]: %dx%d OK\n", i, chcfg[i].name, chcfg[i].tw, chcfg[i].th);
        active++;
    }
    // Disable unused channels
    for (int i = nch; i < VSE_OCHN_MAX; i++) {
        vse_ochn_attr_t oa = {0};
        oa.chn_en = CAM_FALSE;
        oa.roi.w = input_w; oa.roi.h = input_h;
        oa.target_w = input_w; oa.target_h = input_h;
        oa.fmt = FRM_FMT_NV12; oa.bit_width = 8;
        hbn_vnode_set_ochn_attr(vse_h, i, &oa);
        hbn_vnode_set_ochn_buf_attr(vse_h, i, &ba);
    }

    // Start vflow
    hbn_vflow_handle_t vflow;
    ret = hbn_vflow_create(&vflow);
    if (ret != 0) { printf("vflow create: %d\n", ret); goto vse_close; }
    hbn_vflow_add_vnode(vflow, vse_h);
    ret = hbn_vflow_start(vflow);
    if (ret != 0) { printf("vflow start: %d\n", ret); goto vflow_destroy; }

    // Allocate input
    hb_mem_graphic_buf_t ibuf = {0};
    ret = hb_mem_alloc_graph_buf(input_w, input_h, MEM_PIX_FMT_NV12,
            HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN, 0, 0, &ibuf);
    if (ret != 0) { printf("input alloc: %d\n", ret); goto vflow_stop; }

    // Load 1920x1080 test file or generate gradient
    {
        FILE *f = fopen("/app/multimedia_samples/sample_codec/1920x1080_NV12.yuv", "rb");
        if (f) {
            fread(ibuf.virt_addr[0], 1, input_w * input_h, f);
            fread(ibuf.virt_addr[1], 1, input_w * input_h / 2, f);
            fclose(f);
            printf("\nLoaded 1920x1080 NV12 source\n");
        } else {
            // Generate gradient
            uint8_t *y = ibuf.virt_addr[0];
            for (int r = 0; r < input_h; r++)
                for (int c = 0; c < input_w; c++)
                    y[r*input_w+c] = (uint8_t)((r*200/input_h + c*55/input_w) & 0xFF);
            memset(ibuf.virt_addr[1], 128, input_w*input_h/2);
            printf("\nGenerated gradient test pattern\n");
        }
    }

    // Send 1 frame through VSE, get all channel outputs, letterbox each with nano2D
    printf("\nSending frame through VSE → nano2D letterbox...\n");
    {
        hbn_vnode_image_t in_img = {0};
        in_img.buffer = ibuf;
        in_img.info.frame_id = 0;
        ret = hbn_vnode_sendframe(vse_h, 0, &in_img);
        if (ret != 0) { printf("sendframe: %d\n", ret); goto free_ibuf; }

        for (int i = 0; i < nch; i++) {
            hbn_vnode_image_t out = {0};
            ret = hbn_vnode_getframe(vse_h, i, 2000, &out);
            if (ret != 0) { printf("  Ch%d getframe: %d\n", i, ret); continue; }

            int ow = out.buffer.width, oh = out.buffer.height;
            printf("  Ch%d [%s]: VSE output %dx%d\n", i, chcfg[i].name, ow, oh);

            // Save VSE raw output
            char fname[128];
            snprintf(fname, sizeof(fname), "/tmp/vse_n2d_test/10_vse_ch%d_%dx%d.yuv", i, ow, oh);
            save_hbmem_nv12(fname, &out.buffer, ow, oh);

            // Copy VSE output to nano2D buffer
            n2d_buffer_t n2d_src = {0};
            if (wrap_hbmem_to_n2d(&out.buffer, &n2d_src, ow, oh) == 0) {
                // Letterbox to 640x640
                n2d_buffer_t n2d_dst = {0};
                n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0,
                                          N2D_LINEAR, N2D_TSC_DISABLE, &n2d_dst);
                n2d_letterbox(&n2d_dst, &n2d_src, ow, oh, 640);

                snprintf(fname, sizeof(fname), "/tmp/vse_n2d_test/11_lb_ch%d_640x640.yuv", i);
                save_n2d_nv12(fname, &n2d_dst, 640, 640);

                n2d_free(&n2d_dst);
                n2d_free(&n2d_src);
            }

            hbn_vnode_releaseframe(vse_h, i, &out);
        }
    }

    // Benchmark: VSE → nano2D letterbox pipeline throughput
    printf("\n--- Pipeline Benchmark: VSE 4ch → nano2D letterbox ---\n");
    {
        int bench_frames = 30;
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);

        for (int f = 0; f < bench_frames; f++) {
            hbn_vnode_image_t in_img = {0};
            in_img.buffer = ibuf;
            in_img.info.frame_id = f;
            hbn_vnode_sendframe(vse_h, 0, &in_img);

            for (int i = 0; i < nch; i++) {
                hbn_vnode_image_t out = {0};
                ret = hbn_vnode_getframe(vse_h, i, 2000, &out);
                if (ret != 0) continue;

                int ow = out.buffer.width, oh = out.buffer.height;

                // nano2D letterbox
                n2d_buffer_t ns = {0}, nd = {0};
                if (wrap_hbmem_to_n2d(&out.buffer, &ns, ow, oh) == 0) {
                    n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0,
                                              N2D_LINEAR, N2D_TSC_DISABLE, &nd);
                    n2d_letterbox(&nd, &ns, ow, oh, 640);
                    n2d_free(&nd);
                    n2d_free(&ns);
                }

                hbn_vnode_releaseframe(vse_h, i, &out);
            }
        }

        clock_gettime(CLOCK_MONOTONIC, &t1);
        double sec = (t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
        printf("  %d frames × %d ch in %.2fs → %.1f fps (%.2f ms/frame)\n",
               bench_frames, active, sec, bench_frames/sec, sec*1000/bench_frames);
        printf("  Per-channel letterbox: %.2f ms\n", sec*1000/bench_frames/active);
    }

free_ibuf:
    hb_mem_free_buf(ibuf.fd[0]);
vflow_stop:
    hbn_vflow_stop(vflow);
vflow_destroy:
    hbn_vflow_destroy(vflow);
vse_close:
    hbn_vnode_close(vse_h);
n2d_close:
    n2d_close();
    printf("\n=== Done ===\n");
    return 0;
}
