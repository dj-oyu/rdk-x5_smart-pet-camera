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
	// Ensure even dimensions
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
			// RGBA returns 16-bit values, scale to 8-bit
			rf := float64(r >> 8)
			gf := float64(g >> 8)
			bf := float64(b >> 8)

			// RGB → YUV (BT.601)
			y := 0.299*rf + 0.587*gf + 0.114*bf
			if y > 255 {
				y = 255
			}
			nv12[py*w+px] = byte(y)

			// UV subsampled 2x2
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
// Layout: 2x2 grid with margin=12, gap=8, border=2, panelW=404, panelH=228.
func extractPanel(img image.Image, panelIdx int) image.Image {
	const (
		margin  = 12
		gap     = 8
		border  = 2
		panelW  = 404
		panelH  = 228
		cellW   = panelW + 2*border // 408
		cellH   = panelH + 2*border // 232
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

func TestClassifyPetColor_RealMike(t *testing.T) {
	img := loadTestImage(t, "testdata/mike.jpg")
	panel := extractPanel(img, 1)
	nv12, w, h := rgbImageToNV12(panel)

	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	got, scatter := classifyPetColorDebug(nv12, w, h, bbox)

	t.Logf("mike panel 1: classified as %q, scatter=%.2f (w=%d, h=%d)", got, scatter, w, h)
	if got != "mike" {
		t.Errorf("expected mike, got %q (scatter=%.2f)", got, scatter)
	}
}

func TestClassifyPetColor_RealChatora(t *testing.T) {
	img := loadTestImage(t, "testdata/chatora.jpg")
	panel := extractPanel(img, 1)
	nv12, w, h := rgbImageToNV12(panel)

	bbox := BoundingBox{X: 0, Y: 0, W: w, H: h}
	got, scatter := classifyPetColorDebug(nv12, w, h, bbox)

	t.Logf("chatora panel 1: classified as %q, scatter=%.2f (w=%d, h=%d)", got, scatter, w, h)
	if got != "chatora" {
		t.Errorf("expected chatora, got %q (scatter=%.2f)", got, scatter)
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
				got := classifyPetColor(nv12, w, h, bbox)
				t.Logf("  panel %d: %q", panelIdx, got)
			}
		})
	}
}

func TestClassifyPetColor_EmptyBBox(t *testing.T) {
	nv12 := make([]byte, 640*480*3/2)
	got := classifyPetColor(nv12, 640, 480, BoundingBox{X: 0, Y: 0, W: 0, H: 0})
	if got != "other" {
		t.Errorf("expected other for empty bbox, got %q", got)
	}
}

func TestClassifyPetColor_NilData(t *testing.T) {
	got := classifyPetColor(nil, 640, 480, BoundingBox{X: 0, Y: 0, W: 100, H: 100})
	if got != "other" {
		t.Errorf("expected other for nil data, got %q", got)
	}
}

func TestDominantPetID(t *testing.T) {
	panels := []capturedPanel{
		{petClass: "chatora"},
		{petClass: "chatora"},
		{petClass: "mike"},
		{petClass: "chatora"},
	}
	if got := dominantPetID(panels); got != "chatora" {
		t.Errorf("expected chatora majority, got %q", got)
	}
}

func TestDominantPetID_AllEmpty(t *testing.T) {
	panels := []capturedPanel{{}, {}, {}}
	if got := dominantPetID(panels); got != "other" {
		t.Errorf("expected other for empty panels, got %q", got)
	}
}
