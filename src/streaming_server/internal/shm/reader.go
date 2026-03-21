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
#include <hb_mem_mgr.h>

#include "shm_constants.h"

static int g_hb_mem_initialized = 0;
static void ensure_hb_mem_init(void) {
    if (!g_hb_mem_initialized) {
        hb_mem_module_open();
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
    int32_t share_id;
    uint32_t data_size;
    uint32_t buf_size;
    uint64_t phy_ptr;
    volatile uint32_t version;
    volatile uint8_t consumed;
    uint8_t _pad[3];
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

// Wait for new frame with timeout
int wait_h265_frame(H265ZeroCopyBuffer* shm, int timeout_ms) {
    if (!shm) return -EINVAL;

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += timeout_ms / 1000;
    ts.tv_nsec += (timeout_ms % 1000) * 1000000;
    if (ts.tv_nsec >= 1000000000) {
        ts.tv_sec++;
        ts.tv_nsec -= 1000000000;
    }

    return sem_timedwait((sem_t*)&shm->new_frame_sem, &ts) == 0 ? 0 : -errno;
}

// Read frame metadata (non-blocking)
int read_h265_frame(H265ZeroCopyBuffer* shm, H265ZeroCopyFrame* out) {
    if (!shm || !out) return -1;
    memcpy(out, (void*)&shm->frame, sizeof(H265ZeroCopyFrame));
    return 0;
}

// Import VPU buffer via share_id and copy H.265 data to Go buffer
int import_h265_data(int32_t share_id, uint32_t data_size,
                     uint8_t* dst, uint32_t dst_size) {
    if (share_id < 0 || data_size == 0 || !dst || data_size > dst_size) return -1;
    ensure_hb_mem_init();

    // Set up import request with share_id
    hb_mem_common_buf_t in_buf = {0};
    in_buf.share_id = share_id;

    hb_mem_common_buf_t out_buf = {0};
    int ret = hb_mem_import_com_buf(&in_buf, &out_buf);
    if (ret != 0) return ret;

    // Invalidate cache before reading
    hb_mem_invalidate_buf_with_vaddr((uint64_t)out_buf.virt_addr, out_buf.size);

    // Copy H.265 data to Go-managed buffer
    memcpy(dst, out_buf.virt_addr, data_size);

    // Release imported mapping (does NOT free the original — encoder still owns it)
    hb_mem_free_buf(out_buf.fd);

    return 0;
}

// Signal consumed (encoder can release VPU buffer)
void mark_h265_consumed(H265ZeroCopyBuffer* shm) {
    if (!shm) return;
    __atomic_store_n(&shm->frame.consumed, 1, __ATOMIC_RELEASE);
    sem_post((sem_t*)&shm->consumed_sem);
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

	// Max H.265 frame size for buffer allocation (1080p bitstream)
	MaxH265FrameSize = 512 * 1024 // 512KB should be enough for one frame
)

// Reader reads H.265 frames from zero-copy shared memory
type Reader struct {
	shm      *C.H265ZeroCopyBuffer
	shmName  string
	buf      []byte // Reusable buffer for imported data
	signaled bool   // True after first ready signal sent
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
		buf:     make([]byte, MaxH265FrameSize),
	}, nil
}

// Close closes the reader
func (r *Reader) Close() error {
	if r.shm != nil {
		C.close_h265_zc(r.shm)
		r.shm = nil
	}
	return nil
}

// ReadLatest reads the latest H.265 frame via zero-copy import
func (r *Reader) ReadLatest() (*types.VideoFrame, error) {
	if r.shm == nil {
		return nil, fmt.Errorf("shared memory not open")
	}

	// First call: signal ready by posting consumed_sem
	// (consumed_sem starts at 0, encoder skips until we post)
	if !r.signaled {
		C.mark_h265_consumed(r.shm)
		r.signaled = true
	}

	// Wait for encoder to write a frame
	if err := r.WaitNewFrame(50 * time.Millisecond); err != nil {
		return nil, nil // No frame yet
	}

	// Read frame metadata
	var cFrame C.H265ZeroCopyFrame
	if C.read_h265_frame(r.shm, &cFrame) != 0 {
		return nil, nil
	}

	if cFrame.share_id < 0 || cFrame.data_size == 0 {
		return nil, nil
	}

	dataSize := uint32(cFrame.data_size)
	if dataSize > MaxH265FrameSize {
		// Reallocate if frame is larger than expected
		r.buf = make([]byte, dataSize)
	}

	// Import VPU buffer and copy H.265 data
	ret := C.import_h265_data(
		cFrame.share_id,
		cFrame.data_size,
		(*C.uint8_t)(unsafe.Pointer(&r.buf[0])),
		C.uint32_t(len(r.buf)),
	)

	// Signal consumed immediately so encoder can release VPU buffer
	C.mark_h265_consumed(r.shm)

	if ret != 0 {
		return nil, fmt.Errorf("import_h265_data failed: %d (share_id=%d)", ret, cFrame.share_id)
	}

	// Build frame
	data := make([]byte, dataSize)
	copy(data, r.buf[:dataSize])

	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &types.VideoFrame{
		Data:      data,
		Timestamp: timestamp,
		FrameNum:  uint64(cFrame.frame_number),
		Width:     int(cFrame.width),
		Height:    int(cFrame.height),
		IsIDR:     false,
	}, nil
}

// WaitNewFrame waits for a new frame notification via semaphore
func (r *Reader) WaitNewFrame(timeout time.Duration) error {
	if r.shm == nil {
		return fmt.Errorf("shared memory not open")
	}

	timeoutMs := int(timeout.Milliseconds())
	result := int(C.wait_h265_frame(r.shm, C.int(timeoutMs)))

	if result == 0 {
		return nil
	}

	errNum := -result
	switch errNum {
	case 110: // ETIMEDOUT
		return fmt.Errorf("timeout")
	default:
		return fmt.Errorf("sem wait failed (errno %d)", errNum)
	}
}

// WaitForFrame waits for a frame with timeout (compatibility)
func (r *Reader) WaitForFrame(timeout time.Duration) (*types.VideoFrame, error) {
	deadline := time.Now().Add(timeout)
	for {
		frame, err := r.ReadLatest()
		if err != nil {
			return nil, err
		}
		if frame != nil {
			return frame, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timeout waiting for frame")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
