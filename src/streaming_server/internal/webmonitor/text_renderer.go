package webmonitor

/*
#cgo CFLAGS: -I/usr/include/freetype2
#cgo LDFLAGS: -lfreetype

#include "ft_text.h"
#include <stdlib.h>
*/
import "C"

import (
	"image"
	"image/color"
	"log"
	"sync"
	"unsafe"
)

// Font search paths.
var textFontPaths = []string{
	"assets/fonts/NotoSansJP-Bold.ttf",
	"/app/smart-pet-camera/assets/fonts/NotoSansJP-Bold.ttf",
}

var emojiFontPaths = []string{
	"assets/fonts/NotoColorEmoji-Regular.ttf",
	"/app/smart-pet-camera/assets/fonts/NotoColorEmoji-Regular.ttf",
}

var ftInitOnce sync.Once
var ftInitOK bool

func initFreeType() {
	ftInitOnce.Do(func() {
		var textPath, emojiPath string
		for _, p := range textFontPaths {
			if fileExists(p) {
				textPath = p
				break
			}
		}
		for _, p := range emojiFontPaths {
			if fileExists(p) {
				emojiPath = p
				break
			}
		}

		if textPath == "" {
			log.Printf("[ft_text] No text font found — text rendering disabled")
			return
		}

		cText := C.CString(textPath)
		defer C.free(unsafe.Pointer(cText))

		var cEmoji *C.char
		if emojiPath != "" {
			cEmoji = C.CString(emojiPath)
			defer C.free(unsafe.Pointer(cEmoji))
		}

		if ret := C.ft_text_init(cText, cEmoji); ret != 0 {
			log.Printf("[ft_text] Init failed: %d", ret)
			return
		}

		ftInitOK = true
		log.Printf("[ft_text] Initialized (text=%s, emoji=%s)", textPath, emojiPath)
	})
}

// RenderTextBGRA renders UTF-8 text to an RGBA image via FreeType.
func RenderTextBGRA(text string, sizePt int, fg, bg color.Color) *image.RGBA {
	initFreeType()
	if !ftInitOK {
		return nil
	}

	fr, fgc, fb, _ := fg.RGBA()
	br, bgc, bb, ba := bg.RGBA()

	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))

	var outPixels *C.uint8_t
	var outW, outH C.int

	ret := C.ft_text_render(
		cText, C.int(sizePt),
		C.uint8_t(fr>>8), C.uint8_t(fgc>>8), C.uint8_t(fb>>8),
		C.uint8_t(br>>8), C.uint8_t(bgc>>8), C.uint8_t(bb>>8), C.uint8_t(ba>>8),
		&outPixels, &outW, &outH,
	)
	if ret != 0 || outPixels == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(outPixels))

	w, h := int(outW), int(outH)
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	src := unsafe.Slice((*byte)(unsafe.Pointer(outPixels)), w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := (y*w + x) * 4
			j := y*img.Stride + x*4
			img.Pix[j+0] = src[i+2] // R ← B
			img.Pix[j+1] = src[i+1] // G
			img.Pix[j+2] = src[i+0] // B ← R
			img.Pix[j+3] = src[i+3] // A
		}
	}
	return img
}

// RenderLabel creates an RGBA label image. Returns nil if FreeType unavailable.
func RenderLabel(text string, textColor, bgColor color.Color, sizePt float64) *image.RGBA {
	return RenderTextBGRA(text, int(sizePt), textColor, bgColor)
}

// blendRGBAOnNV12 composites an RGBA overlay onto NV12 at (ox, oy).
func blendRGBAOnNV12(nv12 []byte, width, height int, overlay *image.RGBA, ox, oy int) {
	if overlay == nil {
		return
	}
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
				yPlane[yIdx] = uint8((alpha*newY + invAlpha*int(yPlane[yIdx])) >> 8)
			}

			if nx%2 == 0 && ny%2 == 0 {
				uvIdx := (ny/2)*width + (nx/2)*2
				if uvIdx+1 < len(uvPlane) {
					newU := ((-38*ri - 74*gi + 112*bi + 128) >> 8) + 128
					newV := ((112*ri - 94*gi - 18*bi + 128) >> 8) + 128
					uvPlane[uvIdx] = uint8((alpha*newU + invAlpha*int(uvPlane[uvIdx])) >> 8)
					uvPlane[uvIdx+1] = uint8((alpha*newV + invAlpha*int(uvPlane[uvIdx+1])) >> 8)
				}
			}
		}
	}
}

// DrawCaptionOnNV12 draws a caption at the bottom center of an NV12 frame.
func DrawCaptionOnNV12(nv12 []byte, width, height int, caption string) {
	if caption == "" {
		return
	}
	img := RenderTextBGRA(caption, 28, color.White, color.RGBA{A: 180})
	if img == nil {
		return
	}
	ox := (width - img.Bounds().Dx()) / 2
	oy := height - img.Bounds().Dy() - 8
	if ox < 0 {
		ox = 0
	}
	if oy < 0 {
		oy = 0
	}
	blendRGBAOnNV12(nv12, width, height, img, ox, oy)
}
