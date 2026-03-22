package webmonitor

/*
#cgo CFLAGS: -I../../../capture
#cgo LDFLAGS: -L../../../../build -ljpeg_encoder -lrgn_overlay -lrt -lpthread -lturbojpeg -lmultimedia -lhbmem -L/usr/hobot/lib

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <semaphore.h>
#include <errno.h>
#include <pthread.h>
#include <turbojpeg.h>
#include <hb_mem_mgr.h>
#include "jpeg_encoder.h"
#include "rgn_overlay.h"
#include "shm_constants.h"

// Global hardware JPEG encoder context (singleton for MJPEG streaming)
static jpeg_encoder_context_t g_hw_jpeg_encoder;
static int g_hw_jpeg_encoder_initialized = 0;
static int g_hw_jpeg_quality = 65;  // Configurable JPEG quality
static pthread_mutex_t g_hw_jpeg_encoder_mutex = PTHREAD_MUTEX_INITIALIZER;

// Set JPEG quality (called from Go)
static void set_jpeg_quality(int quality) {
    if (quality < 1) quality = 1;
    if (quality > 100) quality = 100;

    pthread_mutex_lock(&g_hw_jpeg_encoder_mutex);
    if (g_hw_jpeg_quality != quality) {
        g_hw_jpeg_quality = quality;
        // Force re-initialization with new quality on next encode
        if (g_hw_jpeg_encoder_initialized) {
            jpeg_encoder_destroy(&g_hw_jpeg_encoder);
            g_hw_jpeg_encoder_initialized = 0;
        }
    }
    pthread_mutex_unlock(&g_hw_jpeg_encoder_mutex);
}

// Get current JPEG quality
static int get_jpeg_quality(void) {
    return g_hw_jpeg_quality;
}

// Initialize hardware JPEG encoder (call once at startup)
static int hw_jpeg_encoder_init(int width, int height, int quality) {
    pthread_mutex_lock(&g_hw_jpeg_encoder_mutex);
    if (g_hw_jpeg_encoder_initialized) {
        pthread_mutex_unlock(&g_hw_jpeg_encoder_mutex);
        return 0;  // Already initialized
    }

    int ret = jpeg_encoder_create(&g_hw_jpeg_encoder, width, height, quality);
    if (ret == 0) {
        g_hw_jpeg_encoder_initialized = 1;
    }
    pthread_mutex_unlock(&g_hw_jpeg_encoder_mutex);
    return ret;
}

// Cleanup hardware JPEG encoder
static void hw_jpeg_encoder_cleanup(void) {
    pthread_mutex_lock(&g_hw_jpeg_encoder_mutex);
    if (g_hw_jpeg_encoder_initialized) {
        jpeg_encoder_destroy(&g_hw_jpeg_encoder);
        g_hw_jpeg_encoder_initialized = 0;
    }
    pthread_mutex_unlock(&g_hw_jpeg_encoder_mutex);
}

// Encode NV12 to JPEG using hardware encoder
// Returns 0 on success, -1 on failure
// On success, jpeg_out is allocated and must be freed by caller
static int hw_jpeg_encode(const uint8_t* nv12_data, int width, int height,
                          uint8_t** jpeg_out, size_t* jpeg_size) {
    if (!g_hw_jpeg_encoder_initialized) {
        // Try to initialize on first use with configured quality
        if (hw_jpeg_encoder_init(width, height, g_hw_jpeg_quality) != 0) {
            return -1;
        }
    }

    // Check if dimensions match
    if (g_hw_jpeg_encoder.width != width || g_hw_jpeg_encoder.height != height) {
        // Reinitialize with new dimensions
        hw_jpeg_encoder_cleanup();
        if (hw_jpeg_encoder_init(width, height, g_hw_jpeg_quality) != 0) {
            return -1;
        }
    }

    // Allocate output buffer (max size = raw frame size)
    size_t max_jpeg_size = width * height;  // Reasonable max for JPEG
    uint8_t* out_buf = (uint8_t*)malloc(max_jpeg_size);
    if (!out_buf) {
        return -1;
    }

    // NV12 layout: Y plane followed by UV plane
    const uint8_t* y_plane = nv12_data;
    const uint8_t* uv_plane = nv12_data + (width * height);

    pthread_mutex_lock(&g_hw_jpeg_encoder_mutex);
    int ret = jpeg_encoder_encode_frame(&g_hw_jpeg_encoder,
                                        y_plane, uv_plane,
                                        out_buf, jpeg_size,
                                        max_jpeg_size, 100);  // 100ms timeout
    pthread_mutex_unlock(&g_hw_jpeg_encoder_mutex);

    if (ret != 0) {
        free(out_buf);
        return -1;
    }

    *jpeg_out = out_buf;
    return 0;
}

// Constants from single source of truth
#include "shm_constants.h"

// Frame/SharedFrameBuffer removed — using ZeroCopyFrameBuffer now

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
    double timestamp;
    int num_detections;
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;
    sem_t detection_update_sem;
} LatestDetectionResult;

// ZeroCopy frame buffer for MJPEG (matching shared_memory.h)
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width, height;
    float brightness_avg;
    int32_t share_id[ZEROCOPY_MAX_PLANES];
    uint64_t plane_size[ZEROCOPY_MAX_PLANES];
    int32_t plane_cnt;
    uint8_t hb_mem_buf_data[HB_MEM_GRAPHIC_BUF_SIZE];
    volatile uint32_t version;
} ZeroCopyFrame;

typedef struct {
    uint8_t new_frame_sem[32];
    ZeroCopyFrame frame;
} ZeroCopyFrameBuffer;

static ZeroCopyFrameBuffer* open_frame_zc(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) return NULL;
    ZeroCopyFrameBuffer* shm = (ZeroCopyFrameBuffer*)mmap(
        NULL, sizeof(ZeroCopyFrameBuffer),
        PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    return (shm == MAP_FAILED) ? NULL : shm;
}

static void close_frame_zc(ZeroCopyFrameBuffer* shm) {
    if (shm) munmap((void*)shm, sizeof(ZeroCopyFrameBuffer));
}

// Read frame metadata snapshot (local copy to avoid torn reads)
static int read_zc_frame(ZeroCopyFrameBuffer* shm, ZeroCopyFrame* out) {
    if (!shm || !out) return -1;
    memcpy(out, (void*)&shm->frame, sizeof(ZeroCopyFrame));
    return 0;
}

// Import NV12 data from zero-copy frame via hb_mem (H.265 pattern: local copy, no consumed handshake)
static int import_zc_nv12(ZeroCopyFrame* f, uint8_t* dst, int dst_size, int* out_w, int* out_h) {
    if (!f || !dst) return -1;
    if (f->plane_cnt < 1) return -1;

    int total_size = 0;
    for (int i = 0; i < f->plane_cnt; i++) total_size += f->plane_size[i];
    if (total_size > dst_size) return -2;

    // Ensure hb_mem is initialized in this process
    {
        static int hb_mem_init_done = 0;
        if (!hb_mem_init_done) { hb_mem_module_open(); hb_mem_init_done = 1; }
    }

    // Import via full graphic buffer descriptor (same as Python)
    hb_mem_graphic_buf_t in_gbuf;
    memcpy(&in_gbuf, f->hb_mem_buf_data, sizeof(hb_mem_graphic_buf_t));

    hb_mem_graphic_buf_t out_gbuf = {0};
    if (hb_mem_import_graph_buf(&in_gbuf, &out_gbuf) != 0) return -3;

    // Copy plane data
    int offset = 0;
    for (int i = 0; i < f->plane_cnt && i < out_gbuf.plane_cnt; i++) {
        hb_mem_invalidate_buf_with_vaddr((uint64_t)out_gbuf.virt_addr[i], out_gbuf.size[i]);
        memcpy(dst + offset, out_gbuf.virt_addr[i], f->plane_size[i]);
        offset += f->plane_size[i];
    }

    // Release imported mapping
    for (int i = 0; i < out_gbuf.plane_cnt; i++) {
        if (out_gbuf.fd[i] > 0) hb_mem_free_buf(out_gbuf.fd[i]);
    }

    *out_w = f->width;
    *out_h = f->height;

    return total_size;
}

static LatestDetectionResult* open_detection_shm(const char* name) {
    int fd = shm_open(name, O_RDWR, 0666);
    if (fd == -1) {
        // fprintf(stderr, "Failed to shm_open detection: %s\n", name);
        return NULL;
    }

    LatestDetectionResult* shm = (LatestDetectionResult*)mmap(
        NULL,
        sizeof(LatestDetectionResult),
        PROT_READ | PROT_WRITE,  // Need write permission for sem_wait()
        MAP_SHARED,
        fd,
        0
    );

    close(fd);

    if (shm == MAP_FAILED) {
        // fprintf(stderr, "Failed to mmap detection shm\n");
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
    return shm->version;  // volatile read
}

static int read_detection_snapshot(LatestDetectionResult* shm, LatestDetectionResult* out) {
    if (!shm || !out) {
        return -1;
    }
    memcpy(out, shm, sizeof(LatestDetectionResult));
    return 0;
}

// Wait for detection update via semaphore (event-driven, replaces polling).
// Returns 0 on success (new detection available), -1 on timeout.
// Accumulated sem_posts are drained by repeated wait calls; the caller
// uses version checking to skip already-processed events.
static int wait_detection_update(LatestDetectionResult* shm, int timeout_ms) {
    if (!shm) return -1;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += timeout_ms / 1000;
    ts.tv_nsec += (timeout_ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec++;
        ts.tv_nsec -= 1000000000L;
    }
    return sem_timedwait(&shm->detection_update_sem, &ts);
}

// NOTE: CPU bitmap font and draw_*_nv12 functions removed - using hbn_rgn HW overlay

// NV12 to JPEG using TurboJPEG (optimized, avoids RGBA conversion)
// Returns allocated JPEG buffer and size (caller must free)
static int nv12_to_jpeg_turbo(const uint8_t* nv12, int width, int height, uint8_t** jpeg_out, unsigned long* jpeg_size) {
    tjhandle tj = tjInitCompress();
    if (!tj) {
        return -1;
    }

    int y_size = width * height;
    const uint8_t* y_plane = nv12;
    const uint8_t* uv_plane = nv12 + y_size;

    // Prepare plane pointers and strides for NV12
    const uint8_t* planes[3] = {y_plane, uv_plane, NULL};
    int strides[3] = {width, width, 0};  // NV12: Y stride = width, UV stride = width (interleaved U/V)

    unsigned char* jpeg_buf = NULL;
    unsigned long size = 0;

    // Compress NV12 directly to JPEG (TJ_YUV420 with interleaved UV)
    // Note: TurboJPEG doesn't have direct NV12 support, but we can use YUV420 planar
    // For NV12, we need to deinterlace UV first (or use RGB path)
    // Actually, let's use a simpler approach: convert to RGB via TurboJPEG's YUV decoder

    // Alternative: Use tjCompressFromYUVPlanes with proper format
    // TurboJPEG supports TJSAMP_420 which matches NV12 subsampling
    int result = tjCompressFromYUVPlanes(
        tj,
        planes,
        width,
        strides,
        height,
        TJSAMP_420,  // 4:2:0 subsampling (matches NV12)
        &jpeg_buf,
        &size,
        85,  // Quality
        TJFLAG_FASTDCT | TJFLAG_NOREALLOC
    );

    if (result != 0) {
        tjDestroy(tj);
        return -1;
    }

    *jpeg_out = jpeg_buf;
    *jpeg_size = size;
    tjDestroy(tj);
    return 0;
}
*/
import "C"

