//! CLAHE (Contrast Limited Adaptive Histogram Equalization) for IR night frames.
//!
//! Operates on the Y channel of RGB frames. Parameters match rdk-x5's Python
//! detector: clipLimit=3.0, tileGridSize=(8,8), medianBlur k=3.

const TILE_X: usize = 8;
const TILE_Y: usize = 8;
const CLIP_LIMIT: f32 = 3.0;
const HIST_BINS: usize = 256;

/// Apply CLAHE + median blur to an RGB24 frame, then encode to JPEG.
///
/// Uses proper YCrCb round-trip (matching OpenCV's cv2.cvtColor):
/// 1. RGB → YCrCb
/// 2. Median blur (k=3) on Y — IR noise reduction
/// 3. CLAHE on Y
/// 4. Replace Y, keep Cr/Cb intact
/// 5. YCrCb → RGB
/// 6. Encode to JPEG
pub fn apply_clahe_to_jpeg(rgb: &[u8], width: usize, height: usize, quality: u8) -> Vec<u8> {
    let pixel_count = width * height;
    debug_assert_eq!(rgb.len(), pixel_count * 3);

    // RGB → YCrCb (BT.601, same as OpenCV)
    let mut y_ch = vec![0u8; pixel_count];
    let mut cr_ch = vec![0u8; pixel_count];
    let mut cb_ch = vec![0u8; pixel_count];
    for i in 0..pixel_count {
        let r = rgb[i * 3] as f32;
        let g = rgb[i * 3 + 1] as f32;
        let b = rgb[i * 3 + 2] as f32;
        y_ch[i] = (0.299 * r + 0.587 * g + 0.114 * b)
            .round()
            .clamp(0.0, 255.0) as u8;
        cr_ch[i] = (0.5 * r - 0.4187 * g - 0.0813 * b + 128.0)
            .round()
            .clamp(0.0, 255.0) as u8;
        cb_ch[i] = (-0.1687 * r - 0.3313 * g + 0.5 * b + 128.0)
            .round()
            .clamp(0.0, 255.0) as u8;
    }

    // Median blur (3x3) on Y — IR noise reduction
    let y_blurred = median_blur_3x3(&y_ch, width, height);

    // CLAHE on Y
    let y_clahe = clahe(&y_blurred, width, height);

    // YCrCb → RGB with CLAHE'd Y, original Cr/Cb
    let mut out = vec![0u8; pixel_count * 3];
    for i in 0..pixel_count {
        let y = y_clahe[i] as f32;
        let cr = cr_ch[i] as f32 - 128.0;
        let cb = cb_ch[i] as f32 - 128.0;
        out[i * 3] = (y + 1.402 * cr).round().clamp(0.0, 255.0) as u8;
        out[i * 3 + 1] = (y - 0.3441 * cb - 0.7141 * cr).round().clamp(0.0, 255.0) as u8;
        out[i * 3 + 2] = (y + 1.772 * cb).round().clamp(0.0, 255.0) as u8;
    }

    encode_jpeg(&out, width, height, quality)
}

