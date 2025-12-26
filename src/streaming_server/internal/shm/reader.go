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
    uint8_t data[MAX_FRAME_SIZE];
} Frame;

// SharedFrameBuffer structure matching shared_memory.h
typedef struct {
    volatile uint32_t write_index;
    volatile uint32_t frame_interval_ms;
    Frame frames[RING_BUFFER_SIZE];
} SharedFrameBuffer;

// Open shared memory for reading
SharedFrameBuffer* open_shm(const char* name) {
    int fd = shm_open(name, O_RDONLY, 0666);
    if (fd == -1) {
        return NULL;
    }

    SharedFrameBuffer* shm = (SharedFrameBuffer*)mmap(
        NULL,
        sizeof(SharedFrameBuffer),
        PROT_READ,
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

// Close shared memory
void close_shm(SharedFrameBuffer* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(SharedFrameBuffer));
    }
}

// Get current write index
uint32_t get_write_index(SharedFrameBuffer* shm) {
    return __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
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
	shm       *C.SharedFrameBuffer
	shmName   string
	lastIndex uint32
	frameNum  uint64
}

// NewReader creates a new shared memory reader
func NewReader(shmName string) (*Reader, error) {
	if shmName == "" {
		shmName = "/pet_camera_stream"
	}

	cName := C.CString(shmName)
	defer C.free(unsafe.Pointer(cName))

	shm := C.open_shm(cName)
	if shm == nil {
		return nil, fmt.Errorf("failed to open shared memory: %s", shmName)
	}

	return &Reader{
		shm:       shm,
		shmName:   shmName,
		lastIndex: 0,
		frameNum:  0,
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
// Returns nil if no new frame is available
func (r *Reader) ReadLatest() (*types.H264Frame, error) {
	if r.shm == nil {
		return nil, fmt.Errorf("shared memory not open")
	}

	// Get current write index
	writeIndex := uint32(C.get_write_index(r.shm))

	// Check if new frame is available
	if writeIndex == r.lastIndex {
		return nil, nil // No new frame
	}

	// Calculate actual index in ring buffer
	index := writeIndex % RingBufferSize

	// Read frame from shared memory
	var cFrame C.Frame
	if C.read_frame(r.shm, C.uint32_t(index), &cFrame) != 0 {
		return nil, fmt.Errorf("failed to read frame at index %d", index)
	}

	// Check if this is an H.264 frame
	if int(cFrame.format) != FormatH264 {
		// Skip non-H.264 frames
		r.lastIndex = writeIndex
		return nil, nil
	}

	// Convert C frame to Go frame
	frame := r.convertFrame(&cFrame)

	// Update state
	r.lastIndex = writeIndex
	r.frameNum++

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

// WaitForFrame waits for a new frame with timeout
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
