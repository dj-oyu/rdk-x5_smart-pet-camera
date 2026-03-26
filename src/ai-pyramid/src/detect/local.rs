use crate::db::DetectionInput;
use crate::ingest::filename::parse_comic_filename;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::sync::mpsc;

/// COCO class IDs worth keeping for pet camera context.
const KEEP_CLASSES: &[i32] = &[
    0,  // person
    14, // bird
    15, // cat
    16, // dog
    24, // backpack
    26, // handbag
    28, // suitcase
    39, // bottle
    41, // cup
    43, // knife (cat knocked it off?)
    45, // bowl
    56, // chair
    57, // couch
    59, // bed
    60, // dining table
    62, // tv
    63, // laptop
    66, // keyboard
    67, // remote
    73, // book
    75, // vase
    58, // potted plant
    74, // clock
];

/// COCO class names by ID (80 classes).
const COCO_NAMES: &[&str] = &[
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
];

#[derive(Debug, Clone)]
pub struct LocalDetectorConfig {
    pub wrapper_path: PathBuf,
    pub yolo11s_binary: String,
    pub yolo26l_binary: String,
    pub yolo11s_model: PathBuf,
    pub yolo26l_model: PathBuf,
}

impl Default for LocalDetectorConfig {
    fn default() -> Self {
        Self {
            wrapper_path: PathBuf::from("/usr/local/bin/ax_yolo_run"),
            yolo11s_binary: "ax_yolo11".into(),
            yolo26l_binary: "ax_yolo26".into(),
            yolo11s_model: PathBuf::from("/home/admin-user/models/yolo11/ax650/yolo11s.axmodel"),
            yolo26l_model: PathBuf::from("/home/admin-user/models/yolo26/ax650/yolo26l.axmodel"),
        }
    }
}

pub struct LocalDetector {
    config: LocalDetectorConfig,
}

impl LocalDetector {
    pub fn new(config: LocalDetectorConfig) -> Self {
        Self { config }
    }

    /// Check if binaries and models exist.
    pub fn is_available(&self) -> bool {
        self.config.wrapper_path.exists()
            && self.config.yolo11s_model.exists()
            && self.config.yolo26l_model.exists()
    }

    /// Run dual-model detection on a single JPEG image.
    /// Returns merged detections (highest confidence per bbox region).
    pub async fn detect_image(&self, jpeg_path: &Path) -> Result<Vec<RawLocalDetection>, String> {
        let (r1, r2) = tokio::join!(
            self.run_model(
                &self.config.yolo11s_binary,
                &self.config.yolo11s_model,
                jpeg_path
            ),
            self.run_model(
                &self.config.yolo26l_binary,
                &self.config.yolo26l_model,
                jpeg_path
            ),
        );

        let mut dets = r1.unwrap_or_default();
        dets.extend(r2.unwrap_or_default());

        // Merge: deduplicate by IoU, keep higher confidence
        Ok(merge_detections(dets))
    }

