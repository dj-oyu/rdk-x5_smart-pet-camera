package webmonitor

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/image/font/inconsolata"
	xdraw "golang.org/x/image/math/fixed"
)

// frameSource abstracts SHM access for testability.
type frameSource interface {
	LatestDetection() (*DetectionResult, bool)
	LatestJPEG() ([]byte, bool)
}

type comicState int

const (
	comicIdle comicState = iota
	comicCapturing
)

type capturedPanel struct {
	jpegData  []byte
	timestamp time.Time
	bbox      *BoundingBox
}

// ComicCapture monitors detection SHM for cat presence and produces
// 4-panel comic-strip images from captured JPEG frames.
type ComicCapture struct {
	src       frameSource
	outputDir string

	state            comicState
	catFirstSeen     time.Time
	lastCatSeen      time.Time
	lastCatBBox      *BoundingBox
	lastVersionChange time.Time
	sessionID        string
	panels           []capturedPanel
	lastCaptureTime  time.Time
	captureStartTime time.Time
	recentComics     []time.Time
	mu               sync.Mutex
	stop             chan struct{}
	done             chan struct{}

	// Configurable parameters
	DetectionThreshold  time.Duration // continuous cat before capture starts
	BaseCaptureInterval time.Duration // base interval between panels
	DetectionLost       time.Duration // no version change → cat lost
	MaxPanels           int
	RateLimitWindow     time.Duration
	RateLimitMax        int
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
		if hasCat(det) {
			cc.lastCatSeen = now
			cc.lastCatBBox = catBBox(det)
			if cc.catFirstSeen.IsZero() {
				cc.catFirstSeen = now
			}
		} else {
			// Detection updated but no cat → reset continuous tracking
			cc.catFirstSeen = time.Time{}
			cc.lastCatBBox = nil
		}
	}

	catGone := !cc.lastCatSeen.IsZero() && now.Sub(cc.lastCatSeen) > cc.DetectionLost
	versionStale := !cc.lastVersionChange.IsZero() && now.Sub(cc.lastVersionChange) > cc.DetectionLost

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
	if len(cc.panels) > 0 {
		cc.stitchAndSave()
	}
	cc.state = comicIdle
	cc.panels = nil
	cc.catFirstSeen = time.Time{}
	log.Printf("[Comic] Session finished: %s", cc.sessionID)
}

func (cc *ComicCapture) capturePanel(now time.Time) {
	jpegData, ok := cc.src.LatestJPEG()
	if !ok {
		return
	}

	panel := capturedPanel{
		jpegData:  jpegData,
		timestamp: now,
		bbox:      cc.lastCatBBox,
	}
	cc.panels = append(cc.panels, panel)
	cc.lastCaptureTime = now
	log.Printf("[Comic] Panel %d captured (session=%s)", len(cc.panels), cc.sessionID)
}

// Layout constants for the comic grid.
const (
	comicMargin  = 12
	comicGap     = 12
	comicBorder  = 2
	comicPanelW  = 400
	comicPanelH  = 300
	comicQuality = 85
)

func (cc *ComicCapture) stitchAndSave() {
	if err := os.MkdirAll(cc.outputDir, 0755); err != nil {
		log.Printf("[Comic] Failed to create output dir: %v", err)
		return
	}

	// Decode and crop panels
	images := make([]image.Image, 0, len(cc.panels))
	for i, p := range cc.panels {
		img, err := jpeg.Decode(bytes.NewReader(p.jpegData))
		if err != nil {
			log.Printf("[Comic] Failed to decode panel %d: %v", i, err)
			return
		}
		if p.bbox != nil {
			img = cropToDetection(img, p.bbox)
		}
		images = append(images, img)
	}

	canvas := renderComicGrid(images, cc.panels)

	filename := fmt.Sprintf("comic_%s.jpg", cc.sessionID)
	outPath := filepath.Join(cc.outputDir, filename)
	f, err := os.Create(outPath)
	if err != nil {
		log.Printf("[Comic] Failed to create %s: %v", filename, err)
		return
	}
	defer f.Close()

	if err := jpeg.Encode(f, canvas, &jpeg.Options{Quality: comicQuality}); err != nil {
		log.Printf("[Comic] Failed to encode %s: %v", filename, err)
		return
	}

	cc.recentComics = append(cc.recentComics, time.Now())
	// Trim old entries
	cutoff := time.Now().Add(-cc.RateLimitWindow)
	trimmed := cc.recentComics[:0]
	for _, t := range cc.recentComics {
		if t.After(cutoff) {
			trimmed = append(trimmed, t)
		}
	}
	cc.recentComics = trimmed

	log.Printf("[Comic] Saved %s (%d panels)", filename, len(images))
}

