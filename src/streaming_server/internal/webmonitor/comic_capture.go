package webmonitor

/*
#cgo CFLAGS: -I../../../capture -I/usr/include/GC820
#cgo LDFLAGS: -L../../../../build -ln2d_comic -lNano2D -lNano2Dutil

#include "n2d_comic.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unsafe"
)

// NV12Frame holds an NV12 frame with dimensions.
type NV12Frame struct {
	Data          []byte
	Width, Height int
}

// frameSource abstracts SHM access for testability.
type frameSource interface {
	LatestDetection() (*DetectionResult, bool)
	LatestNV12() (*NV12Frame, bool)
}

type comicState int

const (
	comicIdle comicState = iota
	comicCapturing
)

type capturedPanel struct {
	nv12Data    []byte
	width       int
	height      int
	timestamp   time.Time
	bbox        *BoundingBox
	placeholder bool   // filled panel (wider crop to show context)
	petClass    string // "mike", "chatora", "other", or "" if unknown
}

// ComicCapture monitors detection SHM for cat presence and produces
// 4-panel comic-strip images from captured JPEG frames.
type ComicCapture struct {
	src       frameSource
	outputDir string

	state             comicState
	catFirstSeen      time.Time
	lastCatSeen       time.Time
	lastCatBBox       *BoundingBox
	lastCatClass      string
	lastVersionChange time.Time
	sessionID         string
	panels            []capturedPanel
	lastCaptureTime   time.Time
	captureStartTime  time.Time
	recentComics      []time.Time
	mu                sync.Mutex
	stop              chan struct{}
	done              chan struct{}

	// Configurable parameters
	DetectionThreshold  time.Duration // continuous cat before capture starts
	BaseCaptureInterval time.Duration // base interval between panels
	DetectionLost       time.Duration // no version change → cat lost
	MaxPanels           int
	RateLimitWindow     time.Duration
	RateLimitMax        int
	SkipStitch          bool // Skip nano2D composition (for testing)
}

func NewComicCapture(src frameSource, outputDir string) *ComicCapture {
	return &ComicCapture{
		src:                 src,
		outputDir:           outputDir,
		state:               comicIdle,
		stop:                make(chan struct{}),
		done:                make(chan struct{}),
		DetectionThreshold:  5 * time.Second,
		BaseCaptureInterval: 10 * time.Second,
		DetectionLost:       5 * time.Second,
		MaxPanels:           4,
		RateLimitWindow:     5 * time.Minute,
		RateLimitMax:        3,
	}
}

func (cc *ComicCapture) Start() { go cc.run() }

func (cc *ComicCapture) Stop() {
	close(cc.stop)
	<-cc.done
}

func (cc *ComicCapture) run() {
	defer close(cc.done)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-cc.stop:
			return
		case <-ticker.C:
			cc.tick(time.Now())
		}
	}
}

func (cc *ComicCapture) tick(now time.Time) {
	cc.mu.Lock()
	defer cc.mu.Unlock()

	// Poll detection SHM
	det, ok := cc.src.LatestDetection()
	if ok {
		cc.lastVersionChange = now
		if hasPet(det) {
			cc.lastCatSeen = now
			cc.lastCatBBox, cc.lastCatClass = petDetection(det)
			if cc.catFirstSeen.IsZero() {
				cc.catFirstSeen = now
			}
		} else if det.NumDetections > 0 {
			// Detection is active but no pet found — reset immediately.
			cc.catFirstSeen = time.Time{}
		}
		// If NumDetections == 0 (empty frame), don't reset — YOLO may
		// miss a frame or two while the pet is still present.
	}

	catGone := !cc.lastCatSeen.IsZero() && now.Sub(cc.lastCatSeen) > cc.DetectionLost
	versionStale := !cc.lastVersionChange.IsZero() && now.Sub(cc.lastVersionChange) > cc.DetectionLost

	// Reset continuous tracking only after the full timeout elapses
	if catGone || versionStale {
		cc.catFirstSeen = time.Time{}
	}

	switch cc.state {
	case comicIdle:
		catContinuous := !cc.catFirstSeen.IsZero() && now.Sub(cc.catFirstSeen) >= cc.DetectionThreshold
		if catContinuous && cc.canGenerateComic(now) {
			cc.startCapturing(now)
		}

	case comicCapturing:
		if catGone || versionStale {
			cc.finishCapturing()
			return
		}
		interval := cc.currentInterval(now)
		if now.Sub(cc.lastCaptureTime) >= interval {
			cc.capturePanel(now)
			if len(cc.panels) >= cc.MaxPanels {
				cc.finishCapturing()
				// Continue if cat is still present and rate limit allows
				catStillHere := !cc.lastCatSeen.IsZero() && !catGone
				if catStillHere && cc.canGenerateComic(now) {
					cc.startCapturing(now)
				}
			}
		}
	}
}

// currentInterval returns the adaptive capture interval based on elapsed time.
func (cc *ComicCapture) currentInterval(now time.Time) time.Duration {
	elapsed := now.Sub(cc.captureStartTime).Minutes()
	factor := 1.0 + elapsed/5.0
	return time.Duration(float64(cc.BaseCaptureInterval) * factor)
}

// canGenerateComic checks the sliding-window rate limit.
func (cc *ComicCapture) canGenerateComic(now time.Time) bool {
	cutoff := now.Add(-cc.RateLimitWindow)
	count := 0
	for _, t := range cc.recentComics {
		if t.After(cutoff) {
			count++
		}
	}
	return count < cc.RateLimitMax
}

func (cc *ComicCapture) startCapturing(now time.Time) {
	cc.state = comicCapturing
	cc.sessionID = now.Format("20060102_150405")
	cc.panels = nil
	cc.captureStartTime = now
	log.Printf("[Comic] Capture started: session=%s", cc.sessionID)
	// Capture first panel immediately
	cc.capturePanel(now)
}

func (cc *ComicCapture) finishCapturing() {
	// Fill missing panels with current frame + last known bbox (wide crop)
	if n := len(cc.panels); n > 0 && n < cc.MaxPanels {
		cc.fillMissingPanels(time.Now())
	}
	if len(cc.panels) > 0 && !cc.SkipStitch {
		cc.stitchAndSave()
	}
	cc.state = comicIdle
	cc.panels = nil
	cc.catFirstSeen = time.Time{}
	log.Printf("[Comic] Session finished: %s", cc.sessionID)
}

// fillMissingPanels captures the current frame for each missing slot,
// using the last known bbox as a hint (the pet may still be in frame
// even if the detector missed it).
func (cc *ComicCapture) fillMissingPanels(now time.Time) {
	frame, ok := cc.src.LatestNV12()
	if !ok {
		return
	}
	var lastBBox *BoundingBox
	for i := len(cc.panels) - 1; i >= 0; i-- {
		if cc.panels[i].bbox != nil {
			bb := *cc.panels[i].bbox
			lastBBox = &bb
			break
		}
	}
	for len(cc.panels) < cc.MaxPanels {
		panel := capturedPanel{
			nv12Data:    append([]byte(nil), frame.Data...),
			width:       frame.Width,
			height:      frame.Height,
			timestamp:   now,
			bbox:        lastBBox,
			placeholder: true,
		}
		cc.panels = append(cc.panels, panel)
		log.Printf("[Comic] Panel %d filled (placeholder, session=%s)", len(cc.panels), cc.sessionID)
	}
}

func (cc *ComicCapture) capturePanel(now time.Time) {
	frame, ok := cc.src.LatestNV12()
	if !ok {
		return
	}

	// Classify pet color from bbox region
	var petClass string
	if cc.lastCatBBox != nil {
		petClass = classifyPetColor(frame.Data, frame.Width, frame.Height, *cc.lastCatBBox)
	}

	panel := capturedPanel{
		nv12Data:  append([]byte(nil), frame.Data...),
		width:     frame.Width,
		height:    frame.Height,
		timestamp: now,
		bbox:      cc.lastCatBBox,
		petClass:  petClass,
	}
	cc.panels = append(cc.panels, panel)
	cc.lastCaptureTime = now
	log.Printf("[Comic] Panel %d captured (session=%s)", len(cc.panels), cc.sessionID)
}

// Layout constants for the comic grid.
// Canvas must be 16-aligned width, 8-aligned height for HW JPEG encoder.
// outW = margin*2 + (panelW + border*2)*2 + gap = 24 + 408*2 + 8 = 848 (848/16=53)
// outH = margin*2 + (panelH + border*2)*2 + gap = 24 + 232*2 + 8 = 496 (496/8=62)
const (
	comicMargin  = 12
	comicGap     = 8
	comicBorder  = 2
	comicPanelW  = 404
	comicPanelH  = 228
	comicQuality = 85
)

func (cc *ComicCapture) stitchAndSave() {
	if err := os.MkdirAll(cc.outputDir, 0755); err != nil {
		log.Printf("[Comic] Failed to create output dir: %v", err)
		return
	}

	numPanels := len(cc.panels)
	if numPanels == 0 {
		return
	}
	if numPanels > 4 {
		numPanels = 4
	}

	// Prepare C arrays for nano2D composition
	cFrames := make([]*C.uint8_t, numPanels)
	cWidths := make([]C.int, numPanels)
	cHeights := make([]C.int, numPanels)
	cCrops := make([]C.comic_crop_t, numPanels)

	// Pin Go slices for CGo (required by Go runtime)
	var pinner runtime.Pinner
	defer pinner.Unpin()

	for i := 0; i < numPanels; i++ {
		p := cc.panels[i]
		pinner.Pin(&p.nv12Data[0])
		cFrames[i] = (*C.uint8_t)(unsafe.Pointer(&p.nv12Data[0]))
		cWidths[i] = C.int(p.width)
		cHeights[i] = C.int(p.height)

		// Compute crop region
		if p.bbox != nil && i > 0 {
			var factor float64
			if p.placeholder {
				factor = 3.0 + rand.Float64()*1.0
			} else {
				factor = 1.3 + rand.Float64()*1.2
			}
			cx := p.bbox.X + p.bbox.W/2
			cy := p.bbox.Y + p.bbox.H/2
			expandW := int(float64(p.bbox.W) * factor)
			expandH := int(float64(p.bbox.H) * factor)
			x0, y0 := cx-expandW/2, cy-expandH/2
			if x0 < 0 {
				x0 = 0
			}
			if y0 < 0 {
				y0 = 0
			}
			if x0+expandW > p.width {
				expandW = p.width - x0
			}
			if y0+expandH > p.height {
				expandH = p.height - y0
			}
			cCrops[i] = C.comic_crop_t{
				src_x: C.int(x0), src_y: C.int(y0),
				src_w: C.int(expandW), src_h: C.int(expandH),
			}
		}
		// else: zero-initialized = full frame
	}

	// Canvas dimensions
	border := 2
	cellW := comicPanelW + 2*border
	cellH := comicPanelH + 2*border
	outW := comicMargin*2 + cellW*2 + comicGap
	outH := comicMargin*2 + cellH*2 + comicGap

	outNV12 := make([]byte, outW*outH*3/2)

	ret := C.n2d_comic_compose(
		(**C.uint8_t)(unsafe.Pointer(&cFrames[0])),
		(*C.int)(unsafe.Pointer(&cWidths[0])),
		(*C.int)(unsafe.Pointer(&cHeights[0])),
		(*C.comic_crop_t)(unsafe.Pointer(&cCrops[0])),
		C.int(numPanels),
		C.int(comicPanelW), C.int(comicPanelH),
		C.int(comicMargin), C.int(comicGap),
		(*C.uint8_t)(unsafe.Pointer(&outNV12[0])),
		C.int(outW), C.int(outH),
	)
	if ret != 0 {
		log.Printf("[Comic] nano2D composition failed: %d", ret)
		return
	}

	// Draw timestamps on NV12 canvas
	for i := 0; i < numPanels && i < 4; i++ {
		ts := cc.panels[i].timestamp.Format("15:04:05")
		px := comicMargin + border
		py := comicMargin + border
		if i%2 == 1 {
			px += cellW + comicGap
		}
		if i >= 2 {
			py += cellH + comicGap
		}
		// Draw timestamp at bottom-right of panel
		drawTextWithBackgroundNV12(outNV12, outW, outH,
			px+comicPanelW-len(ts)*8*2-12, py+comicPanelH-32-6,
			ts, 255, 16, 2)
	}

	// HW JPEG encode (via VPU, same path as MJPEG)
	jpegData, err := nv12ToJPEG(outNV12, outW, outH)
	if err != nil {
		log.Printf("[Comic] HW JPEG encode failed: %v", err)
		return
	}

	petID := dominantPetID(cc.panels)
	filename := fmt.Sprintf("comic_%s_%s.jpg", cc.sessionID, petID)
	outPath := filepath.Join(cc.outputDir, filename)
	if err := os.WriteFile(outPath, jpegData, 0644); err != nil {
		log.Printf("[Comic] Failed to write %s: %v", filename, err)
		return
	}

	cc.recentComics = append(cc.recentComics, time.Now())
	cutoff := time.Now().Add(-cc.RateLimitWindow)
	trimmed := cc.recentComics[:0]
	for _, t := range cc.recentComics {
		if t.After(cutoff) {
			trimmed = append(trimmed, t)
		}
	}
	cc.recentComics = trimmed

	log.Printf("[Comic] Saved %s (%d panels, nano2D+HW JPEG)", filename, numPanels)
}

// CaptureSnapshot grabs the current NV12 frame, encodes it as JPEG, and saves
// it to outputDir as snap_YYYYMMDD_HHMMSS.jpg. Returns the saved filename.
func (cc *ComicCapture) CaptureSnapshot() (string, error) {
	frame, ok := cc.src.LatestNV12()
	if !ok {
		return "", fmt.Errorf("no frame available from SHM")
	}

	jpegData, err := nv12ToJPEG(frame.Data, frame.Width, frame.Height)
	if err != nil {
		return "", fmt.Errorf("JPEG encode failed: %w", err)
	}

	if err := os.MkdirAll(cc.outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create output dir: %w", err)
	}

	filename := fmt.Sprintf("snap_%s.jpg", time.Now().Format("20060102_150405"))
	outPath := filepath.Join(cc.outputDir, filename)
	if err := os.WriteFile(outPath, jpegData, 0644); err != nil {
		return "", fmt.Errorf("failed to write file: %w", err)
	}

	log.Printf("[Capture] On-demand snapshot saved: %s (%d bytes)", filename, len(jpegData))
	return filename, nil
}

func isPetClass(name string) bool {
	return name == "cat" || name == "dog"
}

// hasPet returns true if any detection is a pet (cat or dog).
func hasPet(det *DetectionResult) bool {
	if det == nil {
		return false
	}
	for _, d := range det.Detections {
		if isPetClass(d.ClassName) {
			return true
		}
	}
	return false
}

// petDetection returns the bounding box and class name of the highest-confidence pet detection.
func petDetection(det *DetectionResult) (*BoundingBox, string) {
	if det == nil {
		return nil, ""
	}
	var best *BoundingBox
	bestConf := 0.0
	bestClass := ""
	for _, d := range det.Detections {
		if isPetClass(d.ClassName) && d.Confidence > bestConf {
			bestConf = d.Confidence
			bb := d.BBox
			best = &bb
			bestClass = d.ClassName
		}
	}
	return best, bestClass
}