/// CLAHE: Contrast Limited Adaptive Histogram Equalization.
fn clahe(y: &[u8], width: usize, height: usize) -> Vec<u8> {
    let tile_w = width / TILE_X;
    let tile_h = height / TILE_Y;
    let tile_pixels = tile_w * tile_h;
    let clip_count = (CLIP_LIMIT * tile_pixels as f32 / HIST_BINS as f32) as u32;

    // Build clipped CDFs for each tile
    let mut cdfs = vec![[0u8; HIST_BINS]; TILE_X * TILE_Y];
    for ty in 0..TILE_Y {
        for tx in 0..TILE_X {
            let mut hist = [0u32; HIST_BINS];
            let x0 = tx * tile_w;
            let y0 = ty * tile_h;
            for row in y0..y0 + tile_h {
                for col in x0..x0 + tile_w {
                    hist[y[row * width + col] as usize] += 1;
                }
            }

            // Clip and redistribute
            let mut excess = 0u32;
            for bin in hist.iter_mut() {
                if *bin > clip_count {
                    excess += *bin - clip_count;
                    *bin = clip_count;
                }
            }
            let redistribute = excess / HIST_BINS as u32;
            let remainder = excess as usize % HIST_BINS;
            for (i, bin) in hist.iter_mut().enumerate() {
                *bin += redistribute;
                if i < remainder {
                    *bin += 1;
                }
            }

            // CDF → mapping table
            let mut cdf = [0u32; HIST_BINS];
            cdf[0] = hist[0];
            for i in 1..HIST_BINS {
                cdf[i] = cdf[i - 1] + hist[i];
            }
            let cdf_min = cdf.iter().copied().find(|&v| v > 0).unwrap_or(0);
            let denom = (tile_pixels as u32).saturating_sub(cdf_min).max(1);
            for i in 0..HIST_BINS {
                cdfs[ty * TILE_X + tx][i] =
                    ((cdf[i].saturating_sub(cdf_min) as f32 / denom as f32) * 255.0).round() as u8;
            }
        }
    }

    // Bilinear interpolation between tile CDFs
    let mut out = vec![0u8; width * height];
    let half_tw = tile_w as f32 / 2.0;
    let half_th = tile_h as f32 / 2.0;

    for row in 0..height {
        for col in 0..width {
            let val = y[row * width + col] as usize;

            // Find surrounding tile centers
            let fy = (row as f32 - half_th) / tile_h as f32;
            let fx = (col as f32 - half_tw) / tile_w as f32;

            let ty0 = (fy.floor() as isize).clamp(0, TILE_Y as isize - 1) as usize;
            let ty1 = (ty0 + 1).min(TILE_Y - 1);
            let tx0 = (fx.floor() as isize).clamp(0, TILE_X as isize - 1) as usize;
            let tx1 = (tx0 + 1).min(TILE_X - 1);

            let wy = (fy - fy.floor()).clamp(0.0, 1.0);
            let wx = (fx - fx.floor()).clamp(0.0, 1.0);

            let v00 = cdfs[ty0 * TILE_X + tx0][val] as f32;
            let v01 = cdfs[ty0 * TILE_X + tx1][val] as f32;
            let v10 = cdfs[ty1 * TILE_X + tx0][val] as f32;
            let v11 = cdfs[ty1 * TILE_X + tx1][val] as f32;

            let top = v00 * (1.0 - wx) + v01 * wx;
            let bot = v10 * (1.0 - wx) + v11 * wx;
            out[row * width + col] = (top * (1.0 - wy) + bot * wy).round() as u8;
        }
    }

    out
}

/// 3x3 median blur.
fn median_blur_3x3(src: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = src.to_vec();
    let mut window = [0u8; 9];

    for row in 1..height - 1 {
        for col in 1..width - 1 {
            let mut k = 0;
            for dy in 0..3usize {
                for dx in 0..3usize {
                    window[k] = src[(row + dy - 1) * width + (col + dx - 1)];
                    k += 1;
                }
            }
            // Partial sort to find median (5th element of 9)
            window.sort_unstable();
            out[row * width + col] = window[4];
        }
    }
    out
}

/// Encode RGB24 buffer to JPEG bytes.
fn encode_jpeg(rgb: &[u8], width: usize, height: usize, quality: u8) -> Vec<u8> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ColorType, ImageEncoder};
    use std::io::Cursor;

    let mut buf = Cursor::new(Vec::with_capacity(256 * 1024));
    let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .write_image(rgb, width as u32, height as u32, ColorType::Rgb8.into())
        .expect("JPEG encode failed");
    buf.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clahe_smoke_test() {
        // 16x16 dark gradient image
        let w = 16;
        let h = 16;
        let mut rgb = vec![0u8; w * h * 3];
        for i in 0..w * h {
            let v = (i * 255 / (w * h)) as u8;
            rgb[i * 3] = v;
            rgb[i * 3 + 1] = v;
            rgb[i * 3 + 2] = v;
        }

        let jpeg = apply_clahe_to_jpeg(&rgb, w, h, 90);
        // Should produce valid JPEG (starts with FF D8)
        assert!(jpeg.len() > 100);
        assert_eq!(jpeg[0], 0xFF);
        assert_eq!(jpeg[1], 0xD8);
    }

    #[test]
    fn median_blur_preserves_size() {
        let w = 32;
        let h = 32;
        let src = vec![128u8; w * h];
        let out = median_blur_3x3(&src, w, h);
        assert_eq!(out.len(), w * h);
        assert_eq!(out[w + 1], 128); // uniform → median is same
    }
}
