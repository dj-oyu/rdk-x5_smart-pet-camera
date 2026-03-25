#include <stdio.h>
#include <stdlib.h>
#include <CL/cl.h>

#define MAX_PLATFORMS 4
#define MAX_DEVICES 8
#define INFO_SIZE 1024

int main() {
    cl_int err;
    cl_uint num_platforms;
    cl_platform_id platforms[MAX_PLATFORMS];
    char info_buffer[INFO_SIZE];

    err = clGetPlatformIDs(MAX_PLATFORMS, platforms, &num_platforms);
    if (err != CL_SUCCESS) {
        printf("Error getting platforms: %d\n", err);
        return 1;
    }

    printf("Number of OpenCL Platforms: %u\n", num_platforms);

    for (cl_uint i = 0; i < num_platforms; i++) {
        printf("\n=== Platform %u ===\n", i);
        
        clGetPlatformInfo(platforms[i], CL_PLATFORM_NAME, INFO_SIZE, info_buffer, NULL);
        printf("  Name: %s\n", info_buffer);
        clGetPlatformInfo(platforms[i], CL_PLATFORM_VENDOR, INFO_SIZE, info_buffer, NULL);
        printf("  Vendor: %s\n", info_buffer);
        clGetPlatformInfo(platforms[i], CL_PLATFORM_VERSION, INFO_SIZE, info_buffer, NULL);
        printf("  Version: %s\n", info_buffer);

        cl_uint num_devices;
        cl_device_id devices[MAX_DEVICES];
        err = clGetDeviceIDs(platforms[i], CL_DEVICE_TYPE_ALL, MAX_DEVICES, devices, &num_devices);
        if (err != CL_SUCCESS) {
            printf("  Error getting devices: %d\n", err);
            continue;
        }

        printf("  Number of Devices: %u\n", num_devices);

        for (cl_uint j = 0; j < num_devices; j++) {
            printf("\n    --- Device %u ---\n", j);
            
            clGetDeviceInfo(devices[j], CL_DEVICE_NAME, INFO_SIZE, info_buffer, NULL);
            printf("    Name: %s\n", info_buffer);
            
            cl_uint compute_units;
            clGetDeviceInfo(devices[j], CL_DEVICE_MAX_COMPUTE_UNITS, sizeof(compute_units), &compute_units, NULL);
            printf("    Max Compute Units: %u\n", compute_units);
            
            cl_ulong global_mem_size;
            clGetDeviceInfo(devices[j], CL_DEVICE_GLOBAL_MEM_SIZE, sizeof(global_mem_size), &global_mem_size, NULL);
            printf("    Global Memory: %lu bytes (%.2f MB)\n", global_mem_size, (double)global_mem_size / (1024 * 1024));
            
            cl_ulong local_mem_size;
            clGetDeviceInfo(devices[j], CL_DEVICE_LOCAL_MEM_SIZE, sizeof(local_mem_size), &local_mem_size, NULL);
            printf("    Local Memory: %lu bytes (%.2f KB)\n", local_mem_size, (double)local_mem_size / 1024);
            
            size_t max_work_group_size;
            clGetDeviceInfo(devices[j], CL_DEVICE_MAX_WORK_GROUP_SIZE, sizeof(max_work_group_size), &max_work_group_size, NULL);
            printf("    Max Work Group Size: %zu\n", max_work_group_size);

            cl_ulong max_mem_alloc;
            clGetDeviceInfo(devices[j], CL_DEVICE_MAX_MEM_ALLOC_SIZE, sizeof(max_mem_alloc), &max_mem_alloc, NULL);
            printf("    Max Mem Alloc: %lu bytes (%.2f MB)\n", max_mem_alloc, (double)max_mem_alloc/(1024*1024));

            cl_bool image_support;
            clGetDeviceInfo(devices[j], CL_DEVICE_IMAGE_SUPPORT, sizeof(image_support), &image_support, NULL);
            printf("    Image Support: %s\n", image_support ? "Yes" : "No");
        }
    }

    return 0;
}