import (
	"bytes"
	"fmt"
	time "time"
	"unsafe"
)

const (
	formatJPEG   = 0
	formatNV12   = 1
	maxFrameSize = 1920 * 1080 * 3 / 2
)

// Package-level JPEG quality setting (thread-safe via CGO mutex)
var jpegQuality = 65

// SetJPEGQuality sets the JPEG encoding quality (1-100)
// Lower values = smaller file size = lower bandwidth
// Recommended: 60-70 for bandwidth-constrained environments
func SetJPEGQuality(quality int) {
	if quality < 1 {
		quality = 1
	} else if quality > 100 {
		quality = 100
	}
	jpegQuality = quality
	// Also update C-side quality for hardware encoder
	C.set_jpeg_quality(C.int(quality))
}

// GetJPEGQuality returns the current JPEG quality setting
func GetJPEGQuality() int {
	return jpegQuality
}

type frameSnapshot struct {
	FrameNumber uint64
	Timestamp   time.Time
	Width       int
	Height      int
	Format      int    // formatNV12=1
	Data        []byte // NV12 pixel data
}

type shmReader struct {
	frameShm      *C.ZeroCopyFrameBuffer
	frameBuf      []byte // Reusable NV12 import buffer
	detectionShm  *C.LatestDetectionResult
	detectionName string
	lastDetVer    uint32
}

