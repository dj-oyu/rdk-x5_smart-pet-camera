/*
 * nano2D.h - IDE STUB ONLY (D-Robotics GC820 nano2D GPU API)
 *
 * Stub for VS Code IntelliSense. NOT used in any build.
 */

#ifndef NANO2D_H
#define NANO2D_H

#include <stdint.h>

typedef uint64_t n2d_uintptr_t;

typedef enum {
    N2D_SUCCESS = 0,
    /* error codes are negative */
} n2d_error_t;

#define N2D_IS_ERROR(e) ((e) != N2D_SUCCESS)

/* Pixel formats */
typedef enum {
    N2D_NV12   = 0,
    N2D_ARGB32 = 1,
    N2D_RGB565 = 2,
} n2d_format_t;

/* Orientation */
typedef enum {
    N2D_0   = 0,
    N2D_90  = 1,
    N2D_180 = 2,
    N2D_270 = 3,
} n2d_orientation_t;

/* Source types */
typedef enum {
    N2D_SOURCE_DEFAULT = 0,
} n2d_source_type_t;

/* Tiling modes */
typedef enum {
    N2D_LINEAR = 0,
    N2D_TILED  = 1,
} n2d_tiling_t;

/* Cache modes */
typedef enum {
    N2D_CACHE_128 = 0,
} n2d_cache_mode_t;

/* Blending modes */
typedef enum {
    N2D_BLEND_NONE = 0,
    N2D_BLEND_SRC  = 1,
} n2d_blend_t;

/* Device/core IDs */
typedef enum {
    N2D_DEVICE_0 = 0,
} n2d_device_id_t;

typedef enum {
    N2D_CORE_0 = 0,
} n2d_core_id_t;

/* NULL constant */
#define N2D_NULL ((void *)0)

/* Buffer descriptor */
typedef struct {
    void             *memory;
    n2d_uintptr_t     handle;
    n2d_format_t      format;
    int               width;
    int               height;
    int               alignedw;
    int               alignedh;
    int               stride;
    n2d_orientation_t orientation;
    n2d_source_type_t srcType;
    n2d_tiling_t      tiling;
    n2d_cache_mode_t  cacheMode;
} n2d_buffer_t;

/* Rectangle */
typedef struct {
    int x;
    int y;
    int width;
    int height;
} n2d_rectangle_t;

/* Memory wrap flags */
typedef enum {
    N2D_WRAP_FROM_USERMEMORY = 0,
} n2d_wrap_flag_t;

/* User memory descriptor for n2d_wrap */
typedef struct {
    n2d_wrap_flag_t flag;
    n2d_uintptr_t   logical;
    n2d_uintptr_t   physical;
    uint64_t        size;
} n2d_user_memory_desc_t;

/* Alignment macro (aligns x up to the nearest multiple of align) */
#define gcmALIGN(x, align) (((x) + ((align) - 1)) & ~((align) - 1))

/* Device/core selection */
n2d_error_t n2d_switch_device(n2d_device_id_t device);
n2d_error_t n2d_switch_core(n2d_core_id_t core);

/* Lifecycle */
n2d_error_t n2d_open(void);
n2d_error_t n2d_close(void);

/* Operations */
n2d_error_t n2d_fill(n2d_buffer_t *dst, const n2d_rectangle_t *rect,
                      uint32_t color, n2d_blend_t blend);
n2d_error_t n2d_blit(n2d_buffer_t *dst, const n2d_rectangle_t *dst_rect,
                      n2d_buffer_t *src, const n2d_rectangle_t *src_rect,
                      n2d_blend_t blend);
n2d_error_t n2d_commit(void);
n2d_error_t n2d_wrap(const n2d_user_memory_desc_t *desc, n2d_uintptr_t *handle);
n2d_error_t n2d_map(n2d_buffer_t *buf);
n2d_error_t n2d_free(n2d_buffer_t *buf);

#endif /* NANO2D_H */
