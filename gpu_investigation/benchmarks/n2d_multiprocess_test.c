/*
 * nano2D Multi-Process Test
 * Verifies two processes can use GC820 GPU simultaneously.
 * Simulates: detector (letterbox) + web_monitor (comic compose)
 *
 * Usage: ./n2d_multiprocess_test
 * Forks two children, each opens nano2D and runs fill+blit in a loop.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <time.h>
#include "GC820/nano2D.h"
#include "GC820/nano2D_util.h"

#define ITERATIONS 50

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

// Simulates letterbox: 640x360 → 640x640 (fill black + blit center)
static int run_letterbox(const char *label) {
    n2d_error_t err = n2d_open();
    if (N2D_IS_ERROR(err)) {
        printf("[%s] n2d_open failed: %d\n", label, err);
        return 1;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    n2d_buffer_t src = {0}, dst = {0};
    err = n2d_util_allocate_buffer(640, 360, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &src);
    if (N2D_IS_ERROR(err)) { printf("[%s] alloc src failed: %d\n", label, err); goto close; }
    err = n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &dst);
    if (N2D_IS_ERROR(err)) { printf("[%s] alloc dst failed: %d\n", label, err); n2d_free(&src); goto close; }

    double t0 = now_ms();
    for (int i = 0; i < ITERATIONS; i++) {
        n2d_fill(&dst, N2D_NULL, 0x00108080, N2D_BLEND_NONE);
        n2d_rectangle_t r = {0, 140, 640, 360};
        n2d_blit(&dst, &r, &src, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
    }
    double elapsed = now_ms() - t0;
    printf("[%s] letterbox: %d iterations, %.2f ms/iter (%.1f fps)\n",
           label, ITERATIONS, elapsed / ITERATIONS, ITERATIONS * 1000.0 / elapsed);

    n2d_free(&dst);
    n2d_free(&src);
close:
    n2d_close();
    return 0;
}

// Simulates comic compose: fill canvas + blit 4 panels
static int run_comic(const char *label) {
    n2d_error_t err = n2d_open();
    if (N2D_IS_ERROR(err)) {
        printf("[%s] n2d_open failed: %d\n", label, err);
        return 1;
    }
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    n2d_buffer_t canvas = {0}, panel = {0};
    err = n2d_util_allocate_buffer(848, 496, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &canvas);
    if (N2D_IS_ERROR(err)) { printf("[%s] alloc canvas failed: %d\n", label, err); goto close; }
    err = n2d_util_allocate_buffer(768, 432, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &panel);
    if (N2D_IS_ERROR(err)) { printf("[%s] alloc panel failed: %d\n", label, err); n2d_free(&canvas); goto close; }

    double t0 = now_ms();
    for (int i = 0; i < ITERATIONS; i++) {
        n2d_fill(&canvas, N2D_NULL, 0x80EB8080, N2D_BLEND_NONE);  // white
        // Blit 4 panels into 2x2 grid
        n2d_rectangle_t r0 = {12, 12, 404, 228};
        n2d_rectangle_t r1 = {424, 12, 404, 228};
        n2d_rectangle_t r2 = {12, 248, 404, 228};
        n2d_rectangle_t r3 = {424, 248, 404, 228};
        n2d_blit(&canvas, &r0, &panel, N2D_NULL, N2D_BLEND_NONE);
        n2d_blit(&canvas, &r1, &panel, N2D_NULL, N2D_BLEND_NONE);
        n2d_blit(&canvas, &r2, &panel, N2D_NULL, N2D_BLEND_NONE);
        n2d_blit(&canvas, &r3, &panel, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
    }
    double elapsed = now_ms() - t0;
    printf("[%s] comic: %d iterations, %.2f ms/iter (%.1f fps)\n",
           label, ITERATIONS, elapsed / ITERATIONS, ITERATIONS * 1000.0 / elapsed);

    n2d_free(&panel);
    n2d_free(&canvas);
close:
    n2d_close();
    return 0;
}

int main(void) {
    printf("=== nano2D Multi-Process Test ===\n\n");

    // First: sequential (baseline)
    printf("--- Sequential ---\n");
    run_letterbox("seq-letterbox");
    run_comic("seq-comic");

    // Then: parallel (two children)
    printf("\n--- Parallel (2 processes) ---\n");
    fflush(stdout);

    pid_t pid1 = fork();
    if (pid1 == 0) {
        _exit(run_letterbox("child-letterbox"));
    }
    pid_t pid2 = fork();
    if (pid2 == 0) {
        _exit(run_comic("child-comic"));
    }

    int status1, status2;
    waitpid(pid1, &status1, 0);
    waitpid(pid2, &status2, 0);

    printf("\nChild letterbox: %s\n", WIFEXITED(status1) && WEXITSTATUS(status1) == 0 ? "OK" : "FAILED");
    printf("Child comic:     %s\n", WIFEXITED(status2) && WEXITSTATUS(status2) == 0 ? "OK" : "FAILED");
    printf("\n=== Done ===\n");
    return 0;
}
