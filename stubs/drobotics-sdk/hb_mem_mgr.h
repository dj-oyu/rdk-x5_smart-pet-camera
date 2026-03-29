/*
 * hb_mem_mgr.h - IDE STUB ONLY (D-Robotics RDK-X5 hbmem SDK)
 *
 * This file exists solely for VS Code IntelliSense on dev machines that do not
 * have the D-Robotics SDK installed. It is NOT used in any build. The real
 * header at /usr/include/hb_mem_mgr.h is used when compiling on the board.
 */

#ifndef HB_MEM_MGR_H
#define HB_MEM_MGR_H

#include <stdint.h>
#include <stddef.h>

/* ── Layout verified from hb_mem_bindings.py _GRAPH_BUF_LAYOUT and test_shm.c ── */

/*
 * hb_mem_graphic_buf_t — 160 bytes total
 * Field offsets (from _GRAPH_BUF_LAYOUT):
 *   fd:        0   (int32_t[3], 12 bytes)
 *   plane_cnt: 12  (int32_t, 4 bytes)
 *   width:     16  (int32_t, 4 bytes)
 *   height:    20  (int32_t, 4 bytes)
 *   format:    24  (int32_t, 4 bytes)
 *   stride:    28  (int32_t, 4 bytes)
 *   vstride:   32  (int32_t, 4 bytes)
 *   is_contig: 36  (int32_t, 4 bytes)
 *   share_id:  40  (int32_t[3], 12 bytes)
 *   [4-byte natural padding before int64_t]
 *   flags:     56  (int64_t, 8 bytes)
 *   size:      64  (uint64_t[3], 24 bytes)
 *   virt_addr: 88  (uint64_t[3], 24 bytes)
 *   phys_addr: 112 (uint64_t[3], 24 bytes)
 *   offset:    136 (uint64_t[3], 24 bytes)
 */
typedef struct {
    int32_t  fd[3];
    int32_t  plane_cnt;
    int32_t  width;
    int32_t  height;
    int32_t  format;
    int32_t  stride;
    int32_t  vstride;
    int32_t  is_contig;
    int32_t  share_id[3];
    /* 4-byte natural padding added by compiler for int64_t alignment */
    int64_t  flags;
    uint64_t size[3];
    uint64_t virt_addr[3];
    uint64_t phys_addr[3];
    uint64_t offset[3];
} hb_mem_graphic_buf_t;

/*
 * hb_mem_common_buf_t — 48 bytes total
 * Treated as opaque blob for cross-process import.
 */
typedef struct {
    int32_t  fd;
    int32_t  share_id;
    uint64_t size;
    uint64_t phys_addr;
    uint64_t virt_addr;
    int64_t  flags;
    uint8_t  _reserved[8];
} hb_mem_common_buf_t;

/* Memory usage flags */
#define HB_MEM_USAGE_CPU_READ_OFTEN  (1 << 0)
#define HB_MEM_USAGE_CPU_WRITE_OFTEN (1 << 1)
#define HB_MEM_USAGE_CACHED          (1 << 2)

/* Module lifecycle */
int hb_mem_module_open(void);
int hb_mem_module_close(void);

/* Cache operations */
int hb_mem_invalidate_buf_with_vaddr(uint64_t vaddr, uint64_t size);

/* Buffer import */
int hb_mem_get_com_buf_with_vaddr(uint64_t vaddr, hb_mem_common_buf_t *buf);
int hb_mem_import_com_buf(hb_mem_common_buf_t *buf, hb_mem_common_buf_t *out);
int hb_mem_import_graph_buf(hb_mem_graphic_buf_t *buf, hb_mem_graphic_buf_t *out);

#endif /* HB_MEM_MGR_H */
