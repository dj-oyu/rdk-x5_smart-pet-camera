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
#[allow(dead_code)]
const CMD_LOAD: u16 = 1;
const CMD_STREAM: u16 = 4;
#[allow(dead_code)]
const CMD_HELP: u16 = 5;
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
    /// Fast model for aspect ratio probing (e.g. "yolo11s").
    pub fast_model: String,
    /// Accurate model for final detection (e.g. "yolo26l").
    pub accurate_model: String,
}

impl Default for LocalDetectorConfig {
    fn default() -> Self {
        Self {
            daemon_socket: PathBuf::from(
                std::env::var("AX_YOLO_DAEMON_SOCKET")
                    .unwrap_or_else(|_| "/run/ax_yolo_daemon.sock".to_string()),
            ),
            fast_model: std::env::var("YOLO_FAST_MODEL").unwrap_or_default(),
            accurate_model: std::env::var("YOLO_ACCURATE_MODEL").unwrap_or_default(),
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

    /// Hot-swap the daemon's loaded model by name (e.g. "yolo26l").
    pub async fn load_model(&self, name: &str) -> Result<(), String> {
        let payload = name.as_bytes();
        let header = RequestHeader {
            cmd: CMD_LOAD,
            input_type: 0,
            width: 0,
            height: 0,
            payload_size: payload.len() as u32,
            reserved: 0,
        };
        // CMD_LOAD returns 0 detections on success, error on failure.
        let mut stream = tokio::net::UnixStream::connect(&self.config.daemon_socket)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let hdr_bytes = unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, 16) };
        stream
            .write_all(hdr_bytes)
            .await
            .map_err(|e| format!("write header: {e}"))?;
        stream
            .write_all(payload)
            .await
            .map_err(|e| format!("write payload: {e}"))?;
        stream
            .shutdown()
            .await
            .map_err(|e| format!("shutdown: {e}"))?;
        let mut resp_buf = [0u8; 12];
        stream
            .read_exact(&mut resp_buf)
            .await
            .map_err(|e| format!("read response: {e}"))?;
        #[repr(C, packed)]
        struct RespHeader {
            status: u16,
            _det_count: u16,
            _elapsed_ms: f32,
            error_len: u32,
        }
        let resp: RespHeader = unsafe { std::ptr::read_unaligned(resp_buf.as_ptr().cast()) };
        if resp.status != 0 {
            let mut err_buf = vec![0u8; resp.error_len as usize];
            if resp.error_len > 0 {
                let _ = stream.read_exact(&mut err_buf).await;
            }
            return Err(String::from_utf8_lossy(&err_buf).to_string());
        }
        Ok(())
    }

    /// Detect pets in a comic image using per-panel detection with
    /// aspect-ratio correction fallback.
    ///
    /// For each panel:
    /// 1. Run YOLO on the original panel crop
    /// 2. If 0 detections, try padded variants (top/bottom, left/right)
    ///    to compensate for aspect ratio distortion from Go's crop+scale
    /// 3. Pick the variant with the most detections and remap bbox coords
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

        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;
        let all_raw = self.detect_panels_raw(&img).await?;
        let merged = merge_detections(all_raw);
        Ok(raw_dets_to_inputs(
            &merged,
            &detected_at,
            "yolo26l-ax650-panel",
        ))
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

        let img =
            image::open(&jpeg_path).map_err(|e| format!("open {}: {e}", jpeg_path.display()))?;
        let all_raw = self.detect_panels_raw(&img).await?;

        let merged = merge_detections(all_raw);
        let inputs = raw_dets_to_inputs(&merged, &detected_at, "yolo26l-ax650-panel");
        for input in &inputs {
            let _ = tx.send(input.clone()).await;
        }