// renderComicGrid creates a 2x2 white-background comic grid with black panel borders.
func renderComicGrid(images []image.Image, panels []capturedPanel) *image.RGBA {
	cellW := comicPanelW + 2*comicBorder
	cellH := comicPanelH + 2*comicBorder
	canvasW := comicMargin*2 + cellW*2 + comicGap
	canvasH := comicMargin*2 + cellH*2 + comicGap

	canvas := image.NewRGBA(image.Rect(0, 0, canvasW, canvasH))
	// Fill white background
	draw.Draw(canvas, canvas.Bounds(), image.White, image.Point{}, draw.Src)

	positions := [4][2]int{
		{comicMargin, comicMargin},
		{comicMargin + cellW + comicGap, comicMargin},
		{comicMargin, comicMargin + cellH + comicGap},
		{comicMargin + cellW + comicGap, comicMargin + cellH + comicGap},
	}

	black := image.NewUniform(color.Black)

	for i, img := range images {
		if i >= 4 {
			break
		}
		x, y := positions[i][0], positions[i][1]

		// Draw black border
		borderRect := image.Rect(x, y, x+cellW, y+cellH)
		draw.Draw(canvas, borderRect, black, image.Point{}, draw.Src)

		// Scale panel content into the inner area
		contentRect := image.Rect(x+comicBorder, y+comicBorder, x+comicBorder+comicPanelW, y+comicBorder+comicPanelH)
		scaleImage(canvas, contentRect, img)

		// Draw timestamp
		ts := panels[i].timestamp.Format("15:04:05")
		drawTimestamp(canvas, contentRect, ts)
	}

	return canvas
}

// scaleImage scales src into dst rectangle on the canvas using nearest-neighbor.
func scaleImage(dst *image.RGBA, dstRect image.Rectangle, src image.Image) {
	srcBounds := src.Bounds()
	dw := dstRect.Dx()
	dh := dstRect.Dy()
	sw := srcBounds.Dx()
	sh := srcBounds.Dy()

	for dy := 0; dy < dh; dy++ {
		sy := srcBounds.Min.Y + dy*sh/dh
		for dx := 0; dx < dw; dx++ {
			sx := srcBounds.Min.X + dx*sw/dw
			dst.Set(dstRect.Min.X+dx, dstRect.Min.Y+dy, src.At(sx, sy))
		}
	}
}

// cropToDetection crops the image around the bounding box center with 1.5x expansion.
func cropToDetection(img image.Image, bbox *BoundingBox) image.Image {
	bounds := img.Bounds()

	cx := bbox.X + bbox.W/2
	cy := bbox.Y + bbox.H/2
	expandW := int(float64(bbox.W) * 1.5)
	expandH := int(float64(bbox.H) * 1.5)

	x0 := cx - expandW/2
	y0 := cy - expandH/2
	x1 := cx + expandW/2
	y1 := cy + expandH/2

	// Clamp to image bounds
	if x0 < bounds.Min.X {
		x0 = bounds.Min.X
	}
	if y0 < bounds.Min.Y {
		y0 = bounds.Min.Y
	}
	if x1 > bounds.Max.X {
		x1 = bounds.Max.X
	}
	if y1 > bounds.Max.Y {
		y1 = bounds.Max.Y
	}

	if x1 <= x0 || y1 <= y0 {
		return img
	}

	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	if si, ok := img.(subImager); ok {
		return si.SubImage(image.Rect(x0, y0, x1, y1))
	}

	cropped := image.NewRGBA(image.Rect(0, 0, x1-x0, y1-y0))
	draw.Draw(cropped, cropped.Bounds(), img, image.Pt(x0, y0), draw.Src)
	return cropped
}

// drawTimestamp renders a timestamp string in the bottom-right of a panel.
func drawTimestamp(canvas *image.RGBA, panelRect image.Rectangle, text string) {
	face := inconsolata.Regular8x16
	charW := 8 // inconsolata Regular8x16 character width
	textW := len(text) * charW
	pad := 4

	// Shadow
	shadowDrawer := &font.Drawer{
		Dst:  canvas,
		Src:  image.NewUniform(color.RGBA{0, 0, 0, 180}),
		Face: face,
		Dot:  xdraw.P(panelRect.Max.X-textW-pad+1, panelRect.Max.Y-pad+1),
	}
	shadowDrawer.DrawString(text)

	// Foreground
	fgDrawer := &font.Drawer{
		Dst:  canvas,
		Src:  image.NewUniform(color.RGBA{255, 255, 255, 220}),
		Face: face,
		Dot:  xdraw.P(panelRect.Max.X-textW-pad, panelRect.Max.Y-pad),
	}
	fgDrawer.DrawString(text)
}

// hasCat returns true if any detection has class_name "cat".
func hasCat(det *DetectionResult) bool {
	if det == nil {
		return false
	}
	for _, d := range det.Detections {
		if d.ClassName == "cat" {
			return true
		}
	}
	return false
}

// catBBox returns the bounding box of the highest-confidence cat detection.
func catBBox(det *DetectionResult) *BoundingBox {
	if det == nil {
		return nil
	}
	var best *BoundingBox
	bestConf := 0.0
	for _, d := range det.Detections {
		if d.ClassName == "cat" && d.Confidence > bestConf {
			bestConf = d.Confidence
			bb := d.BBox
			best = &bb
		}
	}
	return best
}
