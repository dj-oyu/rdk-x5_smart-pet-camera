/**
 * opencl_median5_bench.c - OpenCL 5x5 median filter benchmark
 *
 * Benchmarks GPU vs CPU median filter on recorded IR night frames.
 * Input: /tmp/night_collect/*.nv12 (1280x720 NV12, Y plane cropped to 640x640)
 *
 * Build: see Makefile (opencl_median5_bench target)
 * Run:   ./opencl_median5_bench [nv12_file_or_dir]
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dirent.h>
#include <CL/cl.h>

#define ROI_W 640
#define ROI_H 640
#define ROI_SIZE (ROI_W * ROI_H)
#define FRAME_W 1280
#define FRAME_H 720
#define WARMUP_ITERS 10
#define BENCH_ITERS 20

/* ── helpers ─────────────────────────────────────────────── */

static double get_time_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

/* CPU reference: 5x5 median via insertion-sort of 25 elements */
static unsigned char median25(unsigned char *w) {
    /* partial sort: we only need the 13th element (index 12) */
    for (int i = 1; i < 25; i++) {
        unsigned char key = w[i];
        int j = i - 1;
        while (j >= 0 && w[j] > key) {
            w[j + 1] = w[j];
            j--;
        }
        w[j + 1] = key;
    }
    return w[12];
}

static void cpu_median5x5(const unsigned char *in, unsigned char *out,
                           int w, int h) {
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            if (x < 2 || x >= w - 2 || y < 2 || y >= h - 2) {
                out[y * w + x] = in[y * w + x];
                continue;
            }
            unsigned char window[25];
            int idx = 0;
            for (int dy = -2; dy <= 2; dy++)
                for (int dx = -2; dx <= 2; dx++)
                    window[idx++] = in[(y + dy) * w + (x + dx)];
            out[y * w + x] = median25(window);
        }
    }
}

/* ── OpenCL kernel source ────────────────────────────────── */

static const char *kernel_src =
"__kernel void median5x5(\n"
"    __global const uchar *input,\n"
"    __global uchar *output,\n"
"    int width, int height)\n"
"{\n"
"    int x = get_global_id(0);\n"
"    int y = get_global_id(1);\n"
"    if (x >= width || y >= height) return;\n"
"    if (x < 2 || x >= width-2 || y < 2 || y >= height-2) {\n"
"        output[y * width + x] = input[y * width + x];\n"
"        return;\n"
"    }\n"
"    uchar w[25];\n"
"    int idx = 0;\n"
"    for (int dy = -2; dy <= 2; dy++)\n"
"        for (int dx = -2; dx <= 2; dx++)\n"
"            w[idx++] = input[(y+dy)*width + (x+dx)];\n"
"\n"
"    /* Sorting network: compare-and-swap macro */\n"
"    #define SWAP(a,b) { uchar lo=min(w[a],w[b]); uchar hi=max(w[a],w[b]); w[a]=lo; w[b]=hi; }\n"
"\n"
"    /* 25-element sorting network (Bose-Nelson, 109 swaps) */\n"
"    SWAP(0,1); SWAP(3,4); SWAP(2,4); SWAP(2,3); SWAP(6,7); SWAP(5,7);\n"
"    SWAP(5,6); SWAP(9,10); SWAP(8,10); SWAP(8,9); SWAP(12,13); SWAP(11,13);\n"
"    SWAP(11,12); SWAP(15,16); SWAP(14,16); SWAP(14,15); SWAP(18,19); SWAP(17,19);\n"
"    SWAP(17,18); SWAP(21,22); SWAP(20,22); SWAP(20,21); SWAP(23,24);\n"
"    SWAP(2,5); SWAP(3,6); SWAP(0,6); SWAP(0,3); SWAP(4,7); SWAP(1,7);\n"
"    SWAP(1,4); SWAP(11,14); SWAP(8,14); SWAP(8,11); SWAP(12,15); SWAP(9,15);\n"
"    SWAP(9,12); SWAP(13,16); SWAP(10,16); SWAP(10,13); SWAP(20,23); SWAP(17,23);\n"
"    SWAP(17,20); SWAP(21,24); SWAP(18,24); SWAP(18,21); SWAP(19,22);\n"
"    SWAP(8,17); SWAP(9,18); SWAP(0,18); SWAP(0,9); SWAP(10,19); SWAP(1,19);\n"
"    SWAP(1,10); SWAP(11,20); SWAP(2,20); SWAP(2,11); SWAP(12,21); SWAP(3,21);\n"
"    SWAP(3,12); SWAP(13,22); SWAP(4,22); SWAP(4,13); SWAP(14,23); SWAP(5,23);\n"
"    SWAP(5,14); SWAP(15,24); SWAP(6,24); SWAP(6,15); SWAP(7,16);\n"
"    SWAP(7,19); SWAP(13,21); SWAP(15,23); SWAP(7,13); SWAP(7,15);\n"
"    SWAP(1,9); SWAP(3,11); SWAP(5,17); SWAP(11,17); SWAP(9,17);\n"
"    SWAP(4,10); SWAP(6,12); SWAP(7,14); SWAP(4,6); SWAP(4,7);\n"
"    SWAP(12,14); SWAP(10,14); SWAP(6,7); SWAP(10,12); SWAP(6,10);\n"
"    SWAP(6,17); SWAP(12,17); SWAP(7,17); SWAP(7,10); SWAP(12,18);\n"
"    SWAP(7,12); SWAP(10,18); SWAP(12,20); SWAP(10,20); SWAP(10,12);\n"
"\n"
"    #undef SWAP\n"
"    output[y * width + x] = w[12];\n"
"}\n";

