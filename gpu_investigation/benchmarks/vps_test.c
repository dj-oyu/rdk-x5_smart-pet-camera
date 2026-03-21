/*
 * VPS (Video Processing Subsystem) Benchmark
 * Tests sp_open_vps scaling performance
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "sp_vio.h"
#include "sp_sys.h"

#define FRAME_BUF_SIZE(w,h) ((w)*(h)*3/2)

int main() {
    int src_w = 1920, src_h = 1080;
    int dst_w = 640, dst_h = 360;
    int iterations = 30;

    printf("=== VPS (sp_open_vps) Scaling Benchmark ===\n");
    printf("Input: %dx%d → Output: %dx%d, Iterations: %d\n\n", src_w, src_h, dst_w, dst_h, iterations);

    void *vps = sp_init_vio_module();
    if (!vps) {
        printf("sp_init_vio_module failed\n");
        return 1;
    }

    int ret = sp_open_vps(vps, 0, 1, SP_VPS_SCALE, src_w, src_h, &dst_w, &dst_h, NULL, NULL, NULL, NULL, NULL);
    if (ret != 0) {
        printf("sp_open_vps failed: %d\n", ret);
        sp_release_vio_module(vps);
        return 1;
    }
    printf("VPS opened: %dx%d → %dx%d\n", src_w, src_h, dst_w, dst_h);

    int in_size = FRAME_BUF_SIZE(src_w, src_h);
    int out_size = FRAME_BUF_SIZE(dst_w, dst_h);
    char *in_buf = malloc(in_size);
    char *out_buf = malloc(out_size);

    // Fill with test pattern
    memset(in_buf, 128, in_size);

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int i = 0; i < iterations; i++) {
        ret = sp_vio_set_frame(vps, in_buf, in_size);
        if (ret != 0) { printf("sp_vio_set_frame failed: %d (frame %d)\n", ret, i); break; }

        ret = sp_vio_get_frame(vps, out_buf, dst_w, dst_h, 2000);
        if (ret != 0) { printf("sp_vio_get_frame failed: %d (frame %d)\n", ret, i); break; }
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    printf("  %d frames in %.2f s (%.1f fps, %.2f ms/frame)\n",
           iterations, elapsed, iterations / elapsed, elapsed * 1000 / iterations);

    free(in_buf);
    free(out_buf);
    sp_vio_close(vps);
    sp_release_vio_module(vps);
    printf("\n=== Done ===\n");
    return 0;
}