    /// Run detection on all 4 comic panels, mapping coordinates back to comic space.
    pub async fn detect_comic(
        &self,
        photos_dir: &Path,
        filename: &str,
    ) -> Result<Vec<DetectionInput>, String> {
        let jpeg_path = photos_dir.join(filename);
        if !jpeg_path.exists() {
            return Err(format!("file not found: {}", jpeg_path.display()));
        }

        let detected_at = parse_comic_filename(filename)
            .map(|m| m.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_else(|_| chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());

        // Crop panels to temp files, detect, map coords
        const MARGIN: i32 = 12;
        const BORDER: i32 = 2;
        const GAP: i32 = 8;
        const PANEL_W: i32 = 404;
        const PANEL_H: i32 = 228;
        const CELL_W: i32 = PANEL_W + 2 * BORDER;
        const CELL_H: i32 = PANEL_H + 2 * BORDER;

        // ax_yolo26/ax_yolo11 does its own letterbox, so we save raw panels
        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;

        let mut all_inputs = Vec::new();

        for panel in 0..4u32 {
            let col = panel as i32 % 2;
            let row = panel as i32 / 2;
            let x = MARGIN + BORDER + col * (CELL_W + GAP);
            let y = MARGIN + BORDER + row * (CELL_H + GAP);

            let panel_img = img.crop_imm(x as u32, y as u32, PANEL_W as u32, PANEL_H as u32);
            let tmp_path = std::env::temp_dir().join(format!("panel_{panel}.jpg"));
            panel_img
                .save(&tmp_path)
                .map_err(|e| format!("save panel: {e}"))?;

            let dets = self.detect_image(&tmp_path).await?;
            let _ = std::fs::remove_file(&tmp_path);

            let origin_x = x;
            let origin_y = y;

            for d in dets {
                if !KEEP_CLASSES.contains(&d.class_id) {
                    continue;
                }
                // Unify cat/dog as the detected class name
                let class_name = if d.class_id == 16 {
                    "cat".to_string() // dog -> cat (家に犬はいない)
                } else {
                    d.class_name
                };

                all_inputs.push(DetectionInput {
                    panel_index: Some(panel as i32),
                    bbox_x: origin_x + d.bbox_x.max(0),
                    bbox_y: origin_y + d.bbox_y.max(0),
                    bbox_w: d.bbox_w.min(PANEL_W - d.bbox_x.max(0)),
                    bbox_h: d.bbox_h.min(PANEL_H - d.bbox_y.max(0)),
                    yolo_class: Some(class_name),
                    pet_class: None,
                    confidence: Some(d.confidence),
                    detected_at: detected_at.clone(),
                    color_metrics: None,
                    det_level: 2,
                    model: Some("yolo11s+yolo26l-ax650".into()),
                });
            }
        }

        Ok(all_inputs)
    }

    /// Streaming variant: sends each detection via `tx` as soon as it's found,
    /// then returns the final merged list for DB storage.
    pub async fn detect_comic_stream(
        &self,
        photos_dir: &Path,
        filename: &str,
        tx: &mpsc::Sender<DetectionInput>,
    ) -> Result<Vec<DetectionInput>, String> {
        let jpeg_path = photos_dir.join(filename);
        if !jpeg_path.exists() {
            return Err(format!("file not found: {}", jpeg_path.display()));
        }

        let detected_at = parse_comic_filename(filename)
            .map(|m| m.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_else(|_| chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());

        const MARGIN: i32 = 12;
        const BORDER: i32 = 2;
        const GAP: i32 = 8;
        const PANEL_W: i32 = 404;
        const PANEL_H: i32 = 228;
        const CELL_W: i32 = PANEL_W + 2 * BORDER;
        const CELL_H: i32 = PANEL_H + 2 * BORDER;

        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;

        let mut all_inputs = Vec::new();

        for panel in 0..4u32 {
            let col = panel as i32 % 2;
            let row = panel as i32 / 2;
            let x = MARGIN + BORDER + col * (CELL_W + GAP);
            let y = MARGIN + BORDER + row * (CELL_H + GAP);

            let panel_img = img.crop_imm(x as u32, y as u32, PANEL_W as u32, PANEL_H as u32);
            let tmp_path = std::env::temp_dir().join(format!("panel_{panel}.jpg"));
            panel_img
                .save(&tmp_path)
                .map_err(|e| format!("save panel: {e}"))?;

            let dets = self.detect_image(&tmp_path).await?;
            let _ = std::fs::remove_file(&tmp_path);

            for d in dets {
                if !KEEP_CLASSES.contains(&d.class_id) {
                    continue;
                }
                let class_name = if d.class_id == 16 {
                    "cat".to_string()
                } else {
                    d.class_name
                };

                let input = DetectionInput {
                    panel_index: Some(panel as i32),
                    bbox_x: x + d.bbox_x.max(0),
                    bbox_y: y + d.bbox_y.max(0),
                    bbox_w: d.bbox_w.min(PANEL_W - d.bbox_x.max(0)),
                    bbox_h: d.bbox_h.min(PANEL_H - d.bbox_y.max(0)),
                    yolo_class: Some(class_name),
                    pet_class: None,
                    confidence: Some(d.confidence),
                    detected_at: detected_at.clone(),
                    color_metrics: None,
                    det_level: 2,
                    model: Some("yolo11s+yolo26l-ax650".into()),
                };

                // Stream each detection immediately
                let _ = tx.send(input.clone()).await;
                all_inputs.push(input);
            }
        }

        Ok(all_inputs)
    }

    async fn run_model(
        &self,
        binary: &str,
        model: &Path,
        image: &Path,
    ) -> Result<Vec<RawLocalDetection>, String> {
        let output = Command::new("sudo")
            .arg(&self.config.wrapper_path)
            .arg(binary)
            .arg("-m")
            .arg(model)
            .arg("-i")
            .arg(image)
            .output()
            .await
            .map_err(|e| format!("spawn {binary}: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("{binary} failed: {stderr}"));
        }

        parse_ax_output(&String::from_utf8_lossy(&output.stdout))
    }
}

#[derive(Debug, Clone)]
pub struct RawLocalDetection {
    pub class_id: i32,
    pub class_name: String,
    pub confidence: f64,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
}

/// Parse ax_yolo stdout format:
/// `15:  81%, [ 231,  329,  344,  406], cat`
fn parse_ax_output(stdout: &str) -> Result<Vec<RawLocalDetection>, String> {
    let mut dets = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        // Match pattern: "class_id:  conf%, [ x1, y1, x2, y2], class_name"
        if !line.contains('%') || !line.contains('[') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, ':').collect();
        if parts.len() != 2 {
            continue;
        }
        let class_id: i32 = match parts[0].trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let rest = parts[1];
        // Extract confidence
        let conf_end = match rest.find('%') {
            Some(i) => i,
            None => continue,
        };
        let conf: f64 = match rest[..conf_end].trim().parse::<f64>() {
            Ok(v) => v / 100.0,
            Err(_) => continue,
        };
        // Extract bbox [x1, y1, x2, y2]
        let bracket_start = match rest.find('[') {
            Some(i) => i,
            None => continue,
        };
        let bracket_end = match rest.find(']') {
            Some(i) => i,
            None => continue,
        };
        let coords: Vec<i32> = rest[bracket_start + 1..bracket_end]
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if coords.len() != 4 {
            continue;
        }
        let (x1, y1, x2, y2) = (coords[0], coords[1], coords[2], coords[3]);

        let class_name = if (class_id as usize) < COCO_NAMES.len() {
            COCO_NAMES[class_id as usize].to_string()
        } else {
            format!("class_{class_id}")
        };

        dets.push(RawLocalDetection {
            class_id,
            class_name,
            confidence: conf,
            bbox_x: x1,
            bbox_y: y1,
            bbox_w: x2 - x1,
            bbox_h: y2 - y1,
        });
    }
    Ok(dets)
}

/// Merge detections from dual models: deduplicate overlapping bboxes by IoU.
/// When both models agree (IoU > 0.5, same class), boost confidence:
///   boosted = 1 - (1 - conf_a) * (1 - conf_b)
/// Two-pass merge:
/// 1. Same-class IoU > 0.5 → boost confidence (dual-model agreement)
/// 2. Cross-class IoU > 0.3 → same object, keep higher confidence
fn merge_detections(mut dets: Vec<RawLocalDetection>) -> Vec<RawLocalDetection> {
    dets.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());

