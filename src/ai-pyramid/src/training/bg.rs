//! Per-pixel background model for detecting empty frames.
//!
//! Builds a Gaussian background model (per-pixel mean + std) from a set of
//! known-empty reference frames. Any frame can then be scored as the fraction
//! of pixels that deviate more than `k * std` (with an absolute minimum
//! threshold) from the background mean.
//!
//! Typical scores:
//! - Another empty frame:   0–2 %
//! - Dark cat (chatora):   ~40 %
//! - Bright cat (mike):    ~70 %
//! - Person:               ~50 %

use std::path::{Path, PathBuf};

/// Minimum number of reference frames required to build a model.
pub const MIN_REF_FRAMES: usize = 3;

/// Sigma factor for the outlier threshold.
const SIGMA: f32 = 2.0;

/// Absolute intensity floor — differences smaller than this are never counted
/// as outliers even when std ≈ 0 (pixel perfectly stable across refs).
const ABS_FLOOR: f32 = 8.0;

// ── Binary file format ────────────────────────────────────────────────────
// Offset  Size  Field
//  0       4    magic "BGMD"
//  4       1    version (= 1)
//  5       4    width  (u32 LE)
//  9       4    height (u32 LE)
// 13       4    frame_count (u32 LE)
// 17       W*H*4  mean[]  (f32 LE, row-major)
// 17+W*H*4  W*H*4  std[]   (f32 LE, row-major)
const MAGIC: &[u8; 4] = b"BGMD";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 17; // magic(4) + ver(1) + width(4) + height(4) + count(4)

// ── Types ─────────────────────────────────────────────────────────────────

pub struct BackgroundModel {
    pub width: u32,
    pub height: u32,
    /// Number of reference frames used to build this model.
    pub frame_count: u32,
    /// Per-pixel mean intensity (0–255 range, f32).
    pub mean: Vec<f32>,
    /// Per-pixel std intensity.
    pub std: Vec<f32>,
    /// Precomputed per-pixel threshold: `max(SIGMA * std, ABS_FLOOR)`.
    /// Not persisted; computed from `std` on construction.
    pub(crate) threshold: Vec<f32>,
}

impl BackgroundModel {
    fn new(width: u32, height: u32, frame_count: u32, mean: Vec<f32>, std: Vec<f32>) -> Self {
        let threshold = std.iter().map(|&s| (SIGMA * s).max(ABS_FLOOR)).collect();
        Self {
            width,
            height,
            frame_count,
            mean,
            std,
            threshold,
        }
    }
}

// ── Construction ──────────────────────────────────────────────────────────

/// Build a background model from a list of JPEG paths.
///
/// Requires at least [`MIN_REF_FRAMES`] frames. All images must share the same
/// dimensions; returns an error if any differ.
pub fn build_model(jpeg_paths: &[PathBuf]) -> Result<BackgroundModel, String> {
    if jpeg_paths.len() < MIN_REF_FRAMES {
        return Err(format!(
            "need at least {MIN_REF_FRAMES} background reference frames, got {}",
            jpeg_paths.len()
        ));
    }

    // Load all images and validate dimensions against the first frame.
    let first = image::open(&jpeg_paths[0])
        .map_err(|e| format!("failed to open {:?}: {e}", jpeg_paths[0]))?;
    let (width, height) = (first.width(), first.height());
    let n_pixels = (width * height) as usize;
    let n = jpeg_paths.len();

    let mut frames: Vec<Vec<f32>> = Vec::with_capacity(n);
    let first_gray: Vec<f32> = first.into_luma8().pixels().map(|p| p[0] as f32).collect();
    frames.push(first_gray);

    for path in &jpeg_paths[1..] {
        let img = image::open(path).map_err(|e| format!("failed to open {path:?}: {e}"))?;
        if img.width() != width || img.height() != height {
            return Err(format!(
                "dimension mismatch in {path:?}: expected {width}x{height}, got {}x{}",
                img.width(),
                img.height()
            ));
        }
        let gray: Vec<f32> = img.into_luma8().pixels().map(|p| p[0] as f32).collect();
        frames.push(gray);
    }

    // Per-pixel mean
    let mut mean = vec![0.0f32; n_pixels];
    for frame in &frames {
        for (i, &v) in frame.iter().enumerate() {
            mean[i] += v;
        }
    }
    for m in &mut mean {
        *m /= n as f32;
    }

    // Per-pixel std (population std)
    let mut std = vec![0.0f32; n_pixels];
    for frame in &frames {
        for (i, &v) in frame.iter().enumerate() {
            let d = v - mean[i];
            std[i] += d * d;
        }
    }
    for s in &mut std {
        *s = (*s / n as f32).sqrt();
    }

    Ok(BackgroundModel::new(width, height, n as u32, mean, std))
}

// ── Scoring ───────────────────────────────────────────────────────────────

