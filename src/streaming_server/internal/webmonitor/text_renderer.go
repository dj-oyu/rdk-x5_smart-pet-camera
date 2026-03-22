package webmonitor

import (
	"image"
	"image/color"
	"image/draw"
	"log"
	"os"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// TextRenderer draws Unicode text (Japanese, English, symbols) onto images
// using Noto Sans JP. Thread-safe after initialization.
type TextRenderer struct {
	face     font.Face
	initOnce sync.Once
	initErr  error
}

var defaultRenderer TextRenderer

// fontSearchPaths lists where to look for the font file.
var fontSearchPaths = []string{
	"assets/fonts/NotoSansJP-Bold.ttf",
	"/app/smart-pet-camera/assets/fonts/NotoSansJP-Bold.ttf",
	"/tmp/noto-fonts/extracted/Noto_Sans_JP/static/NotoSansJP-Bold.ttf",
}

func (tr *TextRenderer) init(sizePt float64) {
	tr.initOnce.Do(func() {
		var fontData []byte
		for _, path := range fontSearchPaths {
			data, err := os.ReadFile(path)
			if err == nil {
				fontData = data
				log.Printf("[TextRenderer] Loaded font: %s (%.1f MB)", path, float64(len(data))/1024/1024)
				break
			}
		}
		if fontData == nil {
			tr.initErr = os.ErrNotExist
			log.Printf("[TextRenderer] WARNING: No font file found, text rendering disabled")
			return
		}

		ft, err := opentype.Parse(fontData)
		if err != nil {
			tr.initErr = err
			log.Printf("[TextRenderer] Failed to parse font: %v", err)
			return
		}

		face, err := opentype.NewFace(ft, &opentype.FaceOptions{
			Size:    sizePt,
			DPI:     72,
			Hinting: font.HintingFull,
		})
		if err != nil {
			tr.initErr = err
			log.Printf("[TextRenderer] Failed to create face: %v", err)
			return
		}

		tr.face = face
	})
}

// DrawTextOnRGBA draws text with a semi-transparent background box onto an RGBA image.
// Returns the bounding box of the drawn text area.
func (tr *TextRenderer) DrawTextOnRGBA(img *image.RGBA, x, y int, text string, textColor, bgColor color.Color) image.Rectangle {
	tr.init(24) // 24pt default
	if tr.face == nil {
		return image.Rectangle{}
	}

	// Measure text width
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(textColor),
		Face: tr.face,
		Dot:  fixed.P(x, y),
	}

	bounds, advance := d.BoundString(text)
	textW := advance.Ceil()
	metrics := tr.face.Metrics()
	textH := metrics.Height.Ceil()
	ascent := metrics.Ascent.Ceil()

	// Draw background box with padding
	pad := 6
	bgRect := image.Rect(
		x-pad,
		y-ascent-pad,
		x+textW+pad,
		y-ascent+textH+pad,
	)
	_ = bounds

	// Semi-transparent background
	bgImg := image.NewUniform(bgColor)
	draw.Draw(img, bgRect, bgImg, image.Point{}, draw.Over)

	// Draw text
	d.DrawString(text)

	return bgRect
}

// blendRGBAOnNV12 composites an RGBA overlay onto NV12 at position (ox, oy).
// Shared by both comic captions (one-time) and MJPEG overlay (cached, per-frame).
func blendRGBAOnNV12(nv12 []byte, width, height int, overlay *image.RGBA, ox, oy int) {
	bounds := overlay.Bounds()
	overlayW := bounds.Dx()
	overlayH := bounds.Dy()

	yPlane := nv12[:width*height]
	uvPlane := nv12[width*height:]

	for py := 0; py < overlayH && oy+py < height; py++ {
		for px := 0; px < overlayW && ox+px < width; px++ {
			r, g, b, a := overlay.At(px+bounds.Min.X, py+bounds.Min.Y).RGBA()
			if a == 0 {
				continue
			}

			alpha := int(a >> 8)
			invAlpha := 256 - alpha
			nx := ox + px
			ny := oy + py

			ri, gi, bi := int(r>>8), int(g>>8), int(b>>8)
			newY := ((66*ri + 129*gi + 25*bi + 128) >> 8) + 16

			yIdx := ny*width + nx
			if yIdx < len(yPlane) {
				oldY := int(yPlane[yIdx])
				yPlane[yIdx] = uint8((alpha*newY + invAlpha*oldY) >> 8)
			}

			if nx%2 == 0 && ny%2 == 0 {
				uvIdx := (ny/2)*width + (nx/2)*2
				if uvIdx+1 < len(uvPlane) {
					newU := ((-38*ri - 74*gi + 112*bi + 128) >> 8) + 128
					newV := ((112*ri - 94*gi - 18*bi + 128) >> 8) + 128
					oldU := int(uvPlane[uvIdx])
					oldV := int(uvPlane[uvIdx+1])
					uvPlane[uvIdx] = uint8((alpha*newU + invAlpha*oldU) >> 8)
					uvPlane[uvIdx+1] = uint8((alpha*newV + invAlpha*oldV) >> 8)
				}
			}
		}
	}
}