/* ── crop Y plane from 1280x720 NV12 to 640x640 ROI ──── */

static void crop_y_roi(const unsigned char *nv12, unsigned char *roi,
                        int src_w, int src_h, int roi_x, int roi_y) {
    for (int y = 0; y < ROI_H; y++) {
        memcpy(roi + y * ROI_W,
               nv12 + (roi_y + y) * src_w + roi_x,
               ROI_W);
    }
}

/* ── main ────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    const char *input_path = "/tmp/night_collect";
    if (argc > 1) input_path = argv[1];

    /* Collect NV12 file list */
    char files[64][512];
    int nfiles = 0;

    DIR *dir = opendir(input_path);
    if (dir) {
        struct dirent *ent;
        while ((ent = readdir(dir)) != NULL && nfiles < 64) {
            if (strstr(ent->d_name, ".nv12")) {
                snprintf(files[nfiles], sizeof(files[0]), "%s/%s",
                         input_path, ent->d_name);
                nfiles++;
            }
        }
        closedir(dir);
    } else {
        /* Single file */
        strncpy(files[0], input_path, sizeof(files[0]) - 1);
        nfiles = 1;
    }

    if (nfiles == 0) {
        printf("No .nv12 files found in %s\n", input_path);
        return 1;
    }
    printf("Found %d NV12 files in %s\n\n", nfiles, input_path);

    /* ── OpenCL setup ──────────────────────────────────── */
    cl_int err;
    cl_platform_id platform;
    cl_device_id device;

    err = clGetPlatformIDs(1, &platform, NULL);
    if (err != CL_SUCCESS) { printf("No OpenCL platform\n"); return 1; }

    err = clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 1, &device, NULL);
    if (err != CL_SUCCESS) { printf("No GPU device\n"); return 1; }

    /* Print device info */
    char dev_name[256];
    clGetDeviceInfo(device, CL_DEVICE_NAME, sizeof(dev_name), dev_name, NULL);
    printf("GPU: %s\n", dev_name);

    cl_context context = clCreateContext(NULL, 1, &device, NULL, NULL, &err);
    if (err != CL_SUCCESS) { printf("Context error\n"); return 1; }

    /* Enable profiling */
    cl_queue_properties props[] = {CL_QUEUE_PROPERTIES, CL_QUEUE_PROFILING_ENABLE, 0};
    cl_command_queue queue = clCreateCommandQueueWithProperties(context, device, props, &err);
    if (err != CL_SUCCESS) { printf("Queue error\n"); return 1; }

    /* Build program */
    cl_program program = clCreateProgramWithSource(context, 1, &kernel_src, NULL, &err);
    if (err != CL_SUCCESS) { printf("Program error\n"); return 1; }

    err = clBuildProgram(program, 1, &device, NULL, NULL, NULL);
    if (err != CL_SUCCESS) {
        size_t len;
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, 0, NULL, &len);
        char *log = malloc(len);
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, len, log, NULL);
        printf("Build error:\n%s\n", log);
        free(log);
        return 1;
    }

    cl_kernel kernel = clCreateKernel(program, "median5x5", &err);
    if (err != CL_SUCCESS) { printf("Kernel error\n"); return 1; }

    /* Allocate GPU buffers (zero-copy) */
    cl_mem cl_input = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_ALLOC_HOST_PTR,
                                      ROI_SIZE, NULL, &err);
    cl_mem cl_output = clCreateBuffer(context, CL_MEM_WRITE_ONLY | CL_MEM_ALLOC_HOST_PTR,
                                       ROI_SIZE, NULL, &err);
    if (err != CL_SUCCESS) { printf("Buffer alloc error\n"); return 1; }

    int width = ROI_W, height = ROI_H;
    clSetKernelArg(kernel, 0, sizeof(cl_mem), &cl_input);
    clSetKernelArg(kernel, 1, sizeof(cl_mem), &cl_output);
    clSetKernelArg(kernel, 2, sizeof(int), &width);
    clSetKernelArg(kernel, 3, sizeof(int), &height);

    size_t global_size[2] = {ROI_W, ROI_H};

    /* Allocate host buffers */
    unsigned char *nv12_buf = malloc(FRAME_W * FRAME_H * 3 / 2);
    unsigned char *roi_buf = malloc(ROI_SIZE);
    unsigned char *cpu_out = malloc(ROI_SIZE);

    /* ROI center crop */
    int roi_x = (FRAME_W - ROI_W) / 2;  /* 320 */
    int roi_y = (FRAME_H - ROI_H) / 2;  /* 40 */

    printf("=== medianBlur(5) Benchmark: GPU vs CPU ===\n");
    printf("ROI: %dx%d from %dx%d (offset %d,%d)\n\n", ROI_W, ROI_H, FRAME_W, FRAME_H, roi_x, roi_y);

    double gpu_total = 0, cpu_total = 0;
    double gpu_kernel_total = 0;
    int total_runs = 0;

    /* ── Warmup ──────────────────────────────────────── */
    printf("Warming up GPU (%d iterations)...\n", WARMUP_ITERS);
    memset(roi_buf, 128, ROI_SIZE);
    for (int i = 0; i < WARMUP_ITERS; i++) {
        unsigned char *mapped = clEnqueueMapBuffer(queue, cl_input, CL_TRUE,
            CL_MAP_WRITE, 0, ROI_SIZE, 0, NULL, NULL, &err);
        memcpy(mapped, roi_buf, ROI_SIZE);
        clEnqueueUnmapMemObject(queue, cl_input, mapped, 0, NULL, NULL);
        clEnqueueNDRangeKernel(queue, kernel, 2, NULL, global_size, NULL, 0, NULL, NULL);
        clFinish(queue);
    }

    /* ── Benchmark each file ─────────────────────────── */
    for (int f = 0; f < nfiles; f++) {
        FILE *fp = fopen(files[f], "rb");
        if (!fp) { printf("Skip: %s\n", files[f]); continue; }
        size_t read = fread(nv12_buf, 1, FRAME_W * FRAME_H * 3 / 2, fp);
        fclose(fp);
        if (read < (size_t)(FRAME_W * FRAME_H)) {
            printf("Skip (too small): %s\n", files[f]);
            continue;
        }

        /* Crop Y plane to 640x640 ROI */
        crop_y_roi(nv12_buf, roi_buf, FRAME_W, FRAME_H, roi_x, roi_y);

        /* --- GPU benchmark --- */
        double gpu_times[BENCH_ITERS];
        double gpu_kernel_times[BENCH_ITERS];

        for (int i = 0; i < BENCH_ITERS; i++) {
            double t0 = get_time_ms();

            /* Map input, copy data, unmap */
            unsigned char *mapped_in = clEnqueueMapBuffer(queue, cl_input, CL_TRUE,
                CL_MAP_WRITE, 0, ROI_SIZE, 0, NULL, NULL, &err);
            memcpy(mapped_in, roi_buf, ROI_SIZE);
            clEnqueueUnmapMemObject(queue, cl_input, mapped_in, 0, NULL, NULL);

            /* Execute kernel */
            cl_event event;
            clEnqueueNDRangeKernel(queue, kernel, 2, NULL, global_size, NULL,
                                    0, NULL, &event);
            clFinish(queue);

            /* Map output (zero-copy read) */
            unsigned char *mapped_out = clEnqueueMapBuffer(queue, cl_output, CL_TRUE,
                CL_MAP_READ, 0, ROI_SIZE, 0, NULL, NULL, &err);
            /* Touch first byte to ensure sync */
            volatile unsigned char v = mapped_out[0];
            (void)v;
            clEnqueueUnmapMemObject(queue, cl_output, mapped_out, 0, NULL, NULL);
            clFinish(queue);

            double t1 = get_time_ms();
            gpu_times[i] = t1 - t0;

            /* Get kernel-only time from profiling */
            cl_ulong k_start, k_end;
            clGetEventProfilingInfo(event, CL_PROFILING_COMMAND_START, sizeof(k_start), &k_start, NULL);
            clGetEventProfilingInfo(event, CL_PROFILING_COMMAND_END, sizeof(k_end), &k_end, NULL);
            gpu_kernel_times[i] = (k_end - k_start) / 1e6; /* ns → ms */
            clReleaseEvent(event);
        }

        /* --- CPU benchmark --- */
        double cpu_times[BENCH_ITERS];
        for (int i = 0; i < BENCH_ITERS; i++) {
            double t0 = get_time_ms();
            cpu_median5x5(roi_buf, cpu_out, ROI_W, ROI_H);
            double t1 = get_time_ms();
            cpu_times[i] = t1 - t0;
        }

        /* Stats */
        double gpu_min = 1e9, gpu_sum = 0, gk_min = 1e9, gk_sum = 0;
        double cpu_min = 1e9, cpu_sum = 0;
        for (int i = 0; i < BENCH_ITERS; i++) {
            gpu_sum += gpu_times[i];
            if (gpu_times[i] < gpu_min) gpu_min = gpu_times[i];
            gk_sum += gpu_kernel_times[i];
            if (gpu_kernel_times[i] < gk_min) gk_min = gpu_kernel_times[i];
            cpu_sum += cpu_times[i];
            if (cpu_times[i] < cpu_min) cpu_min = cpu_times[i];
        }

        /* Extract filename */
        const char *fname = strrchr(files[f], '/');
        fname = fname ? fname + 1 : files[f];

        printf("[%s]\n", fname);
        printf("  GPU total:  min=%.2fms avg=%.2fms\n", gpu_min, gpu_sum / BENCH_ITERS);
        printf("  GPU kernel: min=%.2fms avg=%.2fms\n", gk_min, gk_sum / BENCH_ITERS);
        printf("  CPU:        min=%.2fms avg=%.2fms\n", cpu_min, cpu_sum / BENCH_ITERS);
        printf("  Speedup:    %.1fx (total) %.1fx (kernel-only)\n",
               (cpu_sum / BENCH_ITERS) / (gpu_sum / BENCH_ITERS),
               (cpu_sum / BENCH_ITERS) / (gk_sum / BENCH_ITERS));
        printf("\n");

        gpu_total += gpu_sum / BENCH_ITERS;
        gpu_kernel_total += gk_sum / BENCH_ITERS;
        cpu_total += cpu_sum / BENCH_ITERS;
        total_runs++;
    }

    /* ── Summary ─────────────────────────────────────── */
    if (total_runs > 0) {
        printf("=== SUMMARY (%d frames) ===\n", total_runs);
        printf("  GPU total avg:  %.2fms\n", gpu_total / total_runs);
        printf("  GPU kernel avg: %.2fms\n", gpu_kernel_total / total_runs);
        printf("  CPU avg:        %.2fms\n", cpu_total / total_runs);
        printf("  Speedup:        %.1fx (total) %.1fx (kernel)\n",
               (cpu_total / total_runs) / (gpu_total / total_runs),
               (cpu_total / total_runs) / (gpu_kernel_total / total_runs));
        printf("\n");

        double gpu_avg = gpu_total / total_runs;
        if (gpu_avg < 4.0)
            printf("VERDICT: GO — GPU < 4ms, significant speedup over CPU\n");
        else if (gpu_avg < 8.0)
            printf("VERDICT: CONDITIONAL GO — GPU 4-8ms, worthwhile only if kernel 5 quality needed\n");
        else
            printf("VERDICT: NO-GO — GPU > 8ms, use kernel 3 on CPU instead (1.84ms)\n");
    }

    /* Cleanup */
    free(nv12_buf);
    free(roi_buf);
    free(cpu_out);
    clReleaseMemObject(cl_input);
    clReleaseMemObject(cl_output);
    clReleaseKernel(kernel);
    clReleaseProgram(program);
    clReleaseCommandQueue(queue);
    clReleaseContext(context);

    return 0;
}
