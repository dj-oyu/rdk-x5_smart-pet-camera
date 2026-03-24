package webmonitor

import (
	"image"
	"image/jpeg"
	"os"
	"testing"
)

// rgbImageToNV12 converts an image.Image to NV12 byte slice.
func rgbImageToNV12(img image.Image) ([]byte, int, int) {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w%2 != 0 {
		w--
	}
	if h%2 != 0 {
		h--
	}

	ySize := w * h
	uvSize := w * (h / 2)
	nv12 := make([]byte, ySize+uvSize)

	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			r, g, b, _ := img.At(bounds.Min.X+px, bounds.Min.Y+py).RGBA()
			rf := float64(r >> 8)
			gf := float64(g >> 8)
			bf := float64(b >> 8)

			y := 0.299*rf + 0.587*gf + 0.114*bf
			if y > 255 {
				y = 255
			}
			nv12[py*w+px] = byte(y)

			if py%2 == 0 && px%2 == 0 {
				u := -0.169*rf - 0.331*gf + 0.500*bf + 128
				v := 0.500*rf - 0.419*gf - 0.081*bf + 128
				if u < 0 {
					u = 0
				}
				if u > 255 {
					u = 255
				}
				if v < 0 {
					v = 0
				}
				if v > 255 {
					v = 255
				}
				uvIdx := ySize + (py/2)*w + px
				nv12[uvIdx] = byte(u)
				nv12[uvIdx+1] = byte(v)
			}
		}
	}
	return nv12, w, h
}

// extractPanel extracts panel i (0-3) from a comic composite image.
func extractPanel(img image.Image, panelIdx int) image.Image {
	const (
		margin = 12
		gap    = 8
		border = 2
		panelW = 404
		panelH = 228
		cellW  = panelW + 2*border
		cellH  = panelH + 2*border
	)

	col := panelIdx % 2
	row := panelIdx / 2

	x0 := margin + border + col*(cellW+gap)
	y0 := margin + border + row*(cellH+gap)

	return img.(interface {
		SubImage(r image.Rectangle) image.Image
	}).SubImage(image.Rect(x0, y0, x0+panelW, y0+panelH))
}

func loadTestImage(t *testing.T, path string) image.Image {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("test image not found: %s", path)
	}
	defer f.Close()

	img, err := jpeg.Decode(f)
	if err != nil {
		t.Fatalf("failed to decode %s: %v", path, err)
	}
	return img
}

// makeSyntheticNV12 creates an NV12 frame with uniform Y, U, V values.
func makeSyntheticNV12(w, h int, yVal, uVal, vVal byte) []byte {
	ySize := w * h
	uvSize := w * (h / 2)
	nv12 := make([]byte, ySize+uvSize)
	// Fill Y plane
	for i := 0; i < ySize; i++ {
		nv12[i] = yVal
	}
	// Fill UV plane (interleaved U, V)
	for i := 0; i < uvSize; i += 2 {
		nv12[ySize+i] = uVal
		nv12[ySize+i+1] = vVal
	}
	return nv12
}

// makeBimodalNV12 creates an NV12 frame with two UV regions (left/right split).
func makeBimodalNV12(w, h int, yVal byte, u1, v1, u2, v2 byte) []byte {
	ySize := w * h
	uvSize := w * (h / 2)
	nv12 := make([]byte, ySize+uvSize)
	for i := 0; i < ySize; i++ {
		nv12[i] = yVal
	}
	halfW := w / 2
	for row := 0; row < h/2; row++ {
		for col := 0; col < w; col += 2 {
			idx := ySize + row*w + col
			if col < halfW {
				nv12[idx] = u1
				nv12[idx+1] = v1
			} else {
				nv12[idx] = u2
				nv12[idx+1] = v2
			}
		}
	}
	return nv12
}

// --- Real image tests ---

