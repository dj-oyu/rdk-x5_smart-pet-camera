/*
 * VSE 6-Channel Simultaneous Output Test
 * Based on single_pipe_vin_isp_vse_vpu sample pattern
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "hbn_api.h"
#include "hb_mem_mgr.h"
#include "vse_cfg.h"
#include "cam_def.h"

#define VSE_MAX_CHANNELS VSE_OCHN_MAX

int main() {
    int W = 1920, H = 1080;
    int ret;

    printf("=== VSE 6-Channel Output Test ===\n");
    printf("Input: %dx%d NV12\n\n", W, H);

    // --- VSE node setup (following SDK sample pattern) ---
    hbn_vnode_handle_t vse_h;
    ret = hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &vse_h);
    if (ret != 0) { printf("vnode_open FAILED: %d\n", ret); return 1; }

    // Set VSE node attribute (must be called before set_ichn_attr)
    vse_attr_t vse_attr = {0};
    ret = hbn_vnode_set_attr(vse_h, &vse_attr);
    if (ret != 0) printf("set_attr: %d\n", ret);

    // Input channel
    vse_ichn_attr_t ichn = {0};
    ichn.width = W;
    ichn.height = H;
    ichn.fmt = FRM_FMT_NV12;
    ichn.bit_width = 8;
    ret = hbn_vnode_set_ichn_attr(vse_h, 0, &ichn);
    if (ret != 0) { printf("set_ichn_attr FAILED: %d\n", ret); goto close; }

    // Output channels: all default to full-frame ROI first
    vse_ochn_attr_t oa[VSE_MAX_CHANNELS] = {0};
    const char *labels[VSE_MAX_CHANNELS] = {
        "Full 1920x1080 (streaming)",
        "640x360 (YOLO day)",
        "640x640 ROI0 (night top-L)",
        "640x640 ROI1 (night center)",
        "640x640 ROI2 (night top-R)",
        "960x544 (preview)",
    };

    for (int i = 0; i < VSE_MAX_CHANNELS; i++) {
        oa[i].chn_en = CAM_TRUE;
        oa[i].roi.x = 0;  oa[i].roi.y = 0;
        oa[i].roi.w = W;  oa[i].roi.h = H;
        oa[i].fmt = FRM_FMT_NV12;
        oa[i].bit_width = 8;
    }

    // Ch0: full resolution (streaming/encoding)
    oa[0].target_w = W;  oa[0].target_h = H;
    // Ch1: YOLO day (downscale)
    oa[1].target_w = 640; oa[1].target_h = 360;
    // Ch2-4: YOLO night ROIs (crop 720x720 region → scale to 640x640)
    // Night camera is 1280x720 but we test at 1920x1080 input
    oa[2].roi.x = 0;   oa[2].roi.y = 0;   oa[2].roi.w = 720; oa[2].roi.h = 720;
    oa[2].target_w = 640; oa[2].target_h = 640;
    oa[3].roi.x = 600;  oa[3].roi.y = 180; oa[3].roi.w = 720; oa[3].roi.h = 720;
    oa[3].target_w = 640; oa[3].target_h = 640;
    oa[4].roi.x = 1200; oa[4].roi.y = 0;   oa[4].roi.w = 720; oa[4].roi.h = 720;
    oa[4].target_w = 640; oa[4].target_h = 640;
    // Ch5: comic thumbnail
    oa[5].target_w = 960; oa[5].target_h = 544; // 16-align: 224 instead of 225

    hbn_buf_alloc_attr_t ba = {0};
    ba.buffers_num = 8;
    ba.is_contig = 1;
    ba.flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN;

    int active = 0;
    for (int i = 0; i < VSE_MAX_CHANNELS; i++) {
        ret = hbn_vnode_set_ochn_attr(vse_h, i, &oa[i]);
        if (ret != 0) {
            printf("  Ch%d [%s]: ochn_attr FAILED %d\n", i, labels[i], ret);
            continue;
        }
        ret = hbn_vnode_set_ochn_buf_attr(vse_h, i, &ba);
        if (ret != 0) {
            printf("  Ch%d: buf_attr FAILED %d\n", i, ret);
            continue;
        }
        printf("  Ch%d [%s]: %dx%d", i, labels[i], oa[i].target_w, oa[i].target_h);
        if (oa[i].roi.w != W || oa[i].roi.h != H)
            printf(" (ROI %d,%d %dx%d)", oa[i].roi.x, oa[i].roi.y, oa[i].roi.w, oa[i].roi.h);
        printf(" OK\n");
        active++;
    }

    // vflow
    hbn_vflow_handle_t vflow;
    ret = hbn_vflow_create(&vflow);
    if (ret != 0) { printf("vflow_create: %d\n", ret); goto close; }
    ret = hbn_vflow_add_vnode(vflow, vse_h);
    if (ret != 0) { printf("vflow_add: %d\n", ret); goto destroy; }
    ret = hbn_vflow_start(vflow);
    if (ret != 0) { printf("vflow_start: %d\n", ret); goto destroy; }

    printf("\nStarted. %d channels active.\n", active);

    // Allocate input NV12 (use hbmem)
    hb_mem_graphic_buf_t ibuf = {0};
    ret = hb_mem_alloc_graph_buf(W, H, MEM_PIX_FMT_NV12,
            HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN, 0, 0, &ibuf);
    if (ret != 0) { printf("alloc input buf: %d\n", ret); goto stop; }
    if (ibuf.virt_addr[0]) memset(ibuf.virt_addr[0], 128, W*H);
    if (ibuf.virt_addr[1]) memset(ibuf.virt_addr[1], 128, W*H/2);

    int N = 30;
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int f = 0; f < N; f++) {
        hbn_vnode_image_t in = {0};
        in.buffer = ibuf;
        in.info.frame_id = f;
        ret = hbn_vnode_sendframe(vse_h, 0, &in);
        if (ret != 0) { printf("sendframe %d: %d\n", f, ret); break; }

        for (int i = 0; i < VSE_MAX_CHANNELS; i++) {
            hbn_vnode_image_t out = {0};
            ret = hbn_vnode_getframe(vse_h, i, 2000, &out);
            if (ret != 0) { if (f==0) printf("  Ch%d getframe: %d\n", i, ret); continue; }
            if (f == 0) printf("  Ch%d → %dx%d (%lu bytes)\n",
                i, out.buffer.width, out.buffer.height, (unsigned long)out.buffer.size[0]);
            hbn_vnode_releaseframe(vse_h, i, &out);
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double s = (t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
    printf("\n%d frames × %d ch in %.2fs → %.1f fps (%.2f ms/frame)\n",
           N, active, s, N/s, s*1000/N);

    hb_mem_free_buf(ibuf.fd[0]);
stop:  hbn_vflow_stop(vflow);
destroy: hbn_vflow_destroy(vflow);
close: hbn_vnode_close(vse_h);
    printf("=== Done ===\n");
    return 0;
}