func newSHMReader(frameName, detectionName string) (*shmReader, error) {
	var frame *C.ZeroCopyFrameBuffer
	if frameName != "" {
		cName := C.CString(frameName)
		frame = C.open_frame_zc(cName)
		C.free(unsafe.Pointer(cName))
	}

	r := &shmReader{
		frameShm:      frame,
		frameBuf:      make([]byte, 768*432*3/2), // 768x432 NV12
		detectionName: detectionName,
	}

	r.tryOpenDetection()

	if frame == nil && r.detectionShm == nil {
		return nil, fmt.Errorf("shared memory not available")
	}

	return r, nil
}

func (r *shmReader) tryOpenDetection() {
	if r.detectionShm != nil || r.detectionName == "" {
		return
	}
	cName := C.CString(r.detectionName)
	r.detectionShm = C.open_detection_shm(cName)
	C.free(unsafe.Pointer(cName))
	if r.detectionShm != nil {
		// fmt.Printf("Connected to detection SHM: %s\n", r.detectionName)
	}
}

func (r *shmReader) Close() {
	if r.frameShm != nil {
		C.close_frame_zc(r.frameShm)
		r.frameShm = nil
	}
	if r.detectionShm != nil {
		C.close_detection_shm(r.detectionShm)
		r.detectionShm = nil
	}
}

