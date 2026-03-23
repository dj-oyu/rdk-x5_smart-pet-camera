"""Image conversion utilities for on-demand YOLO detection.

Converts JPEG/BGR images to NV12 format required by the BPU YOLO pipeline.
Used by the detector daemon's HTTP /detect endpoint for processing
arbitrary images (e.g., retroactive detection on existing comic JPEGs).
"""

import cv2
import numpy as np


def bgr_to_nv12(bgr: np.ndarray) -> tuple[np.ndarray, int, int]:
    """Convert BGR image to NV12 byte array.

    Args:
        bgr: BGR image (H, W, 3), uint8. Dimensions will be forced even.

    Returns:
        (nv12_array, width, height) — contiguous uint8 array of Y + interleaved UV.
    """
    h, w = bgr.shape[:2]
    h, w = h & ~1, w & ~1
    bgr = bgr[:h, :w]

    # BGR → YUV I420 (Y full + U quarter + V quarter)
    yuv_i420 = cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420)

    y_plane = yuv_i420[:h, :].flatten()
    u_plane = yuv_i420[h : h + h // 4].reshape(h // 2, w // 2)
    v_plane = yuv_i420[h + h // 4 :].reshape(h // 2, w // 2)

    # NV12: Y plane + interleaved UV
    nv12 = np.empty(w * h * 3 // 2, dtype=np.uint8)
    nv12[: w * h] = y_plane
    uv = np.empty((h // 2, w), dtype=np.uint8)
    uv[:, 0::2] = u_plane
    uv[:, 1::2] = v_plane
    nv12[w * h :] = uv.flatten()

    return nv12, w, h


def letterbox_bgr(
    bgr: np.ndarray, target: int = 640
) -> tuple[np.ndarray, float, int, int]:
    """Resize BGR image with letterbox padding to target×target.

    Args:
        bgr: BGR image (H, W, 3), uint8.
        target: Target size (square).

    Returns:
        (letterboxed_bgr, scale, pad_x, pad_y)
        - letterboxed_bgr: (target, target, 3) BGR image
        - scale: resize scale factor (original → resized)
        - pad_x, pad_y: padding offset in letterboxed image
    """
    h, w = bgr.shape[:2]
    scale = target / max(w, h)
    new_w, new_h = int(w * scale) & ~1, int(h * scale) & ~1

    resized = cv2.resize(bgr, (new_w, new_h))

    canvas = np.zeros((target, target, 3), dtype=np.uint8)
    pad_x = (target - new_w) // 2
    pad_y = (target - new_h) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

    return canvas, scale, pad_x, pad_y


def jpeg_to_yolo_nv12(
    jpeg_bytes: bytes, target: int = 640
) -> tuple[np.ndarray, int, int, float, int, int]:
    """Full pipeline: JPEG bytes → letterboxed NV12 for YOLO.

    Args:
        jpeg_bytes: Raw JPEG data.
        target: YOLO input size (default 640).

    Returns:
        (nv12, width, height, scale, pad_x, pad_y)
        - nv12: NV12 byte array (target×target)
        - width, height: original image dimensions
        - scale, pad_x, pad_y: letterbox parameters for bbox coordinate restoration
    """
    bgr = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("Failed to decode JPEG")

    orig_h, orig_w = bgr.shape[:2]
    letterboxed, scale, pad_x, pad_y = letterbox_bgr(bgr, target)
    nv12, nv12_w, nv12_h = bgr_to_nv12(letterboxed)

    return nv12, orig_w, orig_h, scale, pad_x, pad_y