/// Score a frame against the background model.
///
/// Returns the percentage (0–100) of pixels that deviate more than
/// `SIGMA * std` (or `ABS_FLOOR`, whichever is larger) from the background
/// mean. Empty frames typically score < 5; frames with pets/people > 30.
pub fn score_frame(model: &BackgroundModel, jpeg_path: &Path) -> Result<f32, String> {
    let img = image::open(jpeg_path).map_err(|e| format!("failed to open {jpeg_path:?}: {e}"))?;
    if img.width() != model.width || img.height() != model.height {
        return Err(format!(
            "dimension mismatch: model is {}x{}, frame is {}x{}",
            model.width,
            model.height,
            img.width(),
            img.height()
        ));
    }

    let gray = img.into_luma8();
    let gray_bytes = gray.as_raw();
    let n_pixels = (model.width * model.height) as usize;
    let mut outliers: usize = 0;

    // Threshold is precomputed in BackgroundModel::new(), so the inner loop is
    // a simple abs-diff + compare — no multiply or max per pixel.
    // Raw slices + branchless count enable NEON auto-vectorization with
    // target-cpu=cortex-a55.
    for ((&pixel, &mean), &threshold) in gray_bytes
        .iter()
        .zip(model.mean.iter())
        .zip(model.threshold.iter())
    {
        let diff = (pixel as f32 - mean).abs();
        outliers += (diff > threshold) as usize;
    }

    Ok(outliers as f32 / n_pixels as f32 * 100.0)
}

// ── Persistence ───────────────────────────────────────────────────────────

pub fn model_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("bg_model.bin")
}

pub fn save_model(model: &BackgroundModel, path: &Path) -> Result<(), String> {
    let n_pixels = (model.width * model.height) as usize;
    let mut data = Vec::with_capacity(HEADER_LEN + n_pixels * 8);

    data.extend_from_slice(MAGIC);
    data.push(VERSION);
    data.extend_from_slice(&model.width.to_le_bytes());
    data.extend_from_slice(&model.height.to_le_bytes());
    data.extend_from_slice(&model.frame_count.to_le_bytes());
    for &v in &model.mean {
        data.extend_from_slice(&v.to_le_bytes());
    }
    for &v in &model.std {
        data.extend_from_slice(&v.to_le_bytes());
    }

    std::fs::write(path, &data).map_err(|e| format!("failed to write model to {path:?}: {e}"))
}

pub fn load_model(path: &Path) -> Result<BackgroundModel, String> {
    let data =
        std::fs::read(path).map_err(|e| format!("failed to read model from {path:?}: {e}"))?;
    if data.len() < HEADER_LEN {
        return Err(format!("model file too short ({} bytes)", data.len()));
    }
    if &data[..4] != MAGIC {
        return Err("invalid model file (wrong magic bytes)".to_string());
    }
    if data[4] != VERSION {
        return Err(format!("unsupported model version {}", data[4]));
    }

    let width = u32::from_le_bytes(data[5..9].try_into().unwrap());
    let height = u32::from_le_bytes(data[9..13].try_into().unwrap());
    let frame_count = u32::from_le_bytes(data[13..17].try_into().unwrap());
    let n_pixels = (width * height) as usize;

    let expected = HEADER_LEN + n_pixels * 8;
    if data.len() < expected {
        return Err(format!(
            "model file truncated: expected {expected} bytes, got {}",
            data.len()
        ));
    }

    let mean_end = HEADER_LEN + n_pixels * 4;
    let mean: Vec<f32> = data[HEADER_LEN..mean_end]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let std: Vec<f32> = data[mean_end..expected]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();

    Ok(BackgroundModel::new(width, height, frame_count, mean, std))
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn too_few_refs_returns_error() {
        let paths: Vec<PathBuf> = vec![];
        assert!(build_model(&paths).is_err());
        let paths: Vec<PathBuf> = vec![PathBuf::from("a.jpg"), PathBuf::from("b.jpg")];
        // build would fail opening files, but we want to test the count guard first
        let err = build_model(&paths).err().expect("expected Err");
        assert!(err.contains("at least 3"), "error was: {err}");
    }

    #[test]
    fn roundtrip_model() {
        let n: usize = 4; // 2x2
        let model = BackgroundModel::new(
            2,
            2,
            5,
            vec![100.0, 110.0, 90.0, 80.0],
            vec![1.0, 2.0, 3.0, 4.0],
        );
        let tmp = std::env::temp_dir().join("test_bg_model.bin");
        save_model(&model, &tmp).unwrap();
        let loaded = load_model(&tmp).unwrap();
        assert_eq!(loaded.width, 2);
        assert_eq!(loaded.height, 2);
        assert_eq!(loaded.frame_count, 5);
        assert_eq!(loaded.mean.len(), n);
        assert_eq!(loaded.std.len(), n);
        for i in 0..n {
            assert!((loaded.mean[i] - model.mean[i]).abs() < 1e-4);
            assert!((loaded.std[i] - model.std[i]).abs() < 1e-4);
        }
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn load_bad_magic_returns_error() {
        let tmp = std::env::temp_dir().join("test_bg_bad.bin");
        std::fs::write(
            &tmp,
            b"XXXX\x01\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x01",
        )
        .unwrap();
        let err = load_model(&tmp).err().expect("expected Err");
        assert!(err.contains("magic"), "error was: {err}");
        let _ = std::fs::remove_file(&tmp);
    }
}