        Ok(inputs)
    }

    /// 2-model detection pipeline with aspect-ratio correction.
    ///
    /// Phase 1 (fast model, e.g. yolo11s):
    ///   For each panel, detect on original NV12.
    ///   If 0 detections, try shrink_w/shrink_h variants → pick best aspect ratio.
    ///   Record per-panel: best NV12 data + dimensions + scale factors.
    ///
    /// Phase 2 (accurate model, e.g. yolo26l):
    ///   Switch model once, re-detect all panels with the chosen aspect ratio.
    ///   Merge results from both models.
    async fn detect_panels_raw(
        &self,
        img: &image::DynamicImage,
    ) -> Result<Vec<RawLocalDetection>, String> {
        let pw = PANEL_W as u32;
        let ph = PANEL_H as u32;

        // Pre-crop all panels
        let panels: Vec<_> = (0..4u32)
            .map(|i| {
                let (ox, oy) = panel_origin(i);
                let rgb = img.crop_imm(ox as u32, oy as u32, pw, ph).to_rgb8();
                (ox, oy, rgb)
            })
            .collect();

        // Per-panel state after phase 1
        struct PanelResult {
            nv12: Vec<u8>,
            width: u16,
            height: u16,
            scale_x: f64,
            scale_y: f64,
            fast_dets: Vec<RawLocalDetection>,
        }

        let has_fast = !self.config.fast_model.is_empty();
        let has_accurate = !self.config.accurate_model.is_empty();

        if !has_fast && !has_accurate {
            tracing::warn!("No YOLO models configured (YOLO_FAST_MODEL / YOLO_ACCURATE_MODEL)");
            return Ok(Vec::new());
        }

        // --- Phase 1: fast model for aspect ratio probing ---
        let mut panel_results = Vec::new();
        if has_fast {
            tracing::info!("Phase 1: loading fast model {}", self.config.fast_model);
            self.load_model(&self.config.fast_model).await?;

            for (_, _, rgb) in &panels {
                let nv12_orig = rgb_to_nv12(rgb, pw, ph);
                let dets = self.detect_nv12(&nv12_orig, pw as u16, ph as u16).await?;

                if !dets.is_empty() {
                    panel_results.push(PanelResult {
                        nv12: nv12_orig,
                        width: pw as u16,
                        height: ph as u16,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        fast_dets: dets,
                    });
                    continue;
                }

                // Try aspect ratio variants with fast model
                let (best_nv12, best_w, best_h, scale_x, scale_y, variant_dets) =
                    self.probe_aspect_ratio(rgb, pw, ph).await?;
                panel_results.push(PanelResult {
                    nv12: best_nv12,
                    width: best_w,
                    height: best_h,
                    scale_x,
                    scale_y,
                    fast_dets: variant_dets,
                });
            }
        } else {
            // No fast model — prepare original panels for accurate-only pass
            for (_, _, rgb) in &panels {
                let nv12_orig = rgb_to_nv12(rgb, pw, ph);
                panel_results.push(PanelResult {
                    nv12: nv12_orig,
                    width: pw as u16,
                    height: ph as u16,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    fast_dets: Vec::new(),
                });
            }
        }

        // --- Phase 2: accurate model on chosen aspect ratios ---
        let mut all = Vec::new();
        if has_accurate {
            tracing::info!(
                "Phase 2: loading accurate model {}",
                self.config.accurate_model
            );
            self.load_model(&self.config.accurate_model).await?;

            for (i, pr) in panel_results.iter().enumerate() {
                let (ox, oy) = (panels[i].0, panels[i].1);

                let accurate_dets = self.detect_nv12(&pr.nv12, pr.width, pr.height).await?;

                let mut combined = pr.fast_dets.clone();
                combined.extend(accurate_dets);
                let merged = merge_detections(combined);

                for d in merged {
                    if pr.scale_x == 1.0 && pr.scale_y == 1.0 {
                        all.push(map_to_comic(d, ox, oy));
                    } else {
                        all.push(map_to_comic_scaled(d, ox, oy, pr.scale_x, pr.scale_y));
                    }
                }
            }
        } else {
            // No accurate model — use fast model results only
            for (i, pr) in panel_results.iter().enumerate() {
                let (ox, oy) = (panels[i].0, panels[i].1);
                for d in &pr.fast_dets {
                    if pr.scale_x == 1.0 && pr.scale_y == 1.0 {
                        all.push(map_to_comic(d.clone(), ox, oy));
                    } else {
                        all.push(map_to_comic_scaled(
                            d.clone(),
                            ox,
                            oy,
                            pr.scale_x,
                            pr.scale_y,
                        ));
                    }
                }
            }
        }

        Ok(all)
    }

    /// Probe aspect ratio variants with the currently loaded (fast) model.
    /// Returns (nv12, w, h, scale_x, scale_y, detections) for the best variant.
    /// If no variant finds anything, returns the original panel NV12.
    async fn probe_aspect_ratio(
        &self,
        panel_rgb: &image::RgbImage,
        pw: u32,
        ph: u32,
    ) -> Result<(Vec<u8>, u16, u16, f64, f64, Vec<RawLocalDetection>), String> {
        // Variant A: shrink width 75%
        let new_w = (pw * 3 / 4) & !1;
        let shrunk_w =
            image::imageops::resize(panel_rgb, new_w, ph, image::imageops::FilterType::Triangle);
        let nv12_w = rgb_to_nv12(&shrunk_w, new_w, ph);
        let dets_w = self.detect_nv12(&nv12_w, new_w as u16, ph as u16).await?;

        // Variant B: shrink height 75%
        let new_h = (ph * 3 / 4) & !1;
        let shrunk_h =
            image::imageops::resize(panel_rgb, pw, new_h, image::imageops::FilterType::Triangle);
        let nv12_h = rgb_to_nv12(&shrunk_h, pw, new_h);
        let dets_h = self.detect_nv12(&nv12_h, pw as u16, new_h as u16).await?;

        if dets_w.len() >= dets_h.len() && !dets_w.is_empty() {
            Ok((
                nv12_w,
                new_w as u16,
                ph as u16,
                pw as f64 / new_w as f64,
                1.0,
                dets_w,
            ))
        } else if !dets_h.is_empty() {
            Ok((
                nv12_h,
                pw as u16,
                new_h as u16,
                1.0,
                ph as f64 / new_h as f64,
                dets_h,
            ))
        } else {
            // Neither variant found anything — fall back to original
            let nv12_orig = rgb_to_nv12(panel_rgb, pw, ph);
            Ok((nv12_orig, pw as u16, ph as u16, 1.0, 1.0, Vec::new()))
        }
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

/// Map a detection from panel-local coords back to comic space (no scaling).
fn map_to_comic(d: RawLocalDetection, ox: i32, oy: i32) -> RawLocalDetection {
    RawLocalDetection {
        class_id: d.class_id,
        class_name: d.class_name,
        confidence: d.confidence,
        bbox_x: ox + d.bbox_x.max(0),
        bbox_y: oy + d.bbox_y.max(0),
        bbox_w: d.bbox_w.min(PANEL_W - d.bbox_x.max(0)),
        bbox_h: d.bbox_h.min(PANEL_H - d.bbox_y.max(0)),
    }
}

/// Map a detection from a shrunk variant back to comic space.
/// bbox coords are in shrunk image space — scale back to original panel size.
fn map_to_comic_scaled(
    d: RawLocalDetection,
    ox: i32,
    oy: i32,
    scale_x: f64,
    scale_y: f64,
) -> RawLocalDetection {
    let local_x = (d.bbox_x as f64 * scale_x) as i32;
    let local_y = (d.bbox_y as f64 * scale_y) as i32;
    let local_w = (d.bbox_w as f64 * scale_x) as i32;
    let local_h = (d.bbox_h as f64 * scale_y) as i32;
    RawLocalDetection {
        class_id: d.class_id,
        class_name: d.class_name,
        confidence: d.confidence,
        bbox_x: ox + local_x.max(0),
        bbox_y: oy + local_y.max(0),
        bbox_w: local_w.min(PANEL_W - local_x.max(0)),
        bbox_h: local_h.min(PANEL_H - local_y.max(0)),
    }
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

/// Convert RGB image to NV12 (Y plane + interleaved UV plane).
///
/// Uses raw byte slice access (`as_raw`) instead of `get_pixel` to enable
/// LLVM auto-vectorization when compiled with `target-cpu=cortex-a55`.
fn rgb_to_nv12(rgb: &image::RgbImage, w: u32, h: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let mut nv12 = vec![0u8; w * h * 3 / 2];
    let (y_plane, uv_plane) = nv12.split_at_mut(w * h);
    let src = rgb.as_raw(); // flat RGB: [R0,G0,B0, R1,G1,B1, ...]

    // Y plane
    for i in 0..w * h {
        let r = src[i * 3] as i32;
        let g = src[i * 3 + 1] as i32;
        let b = src[i * 3 + 2] as i32;
        y_plane[i] = ((66 * r + 129 * g + 25 * b + 128) / 256 + 16).clamp(0, 255) as u8;
    }

    // UV plane (subsampled 2×2, top-left pixel of each 2×2 block)
    for row in (0..h).step_by(2) {
        for col in (0..w).step_by(2) {
            let src_idx = (row * w + col) * 3;
            let r = src[src_idx] as i32;
            let g = src[src_idx + 1] as i32;
            let b = src[src_idx + 2] as i32;
            let uv_idx = row / 2 * w + col;
            uv_plane[uv_idx] =
                ((-38 * r - 74 * g + 112 * b + 128) / 256 + 128).clamp(0, 255) as u8;
            uv_plane[uv_idx + 1] =
                ((112 * r - 94 * g - 18 * b + 128) / 256 + 128).clamp(0, 255) as u8;
        }
    }

    nv12
}

/// Merge overlapping detections from multiple passes.
/// Same-class overlapping boxes (IoU > 0.5) get confidence-boosted.
/// Cross-class overlapping boxes (IoU > 0.3) are deduplicated by confidence.
fn merge_detections(mut dets: Vec<RawLocalDetection>) -> Vec<RawLocalDetection> {
    dets.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    // Pass 1: merge same-class overlaps with confidence boosting
    let mut merged: Vec<RawLocalDetection> = Vec::new();
    for det in dets {
        if let Some(existing) = merged
            .iter_mut()
            .find(|m| m.class_id == det.class_id && iou_raw(m, &det) > 0.5)
        {
            let boosted = 1.0 - (1.0 - existing.confidence) * (1.0 - det.confidence);
            existing.confidence = boosted;
        } else {
            merged.push(det);
        }
    }
    // Pass 2: remove lower-confidence boxes dominated by higher-confidence ones
    merged.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut result: Vec<RawLocalDetection> = Vec::new();
    for det in merged {
        let dominated = result.iter().any(|m| iou_raw(m, &det) > 0.3);
        if !dominated {
            result.push(det);
        }
    }
    result
}

fn iou_raw(a: &RawLocalDetection, b: &RawLocalDetection) -> f64 {
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
}
