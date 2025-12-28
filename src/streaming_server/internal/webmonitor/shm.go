package webmonitor

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

#define RING_BUFFER_SIZE 30
#define MAX_DETECTIONS 10
#define MAX_FRAME_SIZE (1920 * 1080 * 3 / 2)

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

typedef struct {
    volatile uint32_t write_index;
    volatile uint32_t frame_interval_ms;
    Frame frames[RING_BUFFER_SIZE];
} SharedFrameBuffer;

typedef struct {
    int x;
    int y;
    int w;
    int h;
} BoundingBox;

typedef struct {
    char class_name[32];
    float confidence;
    BoundingBox bbox;
} Detection;

typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;
} LatestDetectionResult;

static SharedFrameBuffer* open_frame_shm(const char* name) {
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

static void close_frame_shm(SharedFrameBuffer* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(SharedFrameBuffer));
    }
}

static uint32_t frame_write_index(SharedFrameBuffer* shm) {
    if (shm == NULL) {
        return 0;
    }
    return __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
}

static int read_latest_frame(SharedFrameBuffer* shm, Frame* out) {
    if (!shm || !out) {
        return -1;
    }

    uint32_t write_idx = __atomic_load_n(&shm->write_index, __ATOMIC_ACQUIRE);
    if (write_idx == 0) {
        return -1;
    }

    uint32_t latest_idx = (write_idx - 1) % RING_BUFFER_SIZE;
    memcpy(out, &shm->frames[latest_idx], sizeof(Frame));
    return 0;
}

static LatestDetectionResult* open_detection_shm(const char* name) {
    int fd = shm_open(name, O_RDONLY, 0666);
    if (fd == -1) {
        return NULL;
    }

    LatestDetectionResult* shm = (LatestDetectionResult*)mmap(
        NULL,
        sizeof(LatestDetectionResult),
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

static void close_detection_shm(LatestDetectionResult* shm) {
    if (shm != NULL) {
        munmap((void*)shm, sizeof(LatestDetectionResult));
    }
}

static uint32_t detection_version(LatestDetectionResult* shm) {
    if (shm == NULL) {
        return 0;
    }
    return __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
}

static int read_detection_snapshot(LatestDetectionResult* shm, LatestDetectionResult* out) {
    if (!shm || !out) {
        return -1;
    }
    memcpy(out, shm, sizeof(LatestDetectionResult));
    return 0;
}
*/
import "C"

import (
	"bytes"
	"fmt"
	"time"
	"unsafe"
)

const (
	formatJPEG   = 0
	maxFrameSize = 1920 * 1080 * 3 / 2
)

type frameSnapshot struct {
	FrameNumber uint64
	Timestamp   time.Time
	CameraID    int
	Width       int
	Height      int
	Format      int
	Data        []byte
}

type shmReader struct {
	frameShm     *C.SharedFrameBuffer
	detectionShm *C.LatestDetectionResult
	lastDetVer   uint32
}

func newSHMReader(frameName, detectionName string) (*shmReader, error) {
	var frame *C.SharedFrameBuffer
	if frameName != "" {
		cName := C.CString(frameName)
		frame = C.open_frame_shm(cName)
		C.free(unsafe.Pointer(cName))
	}

	var detection *C.LatestDetectionResult
	if detectionName != "" {
		cName := C.CString(detectionName)
		detection = C.open_detection_shm(cName)
		C.free(unsafe.Pointer(cName))
	}

	if frame == nil && detection == nil {
		return nil, fmt.Errorf("shared memory not available")
	}

	return &shmReader{
		frameShm:     frame,
		detectionShm: detection,
	}, nil
}

func (r *shmReader) Close() {
	if r.frameShm != nil {
		C.close_frame_shm(r.frameShm)
		r.frameShm = nil
	}
	if r.detectionShm != nil {
		C.close_detection_shm(r.detectionShm)
		r.detectionShm = nil
	}
}

func (r *shmReader) Stats() (SharedMemoryStats, bool) {
	if r.frameShm == nil {
		return SharedMemoryStats{}, false
	}

	writeIndex := uint32(C.frame_write_index(r.frameShm))
	frameCount := min(int(writeIndex), 30)

	detVer := uint32(0)
	if r.detectionShm != nil {
		detVer = uint32(C.detection_version(r.detectionShm))
	}

	return SharedMemoryStats{
		FrameCount:         frameCount,
		TotalFramesWritten: int(writeIndex),
		DetectionVersion:   int(detVer),
		HasDetection:       boolToInt(detVer > 0),
	}, true
}

func (r *shmReader) LatestFrame() (*frameSnapshot, bool) {
	if r.frameShm == nil {
		return nil, false
	}

	var cFrame C.Frame
	if C.read_latest_frame(r.frameShm, &cFrame) != 0 {
		return nil, false
	}

	dataSize := int(cFrame.data_size)
	if dataSize < 0 || dataSize > maxFrameSize {
		return nil, false
	}

	data := make([]byte, dataSize)
	cData := (*[maxFrameSize]byte)(unsafe.Pointer(&cFrame.data[0]))[:dataSize:dataSize]
	copy(data, cData)

	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &frameSnapshot{
		FrameNumber: uint64(cFrame.frame_number),
		Timestamp:   timestamp,
		CameraID:    int(cFrame.camera_id),
		Width:       int(cFrame.width),
		Height:      int(cFrame.height),
		Format:      int(cFrame.format),
		Data:        data,
	}, true
}

func (r *shmReader) LatestDetection() (*DetectionResult, bool) {
	if r.detectionShm == nil {
		return nil, false
	}

	var snapshot C.LatestDetectionResult
	if C.read_detection_snapshot(r.detectionShm, &snapshot) != 0 {
		return nil, false
	}

	version := uint32(snapshot.version)
	if version == 0 || version == r.lastDetVer {
		return nil, false
	}

	r.lastDetVer = version

	result := DetectionResult{
		FrameNumber: int(snapshot.frame_number),
		Timestamp: float64(snapshot.timestamp.tv_sec) +
			float64(snapshot.timestamp.tv_nsec)/1e9,
		NumDetections: int(snapshot.num_detections),
		Version:       int(version),
	}

	if result.NumDetections > 0 {
		result.Detections = make([]Detection, 0, result.NumDetections)
		for i := 0; i < result.NumDetections && i < int(C.MAX_DETECTIONS); i++ {
			det := snapshot.detections[i]
			classBytes := C.GoBytes(unsafe.Pointer(&det.class_name[0]), 32)
			className := string(bytes.TrimRight(classBytes, "\x00"))
			result.Detections = append(result.Detections, Detection{
				ClassName:  className,
				Confidence: float64(det.confidence),
				BBox: BoundingBox{
					X: int(det.bbox.x),
					Y: int(det.bbox.y),
					W: int(det.bbox.w),
					H: int(det.bbox.h),
				},
			})
		}
	}

	return &result, true
}

func (r *shmReader) LatestJPEG() ([]byte, bool) {
	frame, ok := r.LatestFrame()
	if !ok {
		return nil, false
	}
	if frame.Format != formatJPEG || len(frame.Data) == 0 {
		return nil, false
	}
	return frame.Data, true
}
