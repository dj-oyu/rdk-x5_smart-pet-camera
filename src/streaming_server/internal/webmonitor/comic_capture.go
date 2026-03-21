package webmonitor

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"log"
	"math/rand"
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
	jpegData    []byte
	timestamp   time.Time
	bbox        *BoundingBox
	placeholder bool // filled panel (wider crop to show context)
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
		if hasPet(det) {
			cc.lastCatSeen = now
			cc.lastCatBBox = petBBox(det)
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
	if len(cc.panels) > 0 {
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
	jpegData, ok := cc.src.LatestJPEG()
	if !ok {
		return
	}
	// Use the last known bbox from any captured panel
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
			jpegData:    jpegData,
			timestamp:   now,
			bbox:        lastBBox,
			placeholder: true,
		}
		cc.panels = append(cc.panels, panel)
		log.Printf("[Comic] Panel %d filled (placeholder, session=%s)", len(cc.panels), cc.sessionID)
	}
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
	comicPanelH  = 225
	comicQuality = 85
)

func (cc *ComicCapture) stitchAndSave() {
	if err := os.MkdirAll(cc.outputDir, 0755); err != nil {
		log.Printf("[Comic] Failed to create output dir: %v", err)
		return
	}

	// Decode and crop panels
	// Panel 0: full frame (establishing shot)
	// Panel 1-3: random zoom (1.3x-2.5x)
	// Placeholder panels: wide crop (3.0x-4.0x) to show context around last known position
	images := make([]image.Image, 0, len(cc.panels))
	for i, p := range cc.panels {
		img, err := jpeg.Decode(bytes.NewReader(p.jpegData))
		if err != nil {
			log.Printf("[Comic] Failed to decode panel %d: %v", i, err)
			return
		}
		if p.bbox != nil && i > 0 {
			var factor float64
			if p.placeholder {
				factor = 3.0 + rand.Float64()*1.0 // 3.0x ~ 4.0x (wide)
			} else {
				factor = 1.3 + rand.Float64()*1.2 // 1.3x ~ 2.5x (close-up)
			}
			img = cropToDetection(img, p.bbox, factor)
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

// scaleImage scales src into dst rectangle using nearest-neighbor with direct Pix access.
func scaleImage(dst *image.RGBA, dstRect image.Rectangle, src image.Image) {
	dw := dstRect.Dx()
	dh := dstRect.Dy()
	srcBounds := src.Bounds()
	sw := srcBounds.Dx()
	sh := srcBounds.Dy()

	// Fast path: direct Pix manipulation for RGBA sources (avoids interface dispatch per pixel)
	if srcRGBA, ok := src.(*image.RGBA); ok {
		for dy := 0; dy < dh; dy++ {
			sy := srcBounds.Min.Y + dy*sh/dh
			dstOff := (dstRect.Min.Y+dy-dst.Rect.Min.Y)*dst.Stride + (dstRect.Min.X-dst.Rect.Min.X)*4
			srcRow := (sy-srcRGBA.Rect.Min.Y)*srcRGBA.Stride - srcRGBA.Rect.Min.X*4
			for dx := 0; dx < dw; dx++ {
				sx := srcBounds.Min.X + dx*sw/dw
				srcOff := srcRow + sx*4
				copy(dst.Pix[dstOff:dstOff+4], srcRGBA.Pix[srcOff:srcOff+4])
				dstOff += 4
			}
		}
		return
	}

	// Fast path: YCbCr sources (jpeg.Decode returns this)
	if srcYCbCr, ok := src.(*image.YCbCr); ok {
		for dy := 0; dy < dh; dy++ {
			sy := srcBounds.Min.Y + dy*sh/dh
			dstOff := (dstRect.Min.Y+dy-dst.Rect.Min.Y)*dst.Stride + (dstRect.Min.X-dst.Rect.Min.X)*4
			for dx := 0; dx < dw; dx++ {
				sx := srcBounds.Min.X + dx*sw/dw
				yi := srcYCbCr.YOffset(sx, sy)
				ci := srcYCbCr.COffset(sx, sy)
				yy := int32(srcYCbCr.Y[yi])
				cb := int32(srcYCbCr.Cb[ci]) - 128
				cr := int32(srcYCbCr.Cr[ci]) - 128
				r := yy + 91881*cr/65536
				g := yy - 22554*cb/65536 - 46802*cr/65536
				b := yy + 116130*cb/65536
				if r < 0 {
					r = 0
				} else if r > 255 {
					r = 255
				}
				if g < 0 {
					g = 0
				} else if g > 255 {
					g = 255
				}
				if b < 0 {
					b = 0
				} else if b > 255 {
					b = 255
				}
				dst.Pix[dstOff] = uint8(r)
				dst.Pix[dstOff+1] = uint8(g)
				dst.Pix[dstOff+2] = uint8(b)
				dst.Pix[dstOff+3] = 255
				dstOff += 4
			}
		}
		return
	}

	// Generic fallback
	for dy := 0; dy < dh; dy++ {
		sy := srcBounds.Min.Y + dy*sh/dh
		for dx := 0; dx < dw; dx++ {
			sx := srcBounds.Min.X + dx*sw/dw
			dst.Set(dstRect.Min.X+dx, dstRect.Min.Y+dy, src.At(sx, sy))
		}
	}
}

// cropToDetection crops the image around the bounding box center with the given expansion factor.
func cropToDetection(img image.Image, bbox *BoundingBox, factor float64) image.Image {
	bounds := img.Bounds()

	cx := bbox.X + bbox.W/2
	cy := bbox.Y + bbox.H/2
	expandW := int(float64(bbox.W) * factor)
	expandH := int(float64(bbox.H) * factor)

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

// drawTimestamp renders a 2x-scaled timestamp with semi-transparent background bar.
func drawTimestamp(canvas *image.RGBA, panelRect image.Rectangle, text string) {
	const scale = 2
	face := inconsolata.Regular8x16
	charW := 8 // base character width
	textW := len(text) * charW * scale
	textH := 16 * scale
	pad := 6

	// Semi-transparent black background bar
	barRect := image.Rect(
		panelRect.Max.X-textW-pad*2,
		panelRect.Max.Y-textH-pad,
		panelRect.Max.X,
		panelRect.Max.Y,
	)
	bgColor := color.RGBA{0, 0, 0, 160}
	for y := barRect.Min.Y; y < barRect.Max.Y; y++ {
		for x := barRect.Min.X; x < barRect.Max.X; x++ {
			if x >= panelRect.Min.X && y >= panelRect.Min.Y {
				off := (y-canvas.Rect.Min.Y)*canvas.Stride + (x-canvas.Rect.Min.X)*4
				// Alpha blend
				canvas.Pix[off+0] = uint8((int(canvas.Pix[off+0])*96 + int(bgColor.R)*160) / 256)
				canvas.Pix[off+1] = uint8((int(canvas.Pix[off+1])*96 + int(bgColor.G)*160) / 256)
				canvas.Pix[off+2] = uint8((int(canvas.Pix[off+2])*96 + int(bgColor.B)*160) / 256)
				canvas.Pix[off+3] = 255
			}
		}
	}

	// Render text at 1x into a temporary canvas, then blit at 2x
	tmpW := len(text) * charW
	tmpH := 16
	tmp := image.NewRGBA(image.Rect(0, 0, tmpW, tmpH))
	d := &font.Drawer{
		Dst:  tmp,
		Src:  image.NewUniform(color.White),
		Face: face,
		Dot:  xdraw.P(0, 13), // baseline for 8x16 font
	}
	d.DrawString(text)

	// Blit 2x scaled into canvas
	ox := panelRect.Max.X - textW - pad
	oy := panelRect.Max.Y - textH - pad/2
	for sy := 0; sy < tmpH; sy++ {
		for sx := 0; sx < tmpW; sx++ {
			a := tmp.Pix[(sy*tmp.Stride)+sx*4+3]
			if a == 0 {
				continue
			}
			for dy := 0; dy < scale; dy++ {
				for dx := 0; dx < scale; dx++ {
					px := ox + sx*scale + dx
					py := oy + sy*scale + dy
					if px >= panelRect.Min.X && px < panelRect.Max.X && py >= panelRect.Min.Y && py < panelRect.Max.Y {
						off := (py-canvas.Rect.Min.Y)*canvas.Stride + (px-canvas.Rect.Min.X)*4
						canvas.Pix[off+0] = 255
						canvas.Pix[off+1] = 255
						canvas.Pix[off+2] = 255
						canvas.Pix[off+3] = 255
					}
				}
			}
		}
	}
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

// petBBox returns the bounding box of the highest-confidence pet detection.
func petBBox(det *DetectionResult) *BoundingBox {
	if det == nil {
		return nil
	}
	var best *BoundingBox
	bestConf := 0.0
	for _, d := range det.Detections {
		if isPetClass(d.ClassName) && d.Confidence > bestConf {
			bestConf = d.Confidence
			bb := d.BBox
			best = &bb
		}
	}
	return best
}
