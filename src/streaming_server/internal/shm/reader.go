package shm

/*
#cgo CFLAGS: -I../../../capture
#cgo LDFLAGS: -lrt -lpthread

#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <semaphore.h>
#include <errno.h>

// Ensure EINVAL is defined
#ifndef EINVAL
#define EINVAL 22
#endif

// Constants from shared_memory.h
#define SHM_NAME_STREAM "/pet_camera_stream"
#define RING_BUFFER_SIZE 30
#define MAX_FRAME_SIZE (1920 * 1080 * 3 / 2)

// Frame structure matching shared_memory.h
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width;
    int height;
    int format;
    size_t data_size;
    // Brightness metrics (Phase 0: ISP low-light enhancement)
    float brightness_avg;       // Y-plane average brightness (0-255)
    uint32_t brightness_lux;    // Environment illuminance from ISP cur_lux
    uint8_t brightness_zone;    // 0=dark, 1=dim, 2=normal, 3=bright
    uint8_t correction_applied; // 1 if ISP low-light correction is active
    uint8_t _reserved[2];       // Padding for alignment
    uint8_t data[MAX_FRAME_SIZE];
} Frame;

// SharedFrameBuffer structure matching shared_memory.h
typedef struct {
    volatile uint32_t write_index;
    volatile uint32_t frame_interval_ms;
    uint8_t new_frame_sem[32];  // sem_t semaphore (32 bytes on Linux)
    Frame frames[RING_BUFFER_SIZE];
} SharedFrameBuffer;

// Open shared memory for reading (RDWR needed for sem_wait)
SharedFrameBuffer* open_shm(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) {
        return NULL;
    }

    SharedFrameBuffer* shm = (SharedFrameBuffer*)mmap(
        NULL,
        sizeof(SharedFrameBuffer),
        PROT_READ | PROT_WRITE,  // WRITE needed for sem_wait
        MAP_SHARED,
        fd,
        0
    );

    close(fd);

    if (shm == MAP_FAILED) {
        return NULL;
    }

    return shm;
}

// Wait for new frame notification with timeout
// Returns: 0 on success, -1 on timeout, negative errno on error
int wait_new_frame(SharedFrameBuffer* shm, int timeout_ms) {
    if (shm == NULL) {
        return -EINVAL;
    }

    if (timeout_ms <= 0) {
        // No timeout, block indefinitely
        if (sem_wait((sem_t*)&shm->new_frame_sem) != 0) {
            return -errno;  // Return negative errno
        }
        return 0;
    }

    // With timeout
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
        return -errno;
    }

    // Add timeout
    ts.tv_sec += timeout_ms / 1000;
    ts.tv_nsec += (timeout_ms % 1000) * 1000000;
    if (ts.tv_nsec >= 1000000000) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000;
    }

    int ret = sem_timedwait((sem_t*)&shm->new_frame_sem, &ts);
    if (ret == -1) {
        return -errno;  // Return negative errno (including ETIMEDOUT)
    }

    return 0;
}

// Close shared memory
void close_shm(SharedFrameBuffer* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(SharedFrameBuffer));
    }
}

// Get current write index (volatile read - no atomic needed for 32-bit on x86/ARM64)
uint32_t get_write_index(SharedFrameBuffer* shm) {
    return shm->write_index;
}

// Read frame at specific index
int read_frame(SharedFrameBuffer* shm, uint32_t index, Frame* out) {
    if (index >= RING_BUFFER_SIZE) {
        return -1;
    }

    // Copy frame data (memcpy is safe for reading from shared memory)
    memcpy(out, &shm->frames[index], sizeof(Frame));
    return 0;
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
	// Format constants matching shared_memory.h
	FormatJPEG = 0
	FormatNV12 = 1
	FormatRGB  = 2
	FormatH264 = 3

	// Buffer constants
	RingBufferSize = 30
	MaxFrameSize   = 1920 * 1080 * 3 / 2
)

// Reader reads H.264 frames from shared memory
type Reader struct {
	shm     *C.SharedFrameBuffer
	shmName string
}

// NewReader creates a new shared memory reader
func NewReader(shmName string) (*Reader, error) {
	if shmName == "" {
		shmName = "/pet_camera_stream"
	}

	cName := C.CString(shmName)
	defer C.free(unsafe.Pointer(cName))

	var shm *C.SharedFrameBuffer
	// Retry for up to 30 seconds
	for i := 0; i < 30; i++ {
		shm = C.open_shm(cName)
		if shm != nil {
			break
		}
		// Log waiting status (only every 5 seconds to reduce noise)
		if i%5 == 0 {
			logger.Info("Reader", "Waiting for shared memory %s to appear... (%d/30)", shmName, i+1)
		}
		time.Sleep(1 * time.Second)
	}

	if shm == nil {
		return nil, fmt.Errorf("failed to open shared memory: %s (timeout after 30s)", shmName)
	}

	logger.Info("Reader", "Successfully opened shared memory: %s", shmName)

	return &Reader{
		shm:     shm,
		shmName: shmName,
	}, nil
}

// Close closes the shared memory reader
func (r *Reader) Close() error {
	if r.shm != nil {
		C.close_shm(r.shm)
		r.shm = nil
	}
	return nil
}

// ReadLatest reads the latest frame from shared memory
// NOTE: Duplicate check removed - polling interval ≈ frame interval, duplicates are rare
// and processing same frame twice has no UX impact
func (r *Reader) ReadLatest() (*types.H264Frame, error) {
	if r.shm == nil {
		return nil, fmt.Errorf("shared memory not open")
	}

	// Get current write index
	writeIndex := uint32(C.get_write_index(r.shm))
	if writeIndex == 0 {
		return nil, nil // No frames written yet
	}

	// Read the latest frame
	latestIndex := writeIndex - 1
	index := latestIndex % RingBufferSize

	// Read frame from shared memory
	var cFrame C.Frame
	if C.read_frame(r.shm, C.uint32_t(index), &cFrame) != 0 {
		return nil, fmt.Errorf("failed to read frame at index %d", index)
	}

	// Check if this is an H.264 frame
	if int(cFrame.format) != FormatH264 {
		return nil, nil
	}

	// Convert C frame to Go frame
	frame := r.convertFrame(&cFrame)

	return frame, nil
}

// convertFrame converts C Frame to Go H264Frame
func (r *Reader) convertFrame(cFrame *C.Frame) *types.H264Frame {
	dataSize := int(cFrame.data_size)

	// Copy frame data from C array to Go slice
	data := make([]byte, dataSize)
	cData := (*[MaxFrameSize]byte)(unsafe.Pointer(&cFrame.data[0]))[:dataSize:dataSize]
	copy(data, cData)

	// Convert timespec to time.Time
	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &types.H264Frame{
		Data:      data,
		Timestamp: timestamp,
		FrameNum:  uint64(cFrame.frame_number),
		Width:     int(cFrame.width),
		Height:    int(cFrame.height),
		IsIDR:     false, // Will be determined by H264 processor
	}
}

// WaitNewFrame waits for new frame notification via semaphore
// Returns error on timeout or failure
func (r *Reader) WaitNewFrame(timeout time.Duration) error {
	if r.shm == nil {
		return fmt.Errorf("shared memory not open")
	}

	timeoutMs := int(timeout.Milliseconds())
	result := int(C.wait_new_frame(r.shm, C.int(timeoutMs)))

	if result == 0 {
		return nil // Success
	}

	// Result is negative errno
	errNum := -result

	// Map common errno values
	switch errNum {
	case 110: // ETIMEDOUT
		return fmt.Errorf("timeout")
	case 22: // EINVAL
		return fmt.Errorf("invalid argument (errno %d)", errNum)
	case 4: // EINTR
		return fmt.Errorf("interrupted (errno %d)", errNum)
	default:
		return fmt.Errorf("semaphore wait failed (errno %d)", errNum)
	}
}

// WaitForFrame waits for a new frame with timeout (deprecated - use WaitNewFrame + ReadLatest)
func (r *Reader) WaitForFrame(timeout time.Duration) (*types.H264Frame, error) {
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

		// Sleep briefly to avoid busy-waiting
		time.Sleep(10 * time.Millisecond)
	}
}
