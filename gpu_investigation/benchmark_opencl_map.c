#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <CL/cl.h>

#define BUFFER_SIZE (1024 * 1024 * 16) // 16 MB
#define ITERATIONS 50

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
    cl_mem dev_buf;
    void *mapped_ptr;

    // 1. Setup OpenCL
    err = clGetPlatformIDs(1, &platform, &num_platforms);
    if (err != CL_SUCCESS) { printf("Error getting platform\n"); return 1; }

    err = clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 1, &device, NULL);
    if (err != CL_SUCCESS) { printf("Error getting device\n"); return 1; }

    context = clCreateContext(NULL, 1, &device, NULL, NULL, &err);
    if (err != CL_SUCCESS) { printf("Error creating context\n"); return 1; }

    queue = clCreateCommandQueueWithProperties(context, device, 0, &err);
    if (err != CL_SUCCESS) { printf("Error creating queue\n"); return 1; }

    printf("=== Zero-Copy (MapBuffer) Test (Buffer Size: %.2f MB) ===\n", (double)BUFFER_SIZE/(1024*1024));

    // Allocate buffer with CL_MEM_ALLOC_HOST_PTR to hint for unified memory
    dev_buf = clCreateBuffer(context, CL_MEM_READ_WRITE | CL_MEM_ALLOC_HOST_PTR, BUFFER_SIZE, NULL, &err);
    if (err != CL_SUCCESS) { printf("Error creating buffer: %d\n", err); return 1; }

    // Map for Writing
    double start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        mapped_ptr = clEnqueueMapBuffer(queue, dev_buf, CL_TRUE, CL_MAP_WRITE, 0, BUFFER_SIZE, 0, NULL, NULL, &err);
        if (err != CL_SUCCESS) { printf("Error mapping for write: %d\n", err); return 1; }
        
        // Actually write to it to ensure pages are faulted in/transferred
        memset(mapped_ptr, i, BUFFER_SIZE);
        
        clEnqueueUnmapMemObject(queue, dev_buf, mapped_ptr, 0, NULL, NULL);
    }
    clFinish(queue);
    double end = get_time();
    double gb_sec = ((double)BUFFER_SIZE * ITERATIONS) / (1024*1024*1024) / (end - start);
    printf("Map (Write) -> Unmap: %.2f GB/s\n", gb_sec);

    // Map for Reading
    // First, let GPU modify it (dummy kernel or just assume it did)
    // We will just map for read now.
    
    start = get_time();
    for(int i=0; i<ITERATIONS; i++) {
        mapped_ptr = clEnqueueMapBuffer(queue, dev_buf, CL_TRUE, CL_MAP_READ, 0, BUFFER_SIZE, 0, NULL, NULL, &err);
        if (err != CL_SUCCESS) { printf("Error mapping for read: %d\n", err); return 1; }
        
        // Read a few bytes to force sync
        volatile char c = ((char*)mapped_ptr)[0];
        volatile char d = ((char*)mapped_ptr)[BUFFER_SIZE-1];
        
        clEnqueueUnmapMemObject(queue, dev_buf, mapped_ptr, 0, NULL, NULL);
    }
    clFinish(queue);
    end = get_time();
    gb_sec = ((double)BUFFER_SIZE * ITERATIONS) / (1024*1024*1024) / (end - start);
    printf("Map (Read) -> Unmap: %.2f GB/s\n", gb_sec);

    clReleaseMemObject(dev_buf);
    clReleaseCommandQueue(queue);
    clReleaseContext(context);

    return 0;
}
