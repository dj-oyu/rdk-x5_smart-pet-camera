package webmonitor

/*
#cgo CFLAGS: -I../../../capture -I/usr/include/GC820
#cgo LDFLAGS: -L../../../../build -ln2d_comic -lNano2D -lNano2Dutil

#include "n2d_comic.h"
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
	"fmt"
	"image/color"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

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
	nv12Data       []byte
	width          int
	height         int
	timestamp      time.Time
	bbox           *BoundingBox
	placeholder    bool            // filled panel (wider crop to show context)
	motionHint     bool            // panel guided by motion detection (tighter crop)
	petClass       string          // "mike", "chatora", "other", or "" if unknown
	petConfidence  float64         // 0.0-1.0, classification confidence
	petColorResult *PetColorResult // full diagnostic data (nil if not classified)
	detections     []Detection     // all YOLO detections at capture time
}

type stitchRequest struct {
	panels         []capturedPanel
	sessionID      string
	pendingCaption string
	resultCh       chan string // returns saved filename (empty on error)
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
	lastMotionBBox    *BoundingBox // union of motion bboxes from detection SHM
	lastMotionSeen    time.Time
	lastDetResult     *DetectionResult // cached from tick() for capturePanel()
	sessionID         string
	panels            []capturedPanel
	lastCaptureTime   time.Time
	captureStartTime  time.Time
	recentComics      []time.Time
	pendingCaption    string
	mu                sync.Mutex
	stop              chan struct{}
	done              chan struct{}
	stitchCh          chan stitchRequest

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
		stitchCh:            make(chan stitchRequest, 1),
		DetectionThreshold:  5 * time.Second,
		BaseCaptureInterval: 10 * time.Second,
		DetectionLost:       5 * time.Second,
		MaxPanels:           4,
		RateLimitWindow:     5 * time.Minute,
		RateLimitMax:        3,
	}
}

func (cc *ComicCapture) Start() {
	go cc.run()
	go cc.runStitcher()
}

func (cc *ComicCapture) Stop() {
	close(cc.stop)
	<-cc.done
	close(cc.stitchCh)
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
			if needsStitch := cc.tick(time.Now()); needsStitch {
				cc.finalizeSession()
			}
		}
	}
}

// tick returns true if finishCapturing should be called after releasing cc.mu.
func (cc *ComicCapture) tick(now time.Time) bool {
	cc.mu.Lock()
	defer cc.mu.Unlock()

	// Poll detection SHM
	det, ok := cc.src.LatestDetection()
	if ok {
		cc.lastDetResult = det
		cc.lastVersionChange = now
		if hasPet(det) {
			cc.lastCatSeen = now
			cc.lastCatBBox, cc.lastCatClass = petDetection(det)
			cc.lastMotionBBox = nil // clear motion when YOLO active
			if cc.catFirstSeen.IsZero() {
				cc.catFirstSeen = now
			}
		} else if det.NumDetections > 0 {
			// No pet, but check for motion detections
			if mb := motionUnionBBox(det); mb != nil {
				cc.lastMotionBBox = mb
				cc.lastMotionSeen = now
			}
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
		cc.lastDetResult = nil
	}

	switch cc.state {
	case comicIdle:
		catContinuous := !cc.catFirstSeen.IsZero() && now.Sub(cc.catFirstSeen) >= cc.DetectionThreshold
		if catContinuous && cc.canGenerateComic(now) {
			cc.startCapturing(now)
		}

	case comicCapturing:
		// Keep session alive if motion is recent, even when YOLO cat is lost
		motionActive := !cc.lastMotionSeen.IsZero() && now.Sub(cc.lastMotionSeen) <= cc.DetectionLost
		if (catGone && !motionActive) || versionStale {
			cc.prepareFinish()
			return true
		}
		interval := cc.currentInterval(now)
		if now.Sub(cc.lastCaptureTime) >= interval {
			cc.capturePanel(now)
			if len(cc.panels) >= cc.MaxPanels {
				cc.prepareFinish()
				return true
			}
		}
	}
	return false
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
	cc.prepareFinish()
	cc.finalizeSession()
}

// finalizeSession runs stitch (if panels exist) and resets state. Must be called without cc.mu held.
func (cc *ComicCapture) finalizeSession() {
	if len(cc.panels) > 0 && !cc.SkipStitch {
		cc.stitchAndSave()
	}
	cc.mu.Lock()
	cc.state = comicIdle
	cc.panels = nil
	cc.catFirstSeen = time.Time{}
	log.Printf("[Comic] Session finished: %s", cc.sessionID)
	cc.mu.Unlock()
}

// prepareFinish fills missing panels. Must be called with cc.mu held.
func (cc *ComicCapture) prepareFinish() {
	if n := len(cc.panels); n > 0 && n < cc.MaxPanels {
		cc.fillMissingPanels(time.Now())
	}
}

// fillMissingPanels captures the current frame for each missing slot,
// using the last known bbox as a hint (the pet may still be in frame
// even if the detector missed it).
func (cc *ComicCapture) fillMissingPanels(now time.Time) {
	frame, ok := cc.src.LatestNV12()
	if !ok {
		return
	}

	// Prefer recent motion bbox, fall back to last panel bbox
	var hintBBox *BoundingBox
	isMotion := false
	if !cc.lastMotionSeen.IsZero() && now.Sub(cc.lastMotionSeen) < 5*time.Second && cc.lastMotionBBox != nil {
		hintBBox = cc.lastMotionBBox
		isMotion = true
	} else {
		for i := len(cc.panels) - 1; i >= 0; i-- {
			if cc.panels[i].bbox != nil {
				bb := *cc.panels[i].bbox
				hintBBox = &bb
				break
			}
		}
	}

	for len(cc.panels) < cc.MaxPanels {
		panel := capturedPanel{
			nv12Data:    append([]byte(nil), frame.Data...),
			width:       frame.Width,
			height:      frame.Height,
			timestamp:   now,
			bbox:        hintBBox,
			placeholder: true,
			motionHint:  isMotion,
		}
		cc.panels = append(cc.panels, panel)
		hint := ""
		if isMotion {
			hint = "+motion"
		}
		log.Printf("[Comic] Panel %d filled (placeholder%s, session=%s)", len(cc.panels), hint, cc.sessionID)
	}
}

func (cc *ComicCapture) capturePanel(now time.Time) {
	frame, ok := cc.src.LatestNV12()
	if !ok {
		return
	}

	// Classify pet color from bbox region (scale detection coords to frame)
	var petClass string
	var petConfidence float64
	var petColorResult *PetColorResult
	if cc.lastCatBBox != nil {
		scaledBBox := scaleBBoxToFrame(*cc.lastCatBBox)
		result := classifyPetColor(frame.Data, frame.Width, frame.Height, scaledBBox)
		petClass = result.PetID
		petConfidence = result.Confidence
		petColorResult = &result
	}

	// Snapshot all current YOLO detections (cached from tick() poll)
	var dets []Detection
	if cc.lastDetResult != nil {
		dets = append([]Detection(nil), cc.lastDetResult.Detections...)
	}

	// bbox: prefer YOLO (recent 2s), fallback to motion (recent 3s)
	panelBBox := cc.lastCatBBox
	isMotionHint := false
	if cc.lastCatBBox == nil || now.Sub(cc.lastCatSeen) > 2*time.Second {
		if cc.lastMotionBBox != nil && now.Sub(cc.lastMotionSeen) <= 3*time.Second {
			panelBBox = cc.lastMotionBBox
			isMotionHint = true
		}
	}

	panel := capturedPanel{
		nv12Data:       append([]byte(nil), frame.Data...),
		width:          frame.Width,
		height:         frame.Height,
		timestamp:      now,
		bbox:           panelBBox,
		motionHint:     isMotionHint,
		petClass:       petClass,
		petConfidence:  petConfidence,
		petColorResult: petColorResult,
		detections:     dets,
	}
	cc.panels = append(cc.panels, panel)
	cc.lastCaptureTime = now

	log.Printf("[Comic] Panel %d captured (session=%s, %d detections)", len(cc.panels), cc.sessionID, len(dets))
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

// runStitcher runs on a dedicated OS thread for nano2D GPU context affinity.
func (cc *ComicCapture) runStitcher() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	for req := range cc.stitchCh {
		filename := cc.doStitch(req.panels, req.sessionID, req.pendingCaption)
		req.resultCh <- filename
	}
}

// stitchAndSave sends panels to the stitcher goroutine and waits for the result.
func (cc *ComicCapture) stitchAndSave() {
	cc.mu.Lock()
	caption := cc.pendingCaption
	cc.pendingCaption = ""
	cc.mu.Unlock()

	resultCh := make(chan string, 1)
	cc.stitchCh <- stitchRequest{
		panels:         cc.panels,
		sessionID:      cc.sessionID,
		pendingCaption: caption,
		resultCh:       resultCh,
	}
	<-resultCh
}

func (cc *ComicCapture) doStitch(panels []capturedPanel, sessionID, caption string) string {
	if err := os.MkdirAll(cc.outputDir, 0755); err != nil {
		log.Printf("[Comic] Failed to create output dir: %v", err)
		return ""
	}

	numPanels := len(panels)
	if numPanels == 0 {
		return ""
	}
	if numPanels > 4 {
		numPanels = 4
	}

	// Prepare C arrays for nano2D composition
	cFrames := make([]*C.uint8_t, numPanels)
	cWidths := make([]C.int, numPanels)
	cHeights := make([]C.int, numPanels)
	cCrops := make([]C.comic_crop_t, numPanels)

	// Track crop regions for coordinate mapping (frame → comic)
	type cropRegion struct {
		x, y, w, h int
	}
	cropRegions := make([]cropRegion, numPanels)

	// Pin Go slices for CGo (required by Go runtime)
	var pinner runtime.Pinner
	defer pinner.Unpin()

	// Find last YOLO bbox (non-motion, non-placeholder) for motion vector extrapolation
	var lastYoloBBox *BoundingBox
	for i := len(panels) - 1; i >= 0; i-- {
		if panels[i].bbox != nil && !panels[i].motionHint && !panels[i].placeholder {
			lastYoloBBox = panels[i].bbox
			break
		}
	}

	for i := 0; i < numPanels; i++ {
		p := panels[i]
		pinner.Pin(&p.nv12Data[0])
		cFrames[i] = (*C.uint8_t)(unsafe.Pointer(&p.nv12Data[0]))
		cWidths[i] = C.int(p.width)
		cHeights[i] = C.int(p.height)

		// Default: full frame
		cropRegions[i] = cropRegion{0, 0, p.width, p.height}

		// Compute crop region
		if p.bbox != nil && i > 0 {
			// Detection bbox is in 1280x720 coordinate space (YOLO output).
			// Scale to actual frame dimensions (e.g. 768x432 from VSE Ch2).
			sb := scaleBBoxToFrame(*p.bbox)
			bx, by, bw, bh := sb.X, sb.Y, sb.W, sb.H

			var factor float64
			if p.motionHint {
				factor = 1.5 + rand.Float64()*0.5
			} else if p.placeholder {
				factor = 3.0 + rand.Float64()*1.0
			} else {
				factor = 1.3 + rand.Float64()*1.2
			}

			cx := bx + bw/2
			cy := by + bh/2

			// Motion vector extrapolation: shift crop toward arrival side
			if p.motionHint && lastYoloBBox != nil {
				sYolo := scaleBBoxToFrame(*lastYoloBBox)
				yoloCX := sYolo.X + sYolo.W/2
				yoloCY := sYolo.Y + sYolo.H/2
				cx += cx - yoloCX
				cy += cy - yoloCY
				// Clamp extrapolated center to frame bounds
				if cx < 0 {
					cx = 0
				} else if cx >= p.width {
					cx = p.width - 1
				}
				if cy < 0 {
					cy = 0
				} else if cy >= p.height {
					cy = p.height - 1
				}
			}

			expandW := int(float64(bw) * factor)
			expandH := int(float64(bh) * factor)
			// Ensure minimum crop size
			if expandW < 64 {
				expandW = 64
			}
			if expandH < 64 {
				expandH = 64
			}
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
			if expandW < 2 {
				expandW = 2
			}
			if expandH < 2 {
				expandH = 2
			}
			cropRegions[i] = cropRegion{x0, y0, expandW, expandH}
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
		return ""
	}

	// Draw timestamps on NV12 canvas
	for i := 0; i < numPanels && i < 4; i++ {
		ts := panels[i].timestamp.Format("15:04:05")
		px := comicMargin + border
		py := comicMargin + border
		if i%2 == 1 {
			px += cellW + comicGap
		}
		if i >= 2 {
			py += cellH + comicGap
		}
		// Draw timestamp at bottom-right of panel (TrueType)
		tsImg := RenderLabel(ts, color.White, color.RGBA{A: 180}, 14)
		if tsImg != nil {
			tsX := px + comicPanelW - tsImg.Bounds().Dx() - 6
			tsY := py + comicPanelH - tsImg.Bounds().Dy() - 4
			blendRGBAOnNV12(outNV12, outW, outH, tsImg, tsX, tsY)
		}
	}

	// Draw user caption with TrueType font (Japanese/emoji support)
	if caption != "" {
		DrawCaptionOnNV12(outNV12, outW, outH, caption)
	}

	// HW JPEG encode (via VPU, same path as MJPEG)
	jpegData, err := nv12ToJPEG(outNV12, outW, outH)
	if err != nil {
		log.Printf("[Comic] HW JPEG encode failed: %v", err)
		return ""
	}

	petID := dominantPetID(panels)
	// Log confidence scores for calibration (exclude placeholders)
	scores := map[string]float64{}
	for _, p := range panels {
		if p.placeholder {
			continue
		}
		if p.petClass != "" && p.petClass != "other" {
			scores[p.petClass] += p.petConfidence
		}
	}
	log.Printf("[Comic] Stitched %d panels (dominant=%s, scores=%v)", numPanels, petID, scores)
	filename := fmt.Sprintf("comic_%s_%s.jpg", sessionID, petID)
	outPath := filepath.Join(cc.outputDir, filename)
	if err := os.WriteFile(outPath, jpegData, 0644); err != nil {
		log.Printf("[Comic] Failed to write %s: %v", filename, err)
		return ""
	}

	// Build ingest payload: map all YOLO detections to comic coordinates.
	// Panel layout: 2x2 grid in 848x496 comic image.
	panelOffsets := [4][2]int{
		{comicMargin + comicBorder, comicMargin + comicBorder},                                                                                   // top-left
		{comicMargin + comicBorder + comicPanelW + 2*comicBorder + comicGap, comicMargin + comicBorder},                                          // top-right
		{comicMargin + comicBorder, comicMargin + comicBorder + comicPanelH + 2*comicBorder + comicGap},                                          // bottom-left
		{comicMargin + comicBorder + comicPanelW + 2*comicBorder + comicGap, comicMargin + comicBorder + comicPanelH + 2*comicBorder + comicGap}, // bottom-right
	}

	type colorMetrics struct {
		Version int     `json:"v"`
		Scatter float64 `json:"scatter"`
		MeanU   float64 `json:"mean_u"`
		MeanV   float64 `json:"mean_v"`
		MeanY   float64 `json:"mean_y"`
		UVDist  float64 `json:"uv_dist"`
		Conf    float64 `json:"conf"`
	}
	type ingestDetection struct {
		PanelIndex   *int          `json:"panel_index"`
		BBoxX        int           `json:"bbox_x"`
		BBoxY        int           `json:"bbox_y"`
		BBoxW        int           `json:"bbox_w"`
		BBoxH        int           `json:"bbox_h"`
		YoloClass    string        `json:"yolo_class"`
		PetClass     *string       `json:"pet_class,omitempty"`
		ColorMetrics *colorMetrics `json:"color_metrics,omitempty"`
		Confidence   float64       `json:"confidence"`
		DetectedAt   string        `json:"detected_at"`
	}
	type ingestPayload struct {
		Filename   string            `json:"filename"`
		CapturedAt string            `json:"captured_at"`
		PetID      string            `json:"pet_id"`
		Detections []ingestDetection `json:"detections"`
	}

	payload := ingestPayload{
		Filename:   filename,
		CapturedAt: panels[0].timestamp.Format("2006-01-02T15:04:05"),
		PetID:      petID,
	}

	for i := 0; i < numPanels && i < 4; i++ {
		p := panels[i]
		cr := cropRegions[i]
		ox, oy := panelOffsets[i][0], panelOffsets[i][1]

		// Scale factors: frame crop → comic panel
		scaleX := float64(comicPanelW) / float64(cr.w)
		scaleY := float64(comicPanelH) / float64(cr.h)

		for _, det := range p.detections {
			// Scale detection bbox (1280x720) to frame coordinates
			sd := scaleBBoxToFrame(det.BBox)
			// Map frame bbox → comic coordinates
			comicX := ox + int(float64(sd.X-cr.x)*scaleX)
			comicY := oy + int(float64(sd.Y-cr.y)*scaleY)
			comicW := int(float64(sd.W) * scaleX)
			comicH := int(float64(sd.H) * scaleY)

			// Skip detections outside the crop region
			if comicX+comicW < ox || comicX > ox+comicPanelW ||
				comicY+comicH < oy || comicY > oy+comicPanelH {
				continue
			}

			// Clamp to panel bounds
			if comicX < ox {
				comicW -= ox - comicX
				comicX = ox
			}
			if comicY < oy {
				comicH -= oy - comicY
				comicY = oy
			}
			if comicX+comicW > ox+comicPanelW {
				comicW = ox + comicPanelW - comicX
			}
			if comicY+comicH > oy+comicPanelH {
				comicH = oy + comicPanelH - comicY
			}

			panelIdx := i
			d := ingestDetection{
				PanelIndex: &panelIdx,
				BBoxX:      comicX,
				BBoxY:      comicY,
				BBoxW:      comicW,
				BBoxH:      comicH,
				YoloClass:  det.ClassName,
				Confidence: det.Confidence,
				DetectedAt: p.timestamp.Format("2006-01-02T15:04:05"),
			}
			// pet_class + color metrics only for cat/dog detections
			if det.ClassName == "cat" || det.ClassName == "dog" {
				pc := p.petClass
				d.PetClass = &pc
				if r := p.petColorResult; r != nil {
					d.ColorMetrics = &colorMetrics{
						Version: 1,
						Scatter: r.Scatter,
						MeanU:   r.MeanU,
						MeanV:   r.MeanV,
						MeanY:   r.MeanY,
						UVDist:  r.UVDist,
						Conf:    r.Confidence,
					}
				}
			}
			payload.Detections = append(payload.Detections, d)
		}
	}

	// Send to ai-pyramid ingest API (async, non-blocking)
	go func() {
		ingestJSON, err := json.Marshal(payload)
		if err != nil {
			log.Printf("[Comic] Failed to marshal ingest payload: %v", err)
			return
		}
		sendIngestToAIPyramid(ingestJSON)
	}()

	cc.mu.Lock()
	cc.recentComics = append(cc.recentComics, time.Now())
	cutoff := time.Now().Add(-cc.RateLimitWindow)
	trimmed := cc.recentComics[:0]
	for _, t := range cc.recentComics {
		if t.After(cutoff) {
			trimmed = append(trimmed, t)
		}
	}
	cc.recentComics = trimmed
	cc.mu.Unlock()

	log.Printf("[Comic] Saved %s (%d panels, nano2D+HW JPEG)", filename, numPanels)
	return filename
}

// albumBaseURL returns the ai-pyramid base URL from PET_ALBUM_HOST + PET_ALBUM_PORT env vars.
// Returns empty string if PET_ALBUM_HOST is not set. Defaults to port 8082 and HTTPS.
var albumBaseURL = func() string {
	host := os.Getenv("PET_ALBUM_HOST")
	if host == "" {
		return ""
	}
	port := os.Getenv("PET_ALBUM_PORT")
	if port == "" {
		port = "8082"
	}
	return "https://" + host + ":" + port
}()

var ingestURL = func() string {
	if albumBaseURL == "" {
		return ""
	}
	return albumBaseURL + "/api/photos/ingest"
}()

// sendIngestToAIPyramid sends detection metadata to ai-pyramid's ingest API.
// Called asynchronously after comic save. Retries once on failure.
// No-op if PET_ALBUM_HOST is not set.
func sendIngestToAIPyramid(payload []byte) {
	if ingestURL == "" {
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := httpClient.Post(ingestURL, "application/json", strings.NewReader(string(payload)))
		if err != nil {
			if attempt == 0 {
				time.Sleep(2 * time.Second)
				continue
			}
			log.Printf("[Comic] Ingest API failed: %v", err)
			return
		}
		resp.Body.Close()
		if resp.StatusCode < 300 {
			log.Printf("[Comic] Ingest API OK (%d)", resp.StatusCode)
			return
		}
		log.Printf("[Comic] Ingest API status %d (attempt %d)", resp.StatusCode, attempt+1)
		if attempt == 0 {
			time.Sleep(2 * time.Second)
		}
	}
}

// CaptureComic triggers an immediate 4-panel comic capture using the exact
// same pipeline as auto-capture: startCapturing → capturePanel × MaxPanels
// → finishCapturing → stitchAndSave (nano2D + HW JPEG).
// Panels are captured ~1-4s apart. Optional message is drawn on the comic.
func (cc *ComicCapture) CaptureComic(message string) (string, error) {
	now := time.Now()

	// Save and restore state so on-demand doesn't break auto-capture
	prevState := cc.state
	prevPanels := cc.panels
	prevSession := cc.sessionID
	prevCaptureStart := cc.captureStartTime
	prevLastCapture := cc.lastCaptureTime
	prevBBox := cc.lastCatBBox
	defer func() {
		cc.state = prevState
		cc.panels = prevPanels
		cc.sessionID = prevSession
		cc.captureStartTime = prevCaptureStart
		cc.lastCaptureTime = prevLastCapture
		cc.lastCatBBox = prevBBox
	}()

	// Generate a random "virtual bbox" to drive the crop variety in stitchAndSave.
	// Without a real detection, lastCatBBox would be nil → all panels use full frame.
	// By setting a randomized bbox per panel, we get the same zoom/angle variety
	// as auto-captured comics.
	if _, ok := cc.src.LatestNV12(); !ok {
		return "", fmt.Errorf("no frame available from SHM")
	}

	// Generate bbox in detection coordinate space (1280x720) for consistency
	// with auto-capture. doStitch applies scaleBBoxToFrame uniformly.
	const detW, detH = 1280, 720
	randomBBox := func() *BoundingBox {
		// Bias toward center-left (cat food bowl area) with some variation.
		cx := detW*35/100 + rand.Intn(detW*15/100) // 35-50% X
		cy := detH*40/100 + rand.Intn(detH*20/100) // 40-60% Y
		bw := detW/7 + rand.Intn(detW/4)
		bh := detH/7 + rand.Intn(detH/4)
		return &BoundingBox{
			X: cx - bw/2,
			Y: cy - bh/2,
			W: bw,
			H: bh,
		}
	}

	// Use startCapturing (captures first panel immediately)
	cc.lastCatBBox = randomBBox()
	cc.startCapturing(now)

	// Capture remaining panels with randomized intervals (1-4s) for natural variety
	for len(cc.panels) < cc.MaxPanels {
		delay := 1000 + rand.Intn(3000) // 1-4 seconds
		time.Sleep(time.Duration(delay) * time.Millisecond)
		cc.lastCatBBox = randomBBox() // Different crop per panel
		cc.capturePanel(time.Now())
	}

	// Set caption just before stitch to avoid being cleared by auto-capture's stitchAndSave
	if message != "" {
		cc.mu.Lock()
		cc.pendingCaption = message
		cc.mu.Unlock()
	}

	// Finalize: fillMissingPanels + stitchAndSave (exact same as auto-capture)
	cc.finishCapturing()

	// Find the saved file by session ID prefix
	prefix := "comic_" + cc.sessionID
	entries, _ := os.ReadDir(cc.outputDir)
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			log.Printf("[Comic] On-demand comic saved: %s", e.Name())
			return e.Name(), nil
		}
	}

	return "", fmt.Errorf("comic file not found after stitchAndSave (session=%s)", cc.sessionID)
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

// motionUnionBBox returns the union bounding box of all motion detections.
// Motion detection produces multiple small bboxes along object contours;
// the union captures the full extent of movement.
func motionUnionBBox(det *DetectionResult) *BoundingBox {
	if det == nil {
		return nil
	}
	var minX, minY, maxX, maxY int
	found := false
	for _, d := range det.Detections {
		if d.ClassName != "motion" {
			continue
		}
		x2, y2 := d.BBox.X+d.BBox.W, d.BBox.Y+d.BBox.H
		if !found {
			minX, minY, maxX, maxY = d.BBox.X, d.BBox.Y, x2, y2
			found = true
		} else {
			if d.BBox.X < minX {
				minX = d.BBox.X
			}
			if d.BBox.Y < minY {
				minY = d.BBox.Y
			}
			if x2 > maxX {
				maxX = x2
			}
			if y2 > maxY {
				maxY = y2
			}
		}
	}
	if !found {
		return nil
	}
	return &BoundingBox{X: minX, Y: minY, W: maxX - minX, H: maxY - minY}
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

// scaleBBoxToFrame converts detection bbox (1280x720) to MJPEG frame coordinates (768x432).
// Both detection output and MJPEG VSE channel have fixed resolutions.
// 768/1280 = 432/720 = 3/5, so we use integer multiply+divide.
func scaleBBoxToFrame(bbox BoundingBox) BoundingBox {
	return BoundingBox{
		X: bbox.X * 3 / 5,
		Y: bbox.Y * 3 / 5,
		W: bbox.W * 3 / 5,
		H: bbox.H * 3 / 5,
	}
}
