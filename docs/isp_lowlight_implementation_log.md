# ISP Low-Light Enhancement Implementation Log

## Overview

This document records the investigation and implementation of low-light enhancement for the smart pet camera. The goal was to improve YOLO detection accuracy in dark environments by enhancing image brightness through ISP hardware acceleration.

## Investigation Summary

### Attempted Approaches (Failed)

#### 1. ISP Color Processing API
- **API**: `hbn_isp_set_color_process_attr()`
- **Parameters**: brightness, contrast, saturation
- **Result**: API returns success (0), but values don't actually change
- **Evidence**:
  ```
  Before SET: bright=0.0 contrast=1.10 sat=1.00
  Setting: bright=40.0 contrast=1.20 sat=0.90
  set_color_process_attr returned: 0
  After SET: bright=0.0 contrast=1.10 sat=1.00  # No change!
  ```

#### 2. ISP Gamma Correction API
- **API**: `hbn_isp_set_gc_attr()`
- **Parameters**: gamma value (standard_val) or custom curve
- **Result**: Returns error `-65545` (ISP_INVALID_PARAMETER)
- **Note**: Gamma correction may only be configurable at init time via tuning file

#### 3. ISP Exposure/AE Target API
- **API**: `hbn_isp_set_exposure_attr()`
- **Parameters**: AE target, dgain ranges
- **Result**: API accepts values, but no visible change in output
- **Reason**: Sensor already at maximum exposure/gain limits in low-light

### Working Approaches

#### 1. ISP Noise Reduction (3DNR/2DNR)
- **APIs**: `hbn_isp_set_3dnr_attr()`, `hbn_isp_set_2dnr_attr()`
- **Result**: Successfully changes noise reduction strength
- **Use case**: Reduce high-ISO noise in low-light conditions

#### 2. Software Gamma Correction (Post-processing)
- **Method**: LUT-based Y-channel gamma correction
- **Location**: Applied to YOLO input frame (640x640 NV12)
- **Result**: Effectively brightens dark images for better detection

## Final Implementation

### Architecture

```
Camera Sensor
    |
    v
ISP Pipeline (Hardware)
    |-- 3DNR: Temporal noise reduction (strengthened in low-light)
    |-- 2DNR: Spatial noise reduction (strengthened in low-light)
    |
    v
VSE Channel 1 (640x640 NV12)
    |
    v
Software Gamma Correction (CPU)
    |-- Adaptive LUT based on brightness_avg
    |-- 6-level gamma selection
    |
    v
YOLO Input (Shared Memory)
```

### ISP Noise Reduction Profiles

| Brightness Zone | 3DNR Strength | 2DNR Blend |
|-----------------|---------------|------------|
| DARK (< 50)     | 120           | 0.7        |
| DIM (50-70)     | 115           | 0.5        |
| NORMAL (>= 70)  | 113           | 5.0        |

### Adaptive Gamma Correction

| brightness_avg | Gamma | Effect |
|----------------|-------|--------|
| < 20           | 0.40  | Very strong brightening |
| < 35           | 0.50  | Strong brightening |
| < 50           | 0.60  | Moderate brightening |
| < 65           | 0.75  | Light brightening |
| < 80           | 0.85  | Slight brightening |
| >= 80          | 1.00  | No correction |

### Implementation Details

#### Gamma LUT Generation
```c
// Pre-compute 256-byte LUT for each gamma level
for (int i = 0; i < 256; i++) {
    float normalized = i / 255.0f;
    float corrected = powf(normalized, gamma);
    lut[i] = (uint8_t)(corrected * 255.0f + 0.5f);
}
```

#### Application (per YOLO frame)
```c
// Select LUT based on current brightness
const uint8_t *lut = select_gamma_lut(brightness_avg);
if (lut) {
    // Apply to Y channel only (640*640 = 409,600 pixels)
    for (size_t i = 0; i < y_plane_size; i++) {
        y_data[i] = lut[y_data[i]];
    }
}
```

## Key Findings

### D-Robotics ISP Limitations
1. **Color Processing**: The `hbn_isp_color_process_attr` API accepts parameters but doesn't apply them at runtime. Values are likely locked by the tuning file.

2. **Gamma Correction**: The `hbn_isp_gc_attr` API returns `INVALID_PARAMETER` when trying to change gamma at runtime.

3. **Exposure Settings**: AE target changes are accepted but have no visible effect when the sensor is already at its exposure/gain limits.

4. **Noise Reduction**: 3DNR and 2DNR settings can be successfully modified at runtime.

### AE Statistics Format
- **Camera 0 (Day)**: 8-bit range (max ~255)
- **Camera 1 (Night)**: 16-bit range (max ~65535)
- **Solution**: Auto-detect bit depth based on max value and normalize to 0-255

```c
int shift_bits = 0;
if (max_val > 4095) {
    shift_bits = 8;  // 16-bit to 8-bit
} else if (max_val > 255) {
    shift_bits = 4;  // 12-bit to 8-bit
}
result->brightness_avg = (float)(raw_avg >> shift_bits);
```

## Files Modified

- `src/capture/camera_pipeline.c` - Adaptive gamma correction for YOLO frames
- `src/capture/isp_brightness.c` - ISP noise reduction control
- `src/capture/isp_lowlight_profile.h` - Profile definitions (NR parameters)
- `src/capture/Makefile` - Added `-lm` for math library

## Performance Considerations

- **Gamma LUT**: Pre-computed at startup, negligible runtime cost
- **LUT Application**: ~410K byte lookups per frame (fast memory access)
- **ISP NR Updates**: Throttled to ~1Hz to minimize API overhead

## Future Improvements

1. **Tuning File Modification**: Investigate if ISP color processing can be configured via the sensor tuning JSON file for different lighting conditions.

2. **SIMD Optimization**: Apply NEON intrinsics to gamma correction loop for potential speedup.

3. **Dynamic NR Adjustment**: Fine-tune noise reduction based on actual noise level detection rather than just brightness.