func TestClassifyPetColor_RealMike(t *testing.T) {
	img := loadTestImage(t, "testdata/mike.jpg")
	panel := extractPanel(img, 1)
	nv12, w, h := rgbImageToNV12(panel)

	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	result := classifyPetColor(nv12, w, h, bbox)

	t.Logf("mike panel 1: pet_id=%s conf=%.2f scatter=%.2f meanU=%.1f meanV=%.1f meanY=%.1f uvDist=%.1f samples=%d",
		result.PetID, result.Confidence, result.Scatter, result.MeanU, result.MeanV, result.MeanY, result.UVDist, result.NumSamples)
	if result.PetID != "mike" {
		t.Errorf("expected mike, got %q (scatter=%.2f, uvDist=%.2f)", result.PetID, result.Scatter, result.UVDist)
	}
}

func TestClassifyPetColor_RealChatora(t *testing.T) {
	img := loadTestImage(t, "testdata/chatora.jpg")
	panel := extractPanel(img, 1)
	nv12, w, h := rgbImageToNV12(panel)

	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	result := classifyPetColor(nv12, w, h, bbox)

	t.Logf("chatora panel 1: pet_id=%s conf=%.2f scatter=%.2f meanU=%.1f meanV=%.1f meanY=%.1f uvDist=%.1f samples=%d",
		result.PetID, result.Confidence, result.Scatter, result.MeanU, result.MeanV, result.MeanY, result.UVDist, result.NumSamples)
	if result.PetID != "chatora" {
		t.Errorf("expected chatora, got %q (scatter=%.2f, uvDist=%.2f)", result.PetID, result.Scatter, result.UVDist)
	}
}

func TestClassifyPetColor_AllPanels(t *testing.T) {
	tests := []struct {
		file     string
		expected string
	}{
		{"testdata/mike.jpg", "mike"},
		{"testdata/chatora.jpg", "chatora"},
	}

	for _, tt := range tests {
		t.Run(tt.expected, func(t *testing.T) {
			img := loadTestImage(t, tt.file)
			for panelIdx := 1; panelIdx <= 3; panelIdx++ {
				panel := extractPanel(img, panelIdx)
				nv12, w, h := rgbImageToNV12(panel)
				bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
				result := classifyPetColor(nv12, w, h, bbox)
				t.Logf("  panel %d: pet_id=%s conf=%.2f scatter=%.2f uvDist=%.1f meanY=%.1f",
					panelIdx, result.PetID, result.Confidence, result.Scatter, result.UVDist, result.MeanY)
			}
		})
	}
}

// --- Synthetic tests ---

func TestClassifyPetColor_UniformOrange(t *testing.T) {
	// Uniform orange UV (near chatora reference) should classify as chatora
	w, h := 100, 100
	nv12 := makeSyntheticNV12(w, h, 120, 110, 155) // Y=120, U=110, V=155
	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	result := classifyPetColor(nv12, w, h, bbox)

	t.Logf("uniform orange: pet_id=%s conf=%.2f scatter=%.2f uvDist=%.1f", result.PetID, result.Confidence, result.Scatter, result.UVDist)
	if result.PetID != "chatora" {
		t.Errorf("expected chatora for uniform orange UV, got %q", result.PetID)
	}
	if result.Confidence < 0.3 {
		t.Errorf("expected reasonable confidence for clear orange, got %.2f", result.Confidence)
	}
}

func TestClassifyPetColor_HighScatter(t *testing.T) {
	// Bimodal UV distribution → high scatter → mike
	w, h := 100, 100
	nv12 := makeBimodalNV12(w, h, 120, 100, 160, 150, 110) // Two distinct UV clusters
	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	result := classifyPetColor(nv12, w, h, bbox)

	t.Logf("bimodal UV: pet_id=%s conf=%.2f scatter=%.2f uvDist=%.1f", result.PetID, result.Confidence, result.Scatter, result.UVDist)
	if result.PetID != "mike" {
		t.Errorf("expected mike for high-scatter bimodal UV, got %q (scatter=%.2f)", result.PetID, result.Scatter)
	}
}

