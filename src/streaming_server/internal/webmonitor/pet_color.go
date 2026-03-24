package webmonitor

import (
	"log"
	"math"
)

// PetColorResult holds classification output plus diagnostic features.
type PetColorResult struct {
	PetID      string  // "mike", "chatora", "other"
	Confidence float64 // 0.0-1.0
	Scatter    float64 // stdU + stdV
	MeanU      float64 // filtered mean U
	MeanV      float64 // filtered mean V
	MeanY      float64 // bbox luminance (Y plane average)
	UVDist     float64 // distance from orange reference (U=110, V=155)
	NumSamples int     // filtered UV sample count
}

// Orange reference point for chatora (BT.601 NV12).
// Chatora's fur maps to approximately U=110, V=155.
const (
	orangeRefU = 110.0
	orangeRefV = 155.0
)

// Classification thresholds (initial values — calibrate from production logging).
const (
	scatterHigh   = 5.5  // above → likely mike
	scatterLow    = 4.5  // below → likely chatora
	uvDistClose   = 15.0 // chatora is within this distance of orange ref
	uvDistFar     = 25.0 // mike is beyond this distance
	nightYThresh  = 60.0 // meanY below this → night/IR, UV unreliable
	minBBoxArea   = 2000 // ~45x45 pixels in frame coords
	minConfThresh = 0.5  // dominantPetID: total score below → "other"
)

// classifyPetColor analyzes the bbox region of an NV12 frame to determine pet identity.
// Returns PetColorResult with "mike" (tricolor/calico), "chatora" (orange tabby), or "other".
//
// Uses UV chrominance scatter + UV distance from orange reference as dual features.
// Mean Y (luminance) detects night/IR conditions where UV is unreliable.
func classifyPetColor(nv12 []byte, w, h int, bbox BoundingBox) PetColorResult {
	other := PetColorResult{PetID: "other"}
	if len(nv12) < w*h*3/2 || bbox.W <= 0 || bbox.H <= 0 {
		return other
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
		return other
	}

	// Phase 0: Minimum bbox area gate
	bboxArea := (x1 - x0) * (y1 - y0)
	if bboxArea < minBBoxArea {
		return other
	}

	// Phase 1a: Sample Y plane for luminance (4px stride)
	var sumY float64
	var yCount int
	for py := y0; py < y1; py += 4 {
		for px := x0; px < x1; px += 4 {
			sumY += float64(nv12[py*w+px])
			yCount++
		}
	}
	meanY := 0.0
	if yCount > 0 {
		meanY = sumY / float64(yCount)
	}

	// Phase 1b: Sample UV values from bbox (2px stride, aligned to UV grid)
	uvBase := w * h
	type uvSample struct{ u, v int }
	var samples []uvSample

	for py := y0; py < y1; py += 2 {
		for px := x0; px < x1; px += 2 {
			uvRow := py / 2
			uvCol := (px / 2) * 2
			idx := uvBase + uvRow*w + uvCol
			if idx+1 >= len(nv12) {
				continue
			}
			u := int(nv12[idx])
			v := int(nv12[idx+1])
			samples = append(samples, uvSample{u, v})
		}
	}

	if len(samples) < 16 {
		return other
	}

	// Phase 2: Background removal via UV histogram frequency filter.
	const bins = 16
	const quantShift = 4
	var hist [bins][bins]int
	for _, s := range samples {
		bu := s.u >> quantShift
		bv := s.v >> quantShift
		if bu >= bins {
			bu = bins - 1
		}
		if bv >= bins {
			bv = bins - 1
		}
		hist[bu][bv]++
	}

	minCount := len(samples) * 2 / 100
	if minCount < 1 {
		minCount = 1
	}

	filtered := samples[:0:0]
	for _, s := range samples {
		bu := s.u >> quantShift
		bv := s.v >> quantShift
		if bu >= bins {
			bu = bins - 1
		}
		if bv >= bins {
			bv = bins - 1
		}
		if hist[bu][bv] >= minCount {
			filtered = append(filtered, s)
		}
	}

	if len(filtered) < 32 {
		return other
	}

	// Phase 3: Compute UV scatter + mean UV
	var sumU, sumV float64
	for _, s := range filtered {
		sumU += float64(s.u)
		sumV += float64(s.v)
	}
	n := float64(len(filtered))
	meanU := sumU / n
	meanV := sumV / n

	var varU, varV float64
	for _, s := range filtered {
		du := float64(s.u) - meanU
		dv := float64(s.v) - meanV
		varU += du * du
		varV += dv * dv
	}
	stdU := math.Sqrt(varU / n)
	stdV := math.Sqrt(varV / n)
	scatter := stdU + stdV

	// Phase 4: UV distance from orange reference
	uvDist := math.Sqrt((meanU-orangeRefU)*(meanU-orangeRefU) + (meanV-orangeRefV)*(meanV-orangeRefV))

	// Phase 5: Dual-feature classification
	var petID string
	var confidence float64

	switch {
	case scatter > scatterHigh && uvDist > uvDistClose:
		petID = "mike"
		confidence = math.Min(1.0, (scatter-scatterHigh)/3.0+(uvDist-uvDistClose)/20.0)
	case scatter < scatterLow && uvDist < uvDistFar:
		petID = "chatora"
		confidence = math.Min(1.0, (scatterLow-scatter)/3.0+(uvDistFar-uvDist)/20.0)
	default:
		// Ambiguous zone — make a guess with low confidence
		if scatter > 5.0 {
			petID = "mike"
		} else {
			petID = "chatora"
		}
		confidence = 0.3
	}

	// Phase 6: Night attenuation — UV unreliable under IR
	if meanY < nightYThresh {
		confidence *= meanY / nightYThresh
	}

	result := PetColorResult{
		PetID:      petID,
		Confidence: confidence,
		Scatter:    scatter,
		MeanU:      meanU,
		MeanV:      meanV,
		MeanY:      meanY,
		UVDist:     uvDist,
		NumSamples: len(filtered),
	}

	log.Printf("[PetColor] pet_id=%s conf=%.2f scatter=%.2f meanU=%.1f meanV=%.1f meanY=%.1f uvDist=%.1f samples=%d bbox=%dx%d",
		result.PetID, result.Confidence, result.Scatter,
		result.MeanU, result.MeanV, result.MeanY, result.UVDist,
		result.NumSamples, bbox.W, bbox.H)

	return result
}

// dominantPetID determines the pet_id from a set of panels by confidence-weighted vote.
// Returns "other" if total winning score is below minConfThresh.
func dominantPetID(panels []capturedPanel) string {
	scores := map[string]float64{}
	for _, p := range panels {
		if p.petClass != "" && p.petClass != "other" {
			scores[p.petClass] += p.petConfidence
		}
	}

	best := "other"
	bestScore := 0.0
	for id, s := range scores {
		if s > bestScore {
			best = id
			bestScore = s
		}
	}

	if bestScore < minConfThresh {
		return "other"
	}
	return best
}