// NOTE: WaitNewFrame() removed - FrameBroadcaster uses polling mode
// NOTE: WaitNewDetection() removed - DetectionBroadcaster uses polling mode

func (r *shmReader) Stats() (SharedMemoryStats, bool) {
	if r.detectionShm == nil {
		r.tryOpenDetection()
	}

	detVer := uint32(0)
	if r.detectionShm != nil {
		detVer = uint32(C.detection_version(r.detectionShm))
	}

	frameVer := uint32(0)
	if r.frameShm != nil {
		frameVer = uint32(r.frameShm.frame.version)
	}

	return SharedMemoryStats{
		FrameCount:         int(frameVer),
		TotalFramesWritten: int(frameVer),
		DetectionVersion:   int(detVer),
		HasDetection:       boolToInt(detVer > 0),
	}, true
}

func (r *shmReader) LatestFrame() (*frameSnapshot, bool) {
	if r.frameShm == nil {
		return nil, false
	}

	// Local copy to avoid torn reads (same as H.265 pattern)
	var cFrame C.ZeroCopyFrame
	if C.read_zc_frame(r.frameShm, &cFrame) != 0 {
		return nil, false
	}
	if cFrame.version == 0 || cFrame.plane_cnt < 1 {
		return nil, false
	}

	var outW, outH C.int
	dataSize := int(C.import_zc_nv12(&cFrame,
		(*C.uint8_t)(unsafe.Pointer(&r.frameBuf[0])),
		C.int(len(r.frameBuf)), &outW, &outH))
	if dataSize <= 0 {
		return nil, false
	}

	data := make([]byte, dataSize)
	copy(data, r.frameBuf[:dataSize])

	timestamp := time.Unix(
		int64(cFrame.timestamp.tv_sec),
		int64(cFrame.timestamp.tv_nsec),
	)

	return &frameSnapshot{
		FrameNumber: uint64(cFrame.frame_number),
		Timestamp:   timestamp,
		Width:       int(outW),
		Height:      int(outH),
		Format:      formatNV12,
		Data:        data,
	}, true
}

