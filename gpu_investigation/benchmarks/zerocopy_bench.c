/*
 * VSE → nano2D Zero-Copy Letterbox Benchmark
 * Uses n2d_wrap() to directly map hbmem physical address → no memcpy
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"
#include "hbn_api.h"
#include "hb_mem_mgr.h"
#include "vse_cfg.h"
#include "cam_def.h"

// Zero-copy: wrap hbmem physical address into n2d_buffer_t
static n2d_error_t wrap_hbmem_zerocopy(n2d_buffer_t *n2d, hb_mem_graphic_buf_t *hb) {
    n2d_error_t error;
    memset(n2d, 0, sizeof(*n2d));
    n2d->width = hb->width;
    n2d->height = hb->height;
    n2d->format = N2D_NV12;
    n2d->orientation = N2D_0;
    n2d->srcType = N2D_SOURCE_DEFAULT;
    n2d->tiling = N2D_LINEAR;
    n2d->cacheMode = N2D_CACHE_128;
    n2d->alignedw = gcmALIGN(n2d->width, 64);
    n2d->alignedh = n2d->height;
    float nv12_bpp = gcmALIGN(16, 8) * 1.0f / 8;
    n2d->stride = gcmALIGN((int)(n2d->alignedw * nv12_bpp), 64);

    n2d_uintptr_t handle;
    n2d_user_memory_desc_t desc;
    desc.flag = N2D_WRAP_FROM_USERMEMORY;
    desc.logical = 0;  // MUST BE ZERO
    desc.physical = (n2d_uintptr_t)hb->phys_addr[0];
    desc.size = n2d->stride * n2d->alignedh * 3 / 2;
    error = n2d_wrap(&desc, &handle);
    if (N2D_IS_ERROR(error)) return error;
    n2d->handle = handle;
    error = n2d_map(n2d);
    return error;
}

static n2d_error_t n2d_letterbox(n2d_buffer_t *dst, n2d_buffer_t *src,
                                  int src_w, int src_h, int dst_size) {
    float scale = (float)dst_size / (src_w > src_h ? src_w : src_h);
    int sw = (int)(src_w * scale), sh = (int)(src_h * scale);
    int px = (dst_size - sw) / 2, py = (dst_size - sh) / 2;
    n2d_fill(dst, N2D_NULL, 0x00108080, N2D_BLEND_NONE);
    n2d_rectangle_t dr = {px, py, sw, sh};
    n2d_blit(dst, &dr, src, N2D_NULL, N2D_BLEND_NONE);
    return n2d_commit();
}

int main() {
    int ret, input_w = 1920, input_h = 1080;
    printf("=== Zero-Copy VSE → nano2D Letterbox Benchmark ===\n\n");

    n2d_open();
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    // VSE setup (4 channels)
    hbn_vnode_handle_t vse_h;
    hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &vse_h);
    vse_attr_t va = {0};
    hbn_vnode_set_attr(vse_h, &va);
    vse_ichn_attr_t ic = {.width=input_w, .height=input_h, .fmt=FRM_FMT_NV12, .bit_width=8};
    hbn_vnode_set_ichn_attr(vse_h, 0, &ic);

    struct { int tw,th,rx,ry,rw,rh; const char *name; } cfg[] = {
        {640, 360, 0, 0, 1920, 1080, "day"},
        {640, 480, 0, 0, 960, 720,   "roi0"},
        {640, 480, 480,180, 960, 720, "roi1"},
        {640, 480, 960,0, 960, 720,  "roi2"},
    };
    int nch = 4;

    hbn_buf_alloc_attr_t ba = {.buffers_num=8, .is_contig=1,
        .flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED|HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF};

    for (int i = 0; i < nch; i++) {
        vse_ochn_attr_t oa = {0};
        oa.chn_en = CAM_TRUE;
        oa.roi = (common_rect_t){cfg[i].rx, cfg[i].ry, cfg[i].rw, cfg[i].rh};
        oa.target_w = cfg[i].tw; oa.target_h = cfg[i].th;
        oa.fmt = FRM_FMT_NV12; oa.bit_width = 8;
        hbn_vnode_set_ochn_attr(vse_h, i, &oa);
        hbn_vnode_set_ochn_buf_attr(vse_h, i, &ba);
        printf("  Ch%d [%s]: %dx%d\n", i, cfg[i].name, cfg[i].tw, cfg[i].th);
    }
    for (int i = nch; i < VSE_OCHN_MAX; i++) {
        vse_ochn_attr_t oa = {.chn_en=CAM_FALSE, .roi={0,0,input_w,input_h},
            .target_w=input_w, .target_h=input_h, .fmt=FRM_FMT_NV12, .bit_width=8};
        hbn_vnode_set_ochn_attr(vse_h, i, &oa);
        hbn_vnode_set_ochn_buf_attr(vse_h, i, &ba);
    }

    hbn_vflow_handle_t vflow;
    hbn_vflow_create(&vflow);
    hbn_vflow_add_vnode(vflow, vse_h);
    ret = hbn_vflow_start(vflow);
    if (ret != 0) { printf("vflow start: %d\n", ret); return 1; }

    // Input buffer
    hb_mem_graphic_buf_t ibuf = {0};
    hb_mem_alloc_graph_buf(input_w, input_h, MEM_PIX_FMT_NV12,
        HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF,
        0, 0, &ibuf);
    {
        FILE *f = fopen("/app/multimedia_samples/sample_codec/1920x1080_NV12.yuv", "rb");
        if (f) { fread(ibuf.virt_addr[0],1,input_w*input_h,f);
                 fread(ibuf.virt_addr[1],1,input_w*input_h/2,f); fclose(f); }
    }

    // Pre-allocate dst buffers only (src will be zero-copy wrapped)
    n2d_buffer_t n2d_dst[4] = {0};
    for (int i = 0; i < nch; i++)
        n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &n2d_dst[i]);

    // Warmup
    for (int f = 0; f < 5; f++) {
        hbn_vnode_image_t in = {.buffer=ibuf, .info.frame_id=f};
        hbn_vnode_sendframe(vse_h, 0, &in);
        for (int i = 0; i < nch; i++) {
            hbn_vnode_image_t out = {0};
            hbn_vnode_getframe(vse_h, i, 2000, &out);
            hbn_vnode_releaseframe(vse_h, i, &out);
        }
    }

    int N = 60;

    // === Benchmark 1: VSE only ===
    {
        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int f = 0; f < N; f++) {
            hbn_vnode_image_t in = {.buffer=ibuf, .info.frame_id=f};
            hbn_vnode_sendframe(vse_h, 0, &in);
            for (int i = 0; i < nch; i++) {
                hbn_vnode_image_t out = {0};
                hbn_vnode_getframe(vse_h, i, 2000, &out);
                hbn_vnode_releaseframe(vse_h, i, &out);
            }
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0+(t1.tv_nsec-t0.tv_nsec)/1e6)/N;
        printf("\nVSE only (%dch):                      %.2f ms/frame (%.1f fps)\n", nch, ms, 1000/ms);
    }

    // === Benchmark 2: VSE + zero-copy wrap + nano2D letterbox ===
    {
        struct timespec t0, t1;
        int wrap_ok = 0, wrap_fail = 0;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int f = 0; f < N; f++) {
            hbn_vnode_image_t in = {.buffer=ibuf, .info.frame_id=f};
            hbn_vnode_sendframe(vse_h, 0, &in);
            for (int i = 0; i < nch; i++) {
                hbn_vnode_image_t out = {0};
                hbn_vnode_getframe(vse_h, i, 2000, &out);

                // Zero-copy wrap: hbmem phys_addr → n2d_buffer_t
                n2d_buffer_t n2d_src = {0};
                n2d_error_t err = wrap_hbmem_zerocopy(&n2d_src, &out.buffer);
                if (!N2D_IS_ERROR(err)) {
                    n2d_letterbox(&n2d_dst[i], &n2d_src, cfg[i].tw, cfg[i].th, 640);
                    n2d_free(&n2d_src);  // unmap only (no data free)
                    wrap_ok++;
                } else {
                    if (wrap_fail == 0)
                        printf("  wrap failed ch%d: %d (phys=0x%lx)\n", i, err,
                               (unsigned long)out.buffer.phys_addr[0]);
                    wrap_fail++;
                }

                hbn_vnode_releaseframe(vse_h, i, &out);
            }
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0+(t1.tv_nsec-t0.tv_nsec)/1e6)/N;
        printf("VSE + zero-copy n2d letterbox (%dch):  %.2f ms/frame (%.1f fps) [wrap ok=%d fail=%d]\n",
               nch, ms, 1000/ms, wrap_ok, wrap_fail);
    }

    // === Benchmark 3: VSE + memcpy + nano2D letterbox (previous method) ===
    {
        n2d_buffer_t n2d_src_copy[4] = {0};
        for (int i = 0; i < nch; i++)
            n2d_util_allocate_buffer(cfg[i].tw, cfg[i].th, N2D_NV12, N2D_0,
                                      N2D_LINEAR, N2D_TSC_DISABLE, &n2d_src_copy[i]);

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int f = 0; f < N; f++) {
            hbn_vnode_image_t in = {.buffer=ibuf, .info.frame_id=f};
            hbn_vnode_sendframe(vse_h, 0, &in);
            for (int i = 0; i < nch; i++) {
                hbn_vnode_image_t out = {0};
                hbn_vnode_getframe(vse_h, i, 2000, &out);

                // Copy hbmem → n2d (old method)
                uint8_t *dy = (uint8_t*)n2d_src_copy[i].memory;
                uint8_t *sy = (uint8_t*)out.buffer.virt_addr[0];
                for (int y = 0; y < cfg[i].th; y++)
                    memcpy(dy + y * n2d_src_copy[i].stride, sy + y * cfg[i].tw, cfg[i].tw);
                uint8_t *duv = dy + n2d_src_copy[i].stride * n2d_src_copy[i].alignedh;
                uint8_t *suv = (uint8_t*)out.buffer.virt_addr[1];
                for (int y = 0; y < cfg[i].th/2; y++)
                    memcpy(duv + y * n2d_src_copy[i].stride, suv + y * cfg[i].tw, cfg[i].tw);

                n2d_letterbox(&n2d_dst[i], &n2d_src_copy[i], cfg[i].tw, cfg[i].th, 640);

                hbn_vnode_releaseframe(vse_h, i, &out);
            }
        }
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double ms = ((t1.tv_sec-t0.tv_sec)*1000.0+(t1.tv_nsec-t0.tv_nsec)/1e6)/N;
        printf("VSE + memcpy + n2d letterbox (%dch):   %.2f ms/frame (%.1f fps)\n", nch, ms, 1000/ms);
        for (int i = 0; i < nch; i++) n2d_free(&n2d_src_copy[i]);
    }

    // Cleanup
    for (int i = 0; i < nch; i++) n2d_free(&n2d_dst[i]);
    hb_mem_free_buf(ibuf.fd[0]);
    hbn_vflow_stop(vflow);
    hbn_vflow_destroy(vflow);
    hbn_vnode_close(vse_h);
    n2d_close();
    printf("\n=== Done ===\n");
    return 0;
}
