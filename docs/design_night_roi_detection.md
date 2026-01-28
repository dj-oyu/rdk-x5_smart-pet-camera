# Night Camera ROI Detection Design

## Overview

This document describes the ROI (Region of Interest) based detection mode for the night camera (camera_id=1) to improve YOLO detection rate on 1280x720 input.

## Problem Statement

The night camera uses a wide-angle lens to capture a larger area. At 640x360 input resolution, small objects (especially pets at a distance) are often missed by YOLO detection. By using higher resolution input (1280x720) and sliding ROI inference, we can improve detection coverage.

## Design Decisions

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Input Resolution | 1280x720 | 2x width for better object detail |
| ROI Size | 640x640 | YOLO model native input size |
| ROI Count | 3 | Horizontal coverage with overlap |
| Overlap | 320px (50%) | Ensures objects at boundaries are detected |
| Target Camera | Night camera only (camera_id=1) | Day camera uses different lens |
| Effective FPS | ~22fps | 30fps / (3 ROIs / ~2.2 inferences/frame) |

## ROI Layout

```
1280x720 Input Frame
+----------------+----------------+----------------+
|                |                |                |
|     ROI 0      |     ROI 1      |     ROI 2      |
|   (0,40)       |  (320,40)      |  (640,40)      |
|   640x640      |   640x640      |   640x640      |
|                |                |                |
+----------------+----------------+----------------+
      x=0            x=320            x=640

Stride: 320px
Overlap Zones: x=320-640 (ROI0/ROI1), x=640-960 (ROI1/ROI2)
```

### Vertical Padding

Since the frame height is 720px and ROI height is 640px:
- Vertical padding: (720 - 640) / 2 = 40px top/bottom
- ROI Y offset: 40px (centered vertically)

### ROI Coordinates

| ROI Index | X | Y | Width | Height | Coverage |
|-----------|---|---|-------|--------|----------|
| 0 | 0 | 40 | 640 | 640 | 0-640 |
| 1 | 320 | 40 | 640 | 640 | 320-960 |
| 2 | 640 | 40 | 640 | 640 | 640-1280 |

## Processing Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Camera Daemon (C)                        │
│  VSE Ch1: 1280x720 (night camera only)                     │
│  └─> Zero-copy SHM (share_id)                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                YOLO Detector Daemon (Python)                │
│                                                             │
│  1. Check camera_id                                         │
│     - camera_id=0 (day): Direct 640x360 letterbox           │
│     - camera_id=1 (night): ROI mode (this design)           │
│                                                             │
│  2. ROI Processing Loop (for each ROI):                     │
│     a. Crop 640x640 from 1280x720                           │
│     b. Run YOLO inference                                   │
│     c. Transform coordinates: ROI-relative → frame-absolute │
│                                                             │
│  3. Merge Overlapping Detections:                           │
│     a. Group by class                                       │
│     b. Apply class-wise NMS (IoU threshold: 0.4)            │
│     c. Boundary-aware bbox merging for split objects        │
│                                                             │
│  4. Write merged results to Detection SHM                   │
└─────────────────────────────────────────────────────────────┘
```

## Detection Merging Logic

### Overlap Zone Handling

Objects crossing ROI boundaries may be detected twice (partially in each ROI). The merging logic handles this:

1. **Coordinate Transformation**: Convert ROI-relative coordinates to frame-absolute
2. **Class Grouping**: Group detections by class for class-wise NMS
3. **NMS Application**: Apply Non-Maximum Suppression with IoU threshold 0.4
4. **Boundary Merge**: For objects near boundaries (x=320-640, x=640-960), merge split bboxes

### Boundary Merge Algorithm

```python
def merge_boundary_bboxes(detections, boundary_x, margin=50):
    """
    Merge bboxes that are split at ROI boundaries.

    For each class, find pairs of bboxes where:
    - bbox1 right edge is near boundary_x
    - bbox2 left edge is near boundary_x
    - Y ranges overlap
    - Horizontal gap is small (<margin)

    Merge by taking the union of both bboxes.
    """
```

## File Changes

| File | Change |
|------|--------|
| `src/capture/vio_lowlevel.c` | Add camera_index parameter to vio_create, conditional VSE Ch1 resolution |
| `src/capture/camera_pipeline.c` | Update ZeroCopyFrame dimensions for night camera |
| `src/common/src/detection/yolo_detector.py` | Add `get_roi_regions_720p()`, `detect_nv12_roi_720p()` |
| `src/detector/yolo_detector_daemon.py` | Add camera_id branching, ROI loop, merge logic |

## Performance Expectations

| Metric | Day Camera (640x360) | Night Camera (1280x720 ROI) |
|--------|---------------------|------------------------------|
| Input Resolution | 640x360 | 1280x720 |
| Inference Per Frame | 1 | 3 (sequential ROIs) |
| Effective FPS | ~30 | ~22 (30/1.35) |
| Detection Coverage | Center-biased | Full horizontal coverage |
| Memory Overhead | None | Minimal (ROI crop buffer) |

## Verification

1. **Profile with `scripts/profile_shm.py`**:
   - Check FPS for night camera when ROI mode active
   - Expected: ~22fps

2. **Detection Comparison**:
   - Compare detection count with/without ROI mode
   - Expected: More detections at frame edges

3. **Boundary Merge Verification**:
   - Test with objects positioned at x=320, x=640 (boundaries)
   - Verify single merged bbox instead of duplicates
