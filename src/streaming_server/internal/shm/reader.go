package shm

/*
#cgo CFLAGS: -I../../../capture
#cgo LDFLAGS: -lrt -lpthread -lhbmem -L/usr/hobot/lib

#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <semaphore.h>
#include <errno.h>
#include <stdio.h>
#include <hb_mem_mgr.h>

#include "shm_constants.h"

static int g_hb_mem_initialized = 0;
static void ensure_hb_mem_init(void) {
    if (!g_hb_mem_initialized) {
        int ret = hb_mem_module_open();
        fprintf(stderr, "[shm/reader] hb_mem_module_open: ret=%d\n", ret);
        g_hb_mem_initialized = 1;
    }
}

#ifndef EINVAL
#define EINVAL 22
#endif

// H265ZeroCopyFrame matching shared_memory.h
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width, height;
    uint32_t data_size;
    uint8_t hb_mem_buf_data[48];  // Full hb_mem_common_buf_t
    volatile uint32_t version;
} H265ZeroCopyFrame;

typedef struct {
    uint8_t new_frame_sem[32];   // sem_t
    uint8_t consumed_sem[32];    // sem_t (also acts as ready signal)
    H265ZeroCopyFrame frame;
} H265ZeroCopyBuffer;

// Open H265 zero-copy SHM
H265ZeroCopyBuffer* open_h265_zc(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) return NULL;

    H265ZeroCopyBuffer* shm = (H265ZeroCopyBuffer*)mmap(
        NULL, sizeof(H265ZeroCopyBuffer),
        PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);

    if (shm == MAP_FAILED) return NULL;
    return shm;
}

void close_h265_zc(H265ZeroCopyBuffer* shm) {
    if (shm) munmap((void*)shm, sizeof(H265ZeroCopyBuffer));
}

// Read frame metadata (non-blocking)
int read_h265_frame(H265ZeroCopyBuffer* shm, H265ZeroCopyFrame* out) {
    if (!shm || !out) return -1;
    memcpy(out, (void*)&shm->frame, sizeof(H265ZeroCopyFrame));
    return 0;
}

// Zero-copy import handle — holds VPU buffer mapping until explicitly closed
typedef struct {
    void *virt_addr;
    uint32_t data_size;
    int fd;
} h265_import_handle_t;

// Import VPU buffer — returns virt_addr for zero-copy access (no memcpy)
int import_h265_open(const uint8_t* com_buf_data, uint32_t data_size,
                     h265_import_handle_t* out) {
    if (!com_buf_data || data_size == 0 || !out) return -1;
    ensure_hb_mem_init();

    hb_mem_common_buf_t in_buf;
    memcpy(&in_buf, com_buf_data, sizeof(hb_mem_common_buf_t));

    hb_mem_common_buf_t out_buf = {0};
    int ret = hb_mem_import_com_buf(&in_buf, &out_buf);
    if (ret != 0) return ret;

    hb_mem_invalidate_buf_with_vaddr((uint64_t)out_buf.virt_addr, out_buf.size);

    out->virt_addr = out_buf.virt_addr;
    out->data_size = data_size;
    out->fd = out_buf.fd;
    return 0;
}

// Release imported VPU buffer mapping
void import_h265_close(h265_import_handle_t* handle) {
    if (handle && handle->fd > 0) {
        hb_mem_free_buf(handle->fd);
        handle->fd = 0;
        handle->virt_addr = NULL;
    }
}


*/
import "C"
import (
	"fmt"
	"time"
	"unsafe"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

const (
	FormatJPEG = 0
	FormatNV12 = 1
	FormatRGB  = 2
	FormatH264 = 3
	FormatH265 = 4

)

// Reader reads H.265 frames from zero-copy shared memory
type Reader struct {
	shm         *C.H265ZeroCopyBuffer
	shmName     string
	lastVersion uint32
	prevHandle  C.h265_import_handle_t
	hasPrev     bool
}

// Version returns the current SHM frame version (atomic read)
func (r *Reader) Version() uint32 {
	if r.shm == nil {
		return 0
	}
	return uint32(r.shm.frame.version)
}

// MeasureFrameInterval observes version changes to determine camera frame interval.
// Returns measured interval and syncs to the frame boundary.
func (r *Reader) MeasureFrameInterval(samples int) time.Duration {
	if r.shm == nil || samples < 2 {
		return 33 * time.Millisecond // fallback 30fps
	}

	ver := r.Version()

	// Wait for first version change (sync to frame boundary)
	for r.Version() == ver {
		time.Sleep(100 * time.Microsecond)
	}

	// Measure intervals between subsequent version changes
	start := time.Now()
	ver = r.Version()
	for i := 0; i < samples; i++ {
		for r.Version() == ver {
			time.Sleep(100 * time.Microsecond)
		}
		ver = r.Version()
	}
	interval := time.Since(start) / time.Duration(samples)

	// Clamp to sane range (15-60fps)
	if interval < 16*time.Millisecond {
		interval = 16 * time.Millisecond
	}
	if interval > 66*time.Millisecond {
		interval = 66 * time.Millisecond
	}

	return interval
}

// NewReader creates a new H.265 zero-copy reader
func NewReader(shmName string) (*Reader, error) {
	if shmName == "" {
		shmName = "/pet_camera_h265_zc"
	}

	cName := C.CString(shmName)
	defer C.free(unsafe.Pointer(cName))

	var shm *C.H265ZeroCopyBuffer
	for i := 0; i < 30; i++ {
		shm = C.open_h265_zc(cName)
		if shm != nil {
			break
		}
		if i%5 == 0 {
			logger.Info("Reader", "Waiting for %s... (%d/30)", shmName, i+1)
		}
		time.Sleep(1 * time.Second)
	}

	if shm == nil {
		return nil, fmt.Errorf("failed to open %s (timeout 30s)", shmName)
	}

	logger.Info("Reader", "Opened H.265 zero-copy SHM: %s", shmName)

	return &Reader{
		shm:     shm,
		shmName: shmName,
	}, nil
}

// Close closes the reader
func (r *Reader) Close() error {
	if r.hasPrev {
		C.import_h265_close(&r.prevHandle)
		r.hasPrev = false
	}
	if r.shm != nil {
		C.close_h265_zc(r.shm)
		r.shm = nil
	}
	return nil
}

// ReadLatest reads the latest H.265 frame via zero-copy.
// Data points directly to VPU physical memory. Valid until next ReadLatest.
// Caller must ensure all synchronous consumers (SendFrame) finish before next call.
func (r *Reader) ReadLatest() (*types.VideoFrame, error) {
	if r.shm == nil {
		return nil, fmt.Errorf("shared memory not open")
	}

	var cFrame C.H265ZeroCopyFrame
	if C.read_h265_frame(r.shm, &cFrame) != 0 {
		return nil, nil
	}
	if cFrame.data_size == 0 {
		return nil, nil
	}

	// Release previous VPU buffer (SendFrame already consumed it synchronously)
	if r.hasPrev {
		C.import_h265_close(&r.prevHandle)
		r.hasPrev = false
	}

	// Import VPU buffer — zero-copy
	var handle C.h265_import_handle_t
	ret := C.import_h265_open(
		(*C.uint8_t)(unsafe.Pointer(&cFrame.hb_mem_buf_data[0])),
		cFrame.data_size,
		&handle,
	)
	if ret != 0 {
		return nil, fmt.Errorf("import_h265_open failed: %d", ret)
	}

	data := unsafe.Slice((*byte)(handle.virt_addr), handle.data_size)
	r.prevHandle = handle
	r.hasPrev = true

	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &types.VideoFrame{
		Data:        data,
		Timestamp:   timestamp,
		FrameNumber: uint64(cFrame.frame_number),
		Width:       int(cFrame.width),
		Height:      int(cFrame.height),
		IsIDR:       false,
	}, nil
}
