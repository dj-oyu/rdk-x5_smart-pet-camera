use crate::db::DetectionInput;
use crate::ingest::filename::parse_comic_filename;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Wire protocol structs (must match ax_yolo_daemon.cpp exactly)
// ---------------------------------------------------------------------------

const CMD_DETECT: u16 = 0;
const CMD_STREAM: u16 = 4;
const INPUT_JPEG_PATH: u16 = 0;
const INPUT_NV12_RAW: u16 = 1;

#[repr(C, packed)]
struct RequestHeader {
    cmd: u16,
    input_type: u16,
    width: u16,
    height: u16,
    payload_size: u32,
    reserved: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
struct ResponseHeader {
    status: u16,
    det_count: u16,
    elapsed_ms: f32,
    error_len: u32,
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
struct WireDetection {
    x1: i16,
    y1: i16,
    x2: i16,
    y2: i16,
    class_id: u16,
    confidence: u16, // prob × 10000
}

// COCO class names for class_id → name mapping.
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

#[derive(Debug, Clone)]
pub struct LocalDetectorConfig {
    /// Unix socket path for ax_yolo_daemon.
    pub daemon_socket: PathBuf,
}

impl Default for LocalDetectorConfig {
    fn default() -> Self {
        Self {
            daemon_socket: PathBuf::from(
                std::env::var("AX_YOLO_DAEMON_SOCKET")
                    .unwrap_or_else(|_| "/run/ax_yolo_daemon.sock".to_string()),
            ),
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

    /// Check if the daemon socket exists.
    pub fn is_available(&self) -> bool {
        self.config.daemon_socket.exists()
    }

    /// Get the daemon socket path.
    pub fn socket_path(&self) -> &std::path::Path {
        &self.config.daemon_socket
    }

    /// Run YOLO26l detection on a single JPEG image via daemon socket.
    pub async fn detect_image(&self, jpeg_path: &Path) -> Result<Vec<RawLocalDetection>, String> {
        let path_bytes = jpeg_path.to_string_lossy().into_owned().into_bytes();
        let header = RequestHeader {
            cmd: CMD_DETECT,
            input_type: INPUT_JPEG_PATH,
            width: 0,
            height: 0,
            payload_size: path_bytes.len() as u32,
            reserved: 0,
        };
        self.send_request(&header, &path_bytes).await
    }

    /// Run YOLO26l detection on a raw NV12 frame via daemon socket.
    pub async fn detect_nv12(
        &self,
        nv12: &[u8],
        width: u16,
        height: u16,
    ) -> Result<Vec<RawLocalDetection>, String> {
        let header = RequestHeader {
            cmd: CMD_DETECT,
            input_type: INPUT_NV12_RAW,
            width,
            height,
            payload_size: nv12.len() as u32,
            reserved: 0,
        };
        self.send_request(&header, nv12).await
    }

    /// Detect pets in a comic image using raw-first strategy:
    /// 1. Run YOLO on the full 848×496 comic (1 inference)
    /// 2. Map each bbox to its panel_index
    /// 3. If zero pet detections, fallback to per-panel detection (4 inferences)
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

        // Pass 1: detect on the full comic image
        let raw_dets = self.detect_image(&jpeg_path).await?;
        let inputs = raw_dets_to_inputs(&raw_dets, &detected_at, "yolo26l-ax650-raw");

        // If we found at least one pet, return raw results
        if inputs.iter().any(|d| is_pet_class(d.yolo_class.as_deref())) {
            return Ok(inputs);
        }

        // Pass 2: fallback to per-panel detection
        tracing::debug!("Raw-comic found no pets for {filename}, falling back to panel split");
        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;
        let mut all_inputs = inputs; // keep non-pet detections from raw pass
        all_inputs.extend(
            self.detect_panels(&img, &detected_at, "yolo26l-ax650-panel")
                .await?,
        );

        Ok(all_inputs)
    }

    /// Streaming variant: sends each detection via `tx` as soon as it's found.
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

        // Pass 1: raw comic
        let raw_dets = self.detect_image(&jpeg_path).await?;
        let inputs = raw_dets_to_inputs(&raw_dets, &detected_at, "yolo26l-ax650-raw");
        for input in &inputs {
            let _ = tx.send(input.clone()).await;
        }

        if inputs.iter().any(|d| is_pet_class(d.yolo_class.as_deref())) {
            return Ok(inputs);
        }

        // Pass 2: panel fallback
        tracing::debug!("Raw-comic found no pets for {filename}, falling back to panel split");
        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;
        let panel_inputs = self
            .detect_panels(&img, &detected_at, "yolo26l-ax650-panel")
            .await?;
        for input in &panel_inputs {
            let _ = tx.send(input.clone()).await;
        }

        let mut all = inputs;
        all.extend(panel_inputs);
        Ok(all)
    }

