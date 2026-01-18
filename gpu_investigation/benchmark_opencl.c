#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <CL/cl.h>

#define BUFFER_SIZE (1024 * 1024 * 16) // 16 MB
#define ITERATIONS 50

// Helper to get time in seconds
double get_time() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

int main() {
    cl_int err;
    cl_uint num_platforms;
    cl_platform_id platform;
    cl_device_id device;
    cl_context context;
    cl_command_queue queue;
    cl_mem dev_buf1, dev_buf2;
    void *host_buf;

    // 1. Setup OpenCL
    err = clGetPlatformIDs(1, &platform, &num_platforms);
    if (err != CL_SUCCESS) { printf("Error getting platform\n"); return 1; }

    err = clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 1, &device, NULL);
    if (err != CL_SUCCESS) { printf("Error getting device\n"); return 1; }

    context = clCreateContext(NULL, 1, &device, NULL, NULL, &err);
    if (err != CL_SUCCESS) { printf("Error creating context\n"); return 1; }

    // Use command queue with profiling enabled if needed, here just basic
    queue = clCreateCommandQueueWithProperties(context, device, 0, &err);
    if (err != CL_SUCCESS) { printf("Error creating queue\n"); return 1; }

    // 2. Memory Bandwidth Test
    printf("=== Memory Bandwidth Test (Buffer Size: %.2f MB) ===\n", (double)BUFFER_SIZE/(1024*1024));

    host_buf = malloc(BUFFER_SIZE);
    // Fill buffer
    for(int i=0; i<BUFFER_SIZE; i++) ((char*)host_buf)[i] = i % 256;

    dev_buf1 = clCreateBuffer(context, CL_MEM_READ_WRITE, BUFFER_SIZE, NULL, &err);
    dev_buf2 = clCreateBuffer(context, CL_MEM_READ_WRITE, BUFFER_SIZE, NULL, &err);

    // Host -> Device
    double start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        err = clEnqueueWriteBuffer(queue, dev_buf1, CL_TRUE, 0, BUFFER_SIZE, host_buf, 0, NULL, NULL);
    }
    double end = get_time();
    double gb_sec = ((double)BUFFER_SIZE * ITERATIONS) / (1024*1024*1024) / (end - start);
    printf("Host -> Device: %.2f GB/s\n", gb_sec);

    // Device -> Host
    start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        err = clEnqueueReadBuffer(queue, dev_buf1, CL_TRUE, 0, BUFFER_SIZE, host_buf, 0, NULL, NULL);
    }
    end = get_time();
    gb_sec = ((double)BUFFER_SIZE * ITERATIONS) / (1024*1024*1024) / (end - start);
    printf("Device -> Host: %.2f GB/s\n", gb_sec);

    // Device -> Device (Copy)
    start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        err = clEnqueueCopyBuffer(queue, dev_buf1, dev_buf2, 0, 0, BUFFER_SIZE, 0, NULL, NULL);
    }
    clFinish(queue); // Ensure all copies are done
    end = get_time();
    gb_sec = ((double)BUFFER_SIZE * ITERATIONS) / (1024*1024*1024) / (end - start);
    printf("Device -> Device: %.2f GB/s\n", gb_sec);

    // 3. Compute Benchmark (Simple vector add kernel simulation)
    // Note: To really test GFLOPS we need a kernel. I'll construct a simple one from source string.
    const char *kernel_src = 
    "__kernel void vec_add(__global float *a, __global float *b, __global float *c) {"
    "   int id = get_global_id(0);"
    "   for(int i=0; i<100; i++) c[id] = a[id] * b[id] + c[id];" // FMA operations
    "}";

    cl_program program = clCreateProgramWithSource(context, 1, &kernel_src, NULL, &err);
    if (err != CL_SUCCESS) { printf("Error creating program\n"); return 1; }
    
    err = clBuildProgram(program, 1, &device, NULL, NULL, NULL);
    if (err != CL_SUCCESS) { 
        printf("Error building program\n");
        size_t len;
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, 0, NULL, &len);
        char *log = malloc(len);
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, len, log, NULL);
        printf("%s\n", log);
        return 1; 
    }

    cl_kernel kernel = clCreateKernel(program, "vec_add", &err);
    
    size_t num_floats = BUFFER_SIZE / sizeof(float);
    cl_mem buf_a = clCreateBuffer(context, CL_MEM_READ_ONLY, BUFFER_SIZE, NULL, NULL);
    cl_mem buf_b = clCreateBuffer(context, CL_MEM_READ_ONLY, BUFFER_SIZE, NULL, NULL);
    cl_mem buf_c = clCreateBuffer(context, CL_MEM_WRITE_ONLY, BUFFER_SIZE, NULL, NULL);

    clSetKernelArg(kernel, 0, sizeof(cl_mem), &buf_a);
    clSetKernelArg(kernel, 1, sizeof(cl_mem), &buf_b);
    clSetKernelArg(kernel, 2, sizeof(cl_mem), &buf_c);

    size_t global_work_size = num_floats;
    
    printf("\n=== Compute Test (Simple FMA) ===\n");
    start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        err = clEnqueueNDRangeKernel(queue, kernel, 1, NULL, &global_work_size, NULL, 0, NULL, NULL);
    }
    clFinish(queue);
    end = get_time();

    // num_floats * 100 iterations * 2 ops (mul + add) * ITERATIONS
    double total_ops = (double)num_floats * 100.0 * 2.0 * (double)ITERATIONS;
    double gflops = (total_ops / (end - start)) / 1e9;
    
    printf("Compute: %.2f GFLOPS (approx)\n", gflops);

    // Cleanup
    free(host_buf);
    clReleaseMemObject(dev_buf1);
    clReleaseMemObject(dev_buf2);
    clReleaseMemObject(buf_a);
    clReleaseMemObject(buf_b);
    clReleaseMemObject(buf_c);
    clReleaseKernel(kernel);
    clReleaseProgram(program);
    clReleaseCommandQueue(queue);
    clReleaseContext(context);

    return 0;
}