// OverlayCache holds a pre-rendered RGBA overlay for fast per-frame blending.
// Render once when detections change, blend cheaply every frame (~0.2ms).
type OverlayCache struct {
	img     *image.RGBA // Pre-rendered text overlay
	x, y    int         // Position on NV12 frame
	version int         // Detection version that generated this cache
}

// RenderLabel creates an RGBA overlay with a text label at the given position.
// Used for detection class names and confidence on MJPEG overlay.
func RenderLabel(text string, textColor, bgColor color.Color, sizePt float64) *image.RGBA {
	defaultRenderer.init(sizePt)
	if defaultRenderer.face == nil {
		return nil
	}

	d := &font.Drawer{Face: defaultRenderer.face, Dot: fixed.P(0, 0)}
	textW := d.MeasureString(text).Ceil()
	metrics := defaultRenderer.face.Metrics()
	textH := metrics.Height.Ceil()
	ascent := metrics.Ascent.Ceil()

	pad := 4
	img := image.NewRGBA(image.Rect(0, 0, textW+pad*2, textH+pad*2))
	draw.Draw(img, img.Bounds(), image.NewUniform(bgColor), image.Point{}, draw.Src)

	drawer := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(textColor),
		Face: defaultRenderer.face,
		Dot:  fixed.P(pad, pad+ascent),
	}
	drawer.DrawString(text)
	return img
}

// DrawCaptionOnNV12 draws a caption at the bottom center of an NV12 frame.
// It converts the caption area to RGBA, draws text, and converts back.
// This is designed for one-time use (comic generation), not per-frame (30fps).
func DrawCaptionOnNV12(nv12 []byte, width, height int, caption string) {
	if caption == "" {
		return
	}

	defaultRenderer.init(28) // 28pt for comic captions
	if defaultRenderer.face == nil {
		// Fallback to ASCII bitmap
		drawTextWithBackgroundNV12(nv12, width, height,
			width/2-len(caption)*8, height-36,
			caption, 255, 16, 2)
		return
	}

	// Measure text to determine overlay region size
	d := &font.Drawer{
		Face: defaultRenderer.face,
		Dot:  fixed.P(0, 0),
	}
	textW := d.MeasureString(caption).Ceil()
	metrics := defaultRenderer.face.Metrics()
	textH := metrics.Height.Ceil()
	ascent := metrics.Ascent.Ceil()

	pad := 10
	overlayW := textW + pad*2
	overlayH := textH + pad*2

	// Center horizontally, position near bottom
	ox := (width - overlayW) / 2
	oy := height - overlayH - 8
	if ox < 0 {
		ox = 0
	}
	if oy < 0 {
		oy = 0
	}

	// Create RGBA overlay
	overlay := image.NewRGBA(image.Rect(0, 0, overlayW, overlayH))

	// Fill with semi-transparent dark background
	bgColor := color.RGBA{R: 0, G: 0, B: 0, A: 180}
	draw.Draw(overlay, overlay.Bounds(), image.NewUniform(bgColor), image.Point{}, draw.Src)

	// Draw text centered
	textX := pad
	textY := pad + ascent
	drawer := &font.Drawer{
		Dst:  overlay,
		Src:  image.NewUniform(color.White),
		Face: defaultRenderer.face,
		Dot:  fixed.P(textX, textY),
	}
	drawer.DrawString(caption)

	// Composite overlay onto NV12
	blendRGBAOnNV12(nv12, width, height, overlay, ox, oy)
}