func TestClassifyPetColor_NightCondition(t *testing.T) {
	// Very dark frame (Y < 60) → confidence should be reduced
	w, h := 100, 100
	nv12 := makeSyntheticNV12(w, h, 30, 110, 155) // Y=30 (night), orange UV
	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	result := classifyPetColor(nv12, w, h, bbox)

	t.Logf("night: pet_id=%s conf=%.2f meanY=%.1f", result.PetID, result.Confidence, result.MeanY)
	if result.MeanY >= nightYThresh {
		t.Errorf("expected meanY < %.0f for dark frame, got %.1f", nightYThresh, result.MeanY)
	}
	if result.Confidence > 0.6 {
		t.Errorf("expected reduced confidence in night condition, got %.2f", result.Confidence)
	}
}

func TestClassifyPetColor_SmallBBox(t *testing.T) {
	w, h := 200, 200
	nv12 := makeSyntheticNV12(w, h, 120, 110, 155)
	// 30x30 = 900 < minBBoxArea (2000) → "other"
	bbox := BoundingBox{X: 10, Y: 10, W: 30, H: 30}
	result := classifyPetColor(nv12, w, h, bbox)

	if result.PetID != "other" {
		t.Errorf("expected other for small bbox (30x30), got %q", result.PetID)
	}
}

func TestClassifyPetColor_EmptyBBox(t *testing.T) {
	nv12 := make([]byte, 640*480*3/2)
	result := classifyPetColor(nv12, 640, 480, BoundingBox{X: 0, Y: 0, W: 0, H: 0})
	if result.PetID != "other" {
		t.Errorf("expected other for empty bbox, got %q", result.PetID)
	}
}

func TestClassifyPetColor_NilData(t *testing.T) {
	result := classifyPetColor(nil, 640, 480, BoundingBox{X: 0, Y: 0, W: 100, H: 100})
	if result.PetID != "other" {
		t.Errorf("expected other for nil data, got %q", result.PetID)
	}
}

// --- dominantPetID tests ---

func TestDominantPetID(t *testing.T) {
	panels := []capturedPanel{
		{petClass: "chatora", petConfidence: 0.8},
		{petClass: "chatora", petConfidence: 0.7},
		{petClass: "mike", petConfidence: 0.9},
		{petClass: "chatora", petConfidence: 0.6},
	}
	if got := dominantPetID(panels); got != "chatora" {
		t.Errorf("expected chatora (total 2.1 vs mike 0.9), got %q", got)
	}
}

func TestDominantPetID_ConfidenceWeighted(t *testing.T) {
	// One high-confidence mike vs three low-confidence chatora
	panels := []capturedPanel{
		{petClass: "mike", petConfidence: 0.95},
		{petClass: "chatora", petConfidence: 0.25},
		{petClass: "chatora", petConfidence: 0.25},
		{petClass: "chatora", petConfidence: 0.25},
	}
	got := dominantPetID(panels)
	// mike=0.95, chatora=0.75 → mike wins
	if got != "mike" {
		t.Errorf("expected mike (0.95 > 0.75 confidence), got %q", got)
	}
}

func TestDominantPetID_AllLowConfidence(t *testing.T) {
	panels := []capturedPanel{
		{petClass: "mike", petConfidence: 0.1},
		{petClass: "chatora", petConfidence: 0.1},
		{petClass: "mike", petConfidence: 0.1},
		{petClass: "chatora", petConfidence: 0.1},
	}
	got := dominantPetID(panels)
	// mike=0.2, chatora=0.2, both < minConfThresh(0.5) → "other"
	if got != "other" {
		t.Errorf("expected other for all-low-confidence panels, got %q", got)
	}
}

func TestDominantPetID_AllEmpty(t *testing.T) {
	panels := []capturedPanel{{}, {}, {}}
	if got := dominantPetID(panels); got != "other" {
		t.Errorf("expected other for empty panels, got %q", got)
	}
}
