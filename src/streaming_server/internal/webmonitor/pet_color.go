package webmonitor

import "math"

// classifyPetColor analyzes the bbox region of an NV12 frame to determine pet identity.
// Returns "mike" (tricolor/calico), "chatora" (orange tabby), or "other".
//
// Key discriminators from real camera data:
//   - Mike: prominent white patches (low sat, high value) + dark patches
//   - Chatora: warm orange hue dominant, no large white patches
func classifyPetColor(nv12 []byte, w, h int, bbox BoundingBox) string {
	if len(nv12) < w*h*3/2 || bbox.W <= 0 || bbox.H <= 0 {
		return "other"
	}

	// Clamp bbox to frame bounds
	x0, y0 := bbox.X, bbox.Y
	x1, y1 := bbox.X+bbox.W, bbox.Y+bbox.H
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 > w {
		x1 = w
	}
	if y1 > h {
		y1 = h
	}
	if x1 <= x0 || y1 <= y0 {
		return "other"
	}

	uvBase := w * h
	var orangeCount, whiteCount, blackCount, totalSampled int

	for py := y0; py < y1; py += 2 {
		for px := x0; px < x1; px += 2 {
			yVal := float64(nv12[py*w+px])
			uvRow := py / 2
			uvCol := (px / 2) * 2
			uVal := float64(nv12[uvBase+uvRow*w+uvCol]) - 128.0
			vVal := float64(nv12[uvBase+uvRow*w+uvCol+1]) - 128.0

			r := clampF(yVal + 1.402*vVal)
			g := clampF(yVal - 0.344*uVal - 0.714*vVal)
			b := clampF(yVal + 1.772*uVal)

			hue, sat, val := rgbToHSV(r, g, b)
			totalSampled++

			if val < 25 {
				blackCount++
			} else if sat < 40 && val > 130 {
				whiteCount++
			} else if sat > 20 && hue >= 8 && hue <= 45 && val >= 25 {
				orangeCount++
			}
		}
	}

	if totalSampled == 0 {
		return "other"
	}

	total := float64(totalSampled)
	whiteRatio := float64(whiteCount) / total
	blackRatio := float64(blackCount) / total
	orangeRatio := float64(orangeCount) / total

	// Tricolor: white + (black or orange) patches → mike
	if whiteRatio > 0.08 && (blackRatio > 0.05 || orangeRatio > 0.05) {
		return "mike"
	}

	// Orange dominant → chatora
	if orangeRatio > 0.15 {
		return "chatora"
	}

	return "other"
}

func clampF(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}

// rgbToHSV converts RGB (0-255) to HSV where H is 0-360, S and V are 0-255.
func rgbToHSV(r, g, b float64) (h, s, v float64) {
	r /= 255.0
	g /= 255.0
	b /= 255.0

	max := math.Max(r, math.Max(g, b))
	min := math.Min(r, math.Min(g, b))
	delta := max - min

	v = max * 255.0

	if max == 0 {
		return 0, 0, v
	}
	s = (delta / max) * 255.0

	if delta == 0 {
		return 0, s, v
	}

	switch max {
	case r:
		h = 60 * math.Mod((g-b)/delta, 6)
	case g:
		h = 60 * ((b-r)/delta + 2)
	case b:
		h = 60 * ((r-g)/delta + 4)
	}
	if h < 0 {
		h += 360
	}
	return h, s, v
}

// dominantPetID determines the pet_id from a set of panels by majority vote.
func dominantPetID(panels []capturedPanel) string {
	counts := map[string]int{}
	for _, p := range panels {
		if p.petClass != "" {
			counts[p.petClass]++
		}
	}

	best := "other"
	bestCount := 0
	for id, c := range counts {
		if c > bestCount {
			best = id
			bestCount = c
		}
	}
	return best
}