    /// Detect on each of the 4 comic panels individually.
    async fn detect_panels(
        &self,
        img: &image::DynamicImage,
        detected_at: &str,
        model_tag: &str,
    ) -> Result<Vec<DetectionInput>, String> {
        let mut all_inputs = Vec::new();

        for panel in 0..4u32 {
            let (x, y) = panel_origin(panel);

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
                let class_name = normalize_class(d.class_id, d.class_name);

                all_inputs.push(DetectionInput {
                    panel_index: Some(panel as i32),
                    bbox_x: x + d.bbox_x.max(0),
                    bbox_y: y + d.bbox_y.max(0),
                    bbox_w: d.bbox_w.min(PANEL_W - d.bbox_x.max(0)),
                    bbox_h: d.bbox_h.min(PANEL_H - d.bbox_y.max(0)),
                    yolo_class: Some(class_name),
                    pet_class: None,
                    confidence: Some(d.confidence),
                    detected_at: detected_at.to_string(),
                    color_metrics: None,
                    det_level: 2,
                    model: Some(model_tag.into()),
                });
            }
        }

        Ok(all_inputs)
    }

    /// Send a binary request and read binary response.
    async fn send_request(
        &self,
        header: &RequestHeader,
        payload: &[u8],
    ) -> Result<Vec<RawLocalDetection>, String> {
        let mut stream = UnixStream::connect(&self.config.daemon_socket)
            .await
            .map_err(|e| format!("connect {}: {e}", self.config.daemon_socket.display()))?;

        // Send header + payload.
        let hdr_bytes = unsafe { std::slice::from_raw_parts(header as *const _ as *const u8, 16) };
        stream
            .write_all(hdr_bytes)
            .await
            .map_err(|e| format!("write header: {e}"))?;
        if !payload.is_empty() {
            stream
                .write_all(payload)
                .await
                .map_err(|e| format!("write payload: {e}"))?;
        }
        stream
            .shutdown()
            .await
            .map_err(|e| format!("shutdown: {e}"))?;

        // Read response header (12 bytes).
        let mut resp_buf = [0u8; 12];
        stream
            .read_exact(&mut resp_buf)
            .await
            .map_err(|e| format!("read response header: {e}"))?;
        let resp: ResponseHeader = unsafe { std::ptr::read_unaligned(resp_buf.as_ptr().cast()) };

        if resp.status != 0 {
            // Read error string.
            let mut err_buf = vec![0u8; resp.error_len as usize];
            if resp.error_len > 0 {
                stream
                    .read_exact(&mut err_buf)
                    .await
                    .map_err(|e| format!("read error: {e}"))?;
            }
            let msg = String::from_utf8_lossy(&err_buf).to_string();
            return Err(msg);
        }

        // Read detections (12 bytes each).
        let count = resp.det_count as usize;
        let mut results = Vec::with_capacity(count);
        for _ in 0..count {
            let mut det_buf = [0u8; 12];
            stream
                .read_exact(&mut det_buf)
                .await
                .map_err(|e| format!("read detection: {e}"))?;
            let wd: WireDetection = unsafe { std::ptr::read_unaligned(det_buf.as_ptr().cast()) };
            let class_id = wd.class_id as i32;
            let class_name = COCO_NAMES
                .get(class_id as usize)
                .unwrap_or(&"unknown")
                .to_string();
            results.push(RawLocalDetection {
                class_id,
                class_name,
                confidence: wd.confidence as f64 / 10000.0,
                bbox_x: wd.x1 as i32,
                bbox_y: wd.y1 as i32,
                bbox_w: (wd.x2 - wd.x1) as i32,
                bbox_h: (wd.y2 - wd.y1) as i32,
            });
        }
        Ok(results)
    }
}

/// Build a CMD_STREAM request header + host payload as bytes.
pub fn stream_request_header(host: &[u8]) -> Vec<u8> {
    let hdr = RequestHeader {
        cmd: CMD_STREAM,
        input_type: 0,
        width: 0,
        height: 0,
        payload_size: host.len() as u32,
        reserved: 0,
    };
    let hdr_bytes = unsafe { std::slice::from_raw_parts(&hdr as *const _ as *const u8, 16) };
    let mut buf = Vec::with_capacity(16 + host.len());
    buf.extend_from_slice(hdr_bytes);
    buf.extend_from_slice(host);
    buf
}

/// Get COCO class name by ID.
pub fn coco_name(class_id: u16) -> String {
    COCO_NAMES
        .get(class_id as usize)
        .unwrap_or(&"unknown")
        .to_string()
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

// Comic layout constants (must match server::crop_panel)
const MARGIN: i32 = 12;
const BORDER: i32 = 2;
const GAP: i32 = 8;
const PANEL_W: i32 = 404;
const PANEL_H: i32 = 228;
const CELL_W: i32 = PANEL_W + 2 * BORDER;
const CELL_H: i32 = PANEL_H + 2 * BORDER;

/// Get the top-left origin (x, y) of a panel in comic coordinates.
fn panel_origin(panel: u32) -> (i32, i32) {
    let col = panel as i32 % 2;
    let row = panel as i32 / 2;
    let x = MARGIN + BORDER + col * (CELL_W + GAP);
    let y = MARGIN + BORDER + row * (CELL_H + GAP);
    (x, y)
}

/// Determine which panel a bbox center falls in (0-3), or None if in border/gap.
fn bbox_to_panel(bbox_x: i32, bbox_y: i32, bbox_w: i32, bbox_h: i32) -> Option<i32> {
    let cx = bbox_x + bbox_w / 2;
    let cy = bbox_y + bbox_h / 2;
    for panel in 0..4u32 {
        let (px, py) = panel_origin(panel);
        if cx >= px && cx < px + PANEL_W && cy >= py && cy < py + PANEL_H {
            return Some(panel as i32);
        }
    }
    None
}

fn is_pet_class(class: Option<&str>) -> bool {
    matches!(class, Some("cat" | "dog"))
}

fn normalize_class(class_id: i32, class_name: String) -> String {
    if class_id == 16 {
        "cat".to_string() // dog -> cat (家に犬はいない)
    } else {
        class_name
    }
}

/// Convert raw detections to DetectionInputs, mapping bbox to panel_index.
fn raw_dets_to_inputs(
    dets: &[RawLocalDetection],
    detected_at: &str,
    model_tag: &str,
) -> Vec<DetectionInput> {
    dets.iter()
        .filter(|d| KEEP_CLASSES.contains(&d.class_id))
        .map(|d| {
            let panel_index = bbox_to_panel(d.bbox_x, d.bbox_y, d.bbox_w, d.bbox_h);
            let class_name = normalize_class(d.class_id, d.class_name.clone());
            DetectionInput {
                panel_index,
                bbox_x: d.bbox_x,
                bbox_y: d.bbox_y,
                bbox_w: d.bbox_w,
                bbox_h: d.bbox_h,
                yolo_class: Some(class_name),
                pet_class: None,
                confidence: Some(d.confidence),
                detected_at: detected_at.to_string(),
                color_metrics: None,
                det_level: 2,
                model: Some(model_tag.into()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merge_detections(mut dets: Vec<RawLocalDetection>) -> Vec<RawLocalDetection> {
        dets.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
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

    #[test]
    fn wire_detection_round_trip() {
        let wd = WireDetection {
            x1: 231,
            y1: 325,
            x2: 343,
            y2: 406,
            class_id: 15,
            confidence: 7100, // 0.71 × 10000
        };
        let det = RawLocalDetection {
            class_id: wd.class_id as i32,
            class_name: COCO_NAMES[wd.class_id as usize].to_string(),
            confidence: wd.confidence as f64 / 10000.0,
            bbox_x: wd.x1 as i32,
            bbox_y: wd.y1 as i32,
            bbox_w: (wd.x2 - wd.x1) as i32,
            bbox_h: (wd.y2 - wd.y1) as i32,
        };
        assert_eq!(det.class_name, "cat");
        assert_eq!(det.class_id, 15);
        assert!((det.confidence - 0.71).abs() < 0.01);
        assert_eq!(det.bbox_x, 231);
        assert_eq!(det.bbox_w, 343 - 231);
    }

    #[test]
    fn wire_struct_sizes() {
        assert_eq!(std::mem::size_of::<RequestHeader>(), 16);
        assert_eq!(std::mem::size_of::<ResponseHeader>(), 12);
        assert_eq!(std::mem::size_of::<WireDetection>(), 12);
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

    #[test]
    fn bbox_to_panel_mapping() {
        // Panel origins: (14,14), (430,14), (14,254), (430,254)
        // Panel 0: center around (216, 128)
        assert_eq!(bbox_to_panel(100, 50, 100, 80), Some(0));
        // Panel 1: top-right
        assert_eq!(bbox_to_panel(500, 50, 100, 80), Some(1));
        // Panel 2: bottom-left
        assert_eq!(bbox_to_panel(100, 300, 100, 80), Some(2));
        // Panel 3: bottom-right
        assert_eq!(bbox_to_panel(500, 300, 100, 80), Some(3));
        // In gap between panels
        assert_eq!(bbox_to_panel(416, 50, 8, 80), None);
    }

    #[test]
    fn raw_dets_to_inputs_maps_panels() {
        let dets = vec![
            // Cat in panel 0 area
            RawLocalDetection {
                class_id: 15,
                class_name: "cat".into(),
                confidence: 0.90,
                bbox_x: 100,
                bbox_y: 50,
                bbox_w: 100,
                bbox_h: 80,
            },
            // Dog in panel 3 area → should become "cat"
            RawLocalDetection {
                class_id: 16,
                class_name: "dog".into(),
                confidence: 0.42,
                bbox_x: 500,
                bbox_y: 300,
                bbox_w: 100,
                bbox_h: 80,
            },
            // Chair (class 56) — kept but not a pet
            RawLocalDetection {
                class_id: 56,
                class_name: "chair".into(),
                confidence: 0.30,
                bbox_x: 500,
                bbox_y: 50,
                bbox_w: 50,
                bbox_h: 50,
            },
            // Bicycle (class 1) — not in KEEP_CLASSES, filtered out
            RawLocalDetection {
                class_id: 1,
                class_name: "bicycle".into(),
                confidence: 0.80,
                bbox_x: 100,
                bbox_y: 300,
                bbox_w: 50,
                bbox_h: 50,
            },
        ];
        let inputs = raw_dets_to_inputs(&dets, "2026-03-30T01:00:00", "yolo26l-ax650-raw");
        assert_eq!(inputs.len(), 3); // bicycle filtered
        assert_eq!(inputs[0].panel_index, Some(0));
        assert_eq!(inputs[0].yolo_class.as_deref(), Some("cat"));
        assert_eq!(inputs[1].panel_index, Some(3));
        assert_eq!(inputs[1].yolo_class.as_deref(), Some("cat")); // dog→cat
        assert_eq!(inputs[2].panel_index, Some(1));
        assert_eq!(inputs[2].yolo_class.as_deref(), Some("chair"));
    }

    #[test]
    fn is_pet_class_checks() {
        assert!(is_pet_class(Some("cat")));
        assert!(is_pet_class(Some("dog")));
        assert!(!is_pet_class(Some("chair")));
        assert!(!is_pet_class(None));
    }
}