func (r *shmReader) LatestDetection() (*DetectionResult, bool) {
	if r.detectionShm == nil {
		r.tryOpenDetection()
	}

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
		Timestamp: float64(snapshot.timestamp),
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

// WaitDetectionUpdate blocks until a new detection is posted to SHM
// or the timeout expires. Returns true if a new detection may be available.
func (r *shmReader) WaitDetectionUpdate(timeoutMs int) bool {
	if r.detectionShm == nil {
		r.tryOpenDetection()
	}
	if r.detectionShm == nil {
		return false
	}
	ret := C.wait_detection_update(r.detectionShm, C.int(timeoutMs))
	return ret == 0
}

func (r *shmReader) LatestNV12() (*NV12Frame, bool) {
	frame, ok := r.LatestFrame()
	if !ok || frame.Format != formatNV12 || len(frame.Data) == 0 {
		return nil, false
	}
	return &NV12Frame{
		Data:   frame.Data,
		Width:  frame.Width,
		Height: frame.Height,
	}, true
}

func (r *shmReader) LatestJPEG() ([]byte, bool) {
	frame, ok := r.LatestFrame()
	if !ok {
		return nil, false
	}

	// If already JPEG, return as-is
	if frame.Format == formatJPEG && len(frame.Data) > 0 {
		return frame.Data, true
	}

	// If NV12, convert to JPEG
	if frame.Format == formatNV12 && len(frame.Data) > 0 {
		jpegData, err := nv12ToJPEG(frame.Data, frame.Width, frame.Height)
		if err != nil {
			return nil, false
		}
		return jpegData, true
	}

	return nil, false
}

// nv12ToJPEG converts NV12 format to JPEG using hardware encoder with software fallback
func nv12ToJPEG(nv12Data []byte, width, height int) ([]byte, error) {
	return nv12ToJPEGHardware(nv12Data, width, height)
}

// nv12ToJPEGHardware converts NV12 to JPEG using D-Robotics hardware encoder
func nv12ToJPEGHardware(nv12Data []byte, width, height int) ([]byte, error) {
	if len(nv12Data) < width*height*3/2 {
		return nil, fmt.Errorf("invalid NV12 data size")
	}

	var jpegPtr *C.uint8_t
	var jpegSize C.size_t

	ret := C.hw_jpeg_encode(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width),
		C.int(height),
		&jpegPtr,
		&jpegSize,
	)

	if ret != 0 {
		return nil, fmt.Errorf("hardware JPEG encode failed: %d", ret)
	}

	// Copy data to Go-managed memory and free C allocation
	jpegData := C.GoBytes(unsafe.Pointer(jpegPtr), C.int(jpegSize))
	C.free(unsafe.Pointer(jpegPtr))

	return jpegData, nil
}

type overlayRect struct {
	X, Y, W, H       int
	YVal, UVal, VVal  uint8
	Thickness         int // 0 = filled, >0 = outline
}

type overlayText struct {
	x, y  int
	text  string
	textY uint8 // Y luminance for text (235=white)
	bgY   uint8 // Y luminance for background (16=black)
	scale int   // Font scale (1=small, 2=medium)
}

func drawOverlay(nv12Data []byte, width, height int, rects []overlayRect, texts []overlayText) {
	if len(nv12Data) < width*height*3/2 {
		return
	}

	cRects := make([]C.overlay_rect_t, len(rects))
	for i, r := range rects {
		cRects[i] = C.overlay_rect_t{
			x: C.int(r.X), y: C.int(r.Y), w: C.int(r.W), h: C.int(r.H),
			y_val: C.uint8_t(r.YVal), u_val: C.uint8_t(r.UVal), v_val: C.uint8_t(r.VVal),
			thickness: C.int(r.Thickness),
		}
	}

	cTexts := make([]C.overlay_text_t, len(texts))
	cStrings := make([]*C.char, len(texts))
	for i, t := range texts {
		cStrings[i] = C.CString(t.text)
		cTexts[i] = C.overlay_text_t{
			x:      C.int(t.x),
			y:      C.int(t.y),
			text:   cStrings[i],
			text_y: C.uint8_t(t.textY),
			bg_y:   C.uint8_t(t.bgY),
			scale:  C.int(t.scale),
		}
	}

	var rectsPtr *C.overlay_rect_t
	if len(cRects) > 0 {
		rectsPtr = &cRects[0]
	}
	var textsPtr *C.overlay_text_t
	if len(cTexts) > 0 {
		textsPtr = &cTexts[0]
	}

	C.rgn_overlay_draw(
		(*C.uint8_t)(unsafe.Pointer(&nv12Data[0])),
		C.int(width), C.int(height),
		rectsPtr, C.int(len(cRects)),
		textsPtr, C.int(len(cTexts)),
	)

	for _, s := range cStrings {
		C.free(unsafe.Pointer(s))
	}
}

// drawTextWithBackgroundNV12 is a compatibility wrapper used by comic_capture.go
func drawTextWithBackgroundNV12(nv12Data []byte, width, height, x, y int, text string, textColor, bgColor uint8, scale int) {
	drawOverlay(nv12Data, width, height, nil, []overlayText{
		{x: x, y: y, text: text, textY: textColor, bgY: bgColor, scale: scale},
	})
}

// CleanupHardwareJPEGEncoder releases hardware JPEG encoder resources
// Should be called during application shutdown
func CleanupHardwareJPEGEncoder() {
	C.hw_jpeg_encoder_cleanup()
}