    // Pass 1: same-class merge with confidence boost
    let mut pass1: Vec<RawLocalDetection> = Vec::new();
    for det in dets {
        if let Some(existing) = pass1
            .iter_mut()
            .find(|m| m.class_id == det.class_id && iou(m, &det) > 0.5)
        {
            let boosted = 1.0 - (1.0 - existing.confidence) * (1.0 - det.confidence);
            existing.confidence = boosted;
        } else {
            pass1.push(det);
        }
    }

    // Pass 2: cross-class proximity merge (same object, different label)
    // Keep highest confidence detection, discard overlapping lower-conf ones
    pass1.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut pass2: Vec<RawLocalDetection> = Vec::new();
    for det in pass1 {
        let dominated = pass2.iter().any(|m| iou(m, &det) > 0.3);
        if !dominated {
            pass2.push(det);
        }
    }
    pass2
}

fn iou(a: &RawLocalDetection, b: &RawLocalDetection) -> f64 {
    let x1 = a.bbox_x.max(b.bbox_x);
    let y1 = a.bbox_y.max(b.bbox_y);
    let x2 = (a.bbox_x + a.bbox_w).min(b.bbox_x + b.bbox_w);
    let y2 = (a.bbox_y + a.bbox_h).min(b.bbox_y + b.bbox_h);
    let inter = (x2 - x1).max(0) as f64 * (y2 - y1).max(0) as f64;
    let area_a = a.bbox_w as f64 * a.bbox_h as f64;
    let area_b = b.bbox_w as f64 * b.bbox_h as f64;
    let union = area_a + area_b - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ax_yolo_output() {
        let stdout = r#"--------------------------------------
model file : /home/admin-user/models/yolo26/ax650/yolo26l.axmodel
image file : /tmp/test_panel.jpg
img_h, img_w : 640 640
--------------------------------------
Engine creating handle is done.
Engine creating context is done.
Engine get io info is done.
Engine alloc io is done.
Engine push input is done.
--------------------------------------
post process cost time:3.22 ms
--------------------------------------
Repeat 1 times, avg time 11.71 ms, max_time 11.71 ms, min_time 11.71 ms
--------------------------------------
detection num: 3
15:  71%, [ 231,  325,  343,  406], cat
45:  50%, [ 177,  396,  226,  435], bowl
60:  38%, [ 357,  268,  639,  499], dining table
--------------------------------------"#;

        let dets = parse_ax_output(stdout).unwrap();
        assert_eq!(dets.len(), 3);
        assert_eq!(dets[0].class_name, "cat");
        assert_eq!(dets[0].class_id, 15);
        assert!((dets[0].confidence - 0.71).abs() < 0.01);
        assert_eq!(dets[0].bbox_x, 231);
        assert_eq!(dets[0].bbox_w, 343 - 231); // x2 - x1
        assert_eq!(dets[1].class_name, "bowl");
        assert_eq!(dets[2].class_name, "dining table");
    }

    #[test]
    fn merge_dedup_same_class() {
        let dets = vec![
            RawLocalDetection {
                class_id: 15,
                class_name: "cat".into(),
                confidence: 0.81,
                bbox_x: 231,
                bbox_y: 329,
                bbox_w: 113,
                bbox_h: 77,
            },
            RawLocalDetection {
                class_id: 15,
                class_name: "cat".into(),
                confidence: 0.71,
                bbox_x: 231,
                bbox_y: 325,
                bbox_w: 112,
                bbox_h: 81,
            },
        ];
        let merged = merge_detections(dets);
        assert_eq!(merged.len(), 1);
        // Boosted: 1 - (1-0.81)*(1-0.71) = 1 - 0.19*0.29 ≈ 0.9449
        assert!((merged[0].confidence - 0.9449).abs() < 0.01);
    }

    #[test]
    fn merge_keeps_different_classes() {
        let dets = vec![
            RawLocalDetection {
                class_id: 15,
                class_name: "cat".into(),
                confidence: 0.81,
                bbox_x: 231,
                bbox_y: 329,
                bbox_w: 113,
                bbox_h: 77,
            },
            RawLocalDetection {
                class_id: 45,
                class_name: "bowl".into(),
                confidence: 0.50,
                bbox_x: 177,
                bbox_y: 396,
                bbox_w: 49,
                bbox_h: 39,
            },
        ];
        let merged = merge_detections(dets);
        assert_eq!(merged.len(), 2);
    }
}
