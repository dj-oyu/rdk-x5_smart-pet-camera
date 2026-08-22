use super::client::DaemonClient;
use super::image_conversion::rgb_to_nv12;
use super::wire::RawLocalDetection;
use crate::db::DetectionInput;

const KEEP_CLASSES: &[i32] = &[
    0, 14, 15, 16, 24, 26, 28, 39, 41, 43, 45, 56, 57, 59, 60, 62, 63, 66, 67, 73, 75, 58,
    74,
];

const MARGIN: i32 = 12;
const BORDER: i32 = 2;
const GAP: i32 = 8;
pub(super) const PANEL_W: i32 = 404;
pub(super) const PANEL_H: i32 = 228;
const CELL_W: i32 = PANEL_W + 2 * BORDER;
const CELL_H: i32 = PANEL_H + 2 * BORDER;

struct PanelResult {
    nv12: Vec<u8>,
    width: u16,
    height: u16,
    scale_x: f64,
    scale_y: f64,
    fast_detections: Vec<RawLocalDetection>,
}

pub(super) async fn detect_panels_raw(
    client: &DaemonClient,
    fast_model: &str,
    accurate_model: &str,
    image: &image::DynamicImage,
) -> Result<Vec<RawLocalDetection>, String> {
    let panel_width = PANEL_W as u32;
    let panel_height = PANEL_H as u32;
    let panels: Vec<_> = (0..4u32)
        .map(|index| {
            let (origin_x, origin_y) = panel_origin(index);
            let rgb = image
                .crop_imm(
                    origin_x as u32,
                    origin_y as u32,
                    panel_width,
                    panel_height,
                )
                .to_rgb8();
            (origin_x, origin_y, rgb)
        })
        .collect();

    let has_fast_model = !fast_model.is_empty();
    let has_accurate_model = !accurate_model.is_empty();
    if !has_fast_model && !has_accurate_model {
        tracing::warn!("No YOLO models configured (YOLO_FAST_MODEL / YOLO_ACCURATE_MODEL)");
        return Ok(Vec::new());
    }

    let mut panel_results = Vec::new();
    if has_fast_model {
        tracing::info!("Phase 1: loading fast model {fast_model}");
        client.load_model(fast_model).await?;
        for (_, _, rgb) in &panels {
            let original = rgb_to_nv12(rgb, panel_width, panel_height);
            let detections = client
                .detect_nv12(&original, panel_width as u16, panel_height as u16)
                .await?;
            if !detections.is_empty() {
                panel_results.push(PanelResult {
                    nv12: original,
                    width: panel_width as u16,
                    height: panel_height as u16,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    fast_detections: detections,
                });
                continue;
            }

            let (nv12, width, height, scale_x, scale_y, fast_detections) =
                probe_aspect_ratio(client, rgb, panel_width, panel_height).await?;
            panel_results.push(PanelResult {
                nv12,
                width,
                height,
                scale_x,
                scale_y,
                fast_detections,
            });
        }
    } else {
        for (_, _, rgb) in &panels {
            panel_results.push(PanelResult {
                nv12: rgb_to_nv12(rgb, panel_width, panel_height),
                width: panel_width as u16,
                height: panel_height as u16,
                scale_x: 1.0,
                scale_y: 1.0,
                fast_detections: Vec::new(),
            });
        }
    }

    let mut all = Vec::new();
    if has_accurate_model {
        tracing::info!("Phase 2: loading accurate model {accurate_model}");
        client.load_model(accurate_model).await?;
        for (index, panel) in panel_results.iter().enumerate() {
            let (origin_x, origin_y) = (panels[index].0, panels[index].1);
            let accurate_detections = client
                .detect_nv12(&panel.nv12, panel.width, panel.height)
                .await?;
            let mut combined = panel.fast_detections.clone();
            combined.extend(accurate_detections);
            for detection in merge_detections(combined) {
                all.push(map_panel_detection(detection, origin_x, origin_y, panel));
            }
        }
    } else {
        for (index, panel) in panel_results.iter().enumerate() {
            let (origin_x, origin_y) = (panels[index].0, panels[index].1);
            for detection in &panel.fast_detections {
                all.push(map_panel_detection(
                    detection.clone(),
                    origin_x,
                    origin_y,
                    panel,
                ));
            }
        }
    }
    Ok(all)
}

async fn probe_aspect_ratio(
    client: &DaemonClient,
    panel_rgb: &image::RgbImage,
    panel_width: u32,
    panel_height: u32,
) -> Result<(Vec<u8>, u16, u16, f64, f64, Vec<RawLocalDetection>), String> {
    let new_width = (panel_width * 3 / 4) & !1;
    let shrunk_width = image::imageops::resize(
        panel_rgb,
        new_width,
        panel_height,
        image::imageops::FilterType::Triangle,
    );
    let nv12_width = rgb_to_nv12(&shrunk_width, new_width, panel_height);
    let width_detections = client
        .detect_nv12(&nv12_width, new_width as u16, panel_height as u16)
        .await?;

    let new_height = (panel_height * 3 / 4) & !1;
    let shrunk_height = image::imageops::resize(
        panel_rgb,
        panel_width,
        new_height,
        image::imageops::FilterType::Triangle,
    );
    let nv12_height = rgb_to_nv12(&shrunk_height, panel_width, new_height);
    let height_detections = client
        .detect_nv12(&nv12_height, panel_width as u16, new_height as u16)
        .await?;

    if width_detections.len() >= height_detections.len() && !width_detections.is_empty() {
        Ok((
            nv12_width,
            new_width as u16,
            panel_height as u16,
            panel_width as f64 / new_width as f64,
            1.0,
            width_detections,
        ))
    } else if !height_detections.is_empty() {
        Ok((
            nv12_height,
            panel_width as u16,
            new_height as u16,
            1.0,
            panel_height as f64 / new_height as f64,
            height_detections,
        ))
    } else {
        Ok((
            rgb_to_nv12(panel_rgb, panel_width, panel_height),
            panel_width as u16,
            panel_height as u16,
            1.0,
            1.0,
            Vec::new(),
        ))
    }
}

fn map_panel_detection(
    detection: RawLocalDetection,
    origin_x: i32,
    origin_y: i32,
    panel: &PanelResult,
) -> RawLocalDetection {
    if panel.scale_x == 1.0 && panel.scale_y == 1.0 {
        map_to_comic(detection, origin_x, origin_y)
    } else {
        map_to_comic_scaled(
            detection,
            origin_x,
            origin_y,
            panel.scale_x,
            panel.scale_y,
        )
    }
}

pub(super) fn raw_dets_to_inputs(
    detections: &[RawLocalDetection],
    detected_at: &str,
    model_tag: &str,
) -> Vec<DetectionInput> {
    detections
        .iter()
        .filter(|detection| KEEP_CLASSES.contains(&detection.class_id))
        .map(|detection| DetectionInput {
            panel_index: bbox_to_panel(
                detection.bbox_x,
                detection.bbox_y,
                detection.bbox_w,
                detection.bbox_h,
            ),
            bbox_x: detection.bbox_x,
            bbox_y: detection.bbox_y,
            bbox_w: detection.bbox_w,
            bbox_h: detection.bbox_h,
            yolo_class: Some(normalize_class(
                detection.class_id,
                detection.class_name.clone(),
            )),
            pet_class: None,
            confidence: Some(detection.confidence),
            detected_at: detected_at.to_string(),
            color_metrics: None,
            det_level: 2,
            model: Some(model_tag.into()),
        })
        .collect()
}

pub(super) fn merge_detections(
    mut detections: Vec<RawLocalDetection>,
) -> Vec<RawLocalDetection> {
    detections.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut merged: Vec<RawLocalDetection> = Vec::new();
    for detection in detections {
        if let Some(existing) = merged.iter_mut().find(|candidate| {
            candidate.class_id == detection.class_id && iou_raw(candidate, &detection) > 0.5
        }) {
            existing.confidence =
                1.0 - (1.0 - existing.confidence) * (1.0 - detection.confidence);
        } else {
            merged.push(detection);
        }
    }

    merged.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut result = Vec::new();
    for detection in merged {
        if !result
            .iter()
            .any(|candidate| iou_raw(candidate, &detection) > 0.3)
        {
            result.push(detection);
        }
    }
    result
}

pub(super) fn panel_origin(panel: u32) -> (i32, i32) {
    let column = panel as i32 % 2;
    let row = panel as i32 / 2;
    (
        MARGIN + BORDER + column * (CELL_W + GAP),
        MARGIN + BORDER + row * (CELL_H + GAP),
    )
}

pub(super) fn bbox_to_panel(x: i32, y: i32, width: i32, height: i32) -> Option<i32> {
    let center_x = x + width / 2;
    let center_y = y + height / 2;
    for panel in 0..4u32 {
        let (panel_x, panel_y) = panel_origin(panel);
        if center_x >= panel_x
            && center_x < panel_x + PANEL_W
            && center_y >= panel_y
            && center_y < panel_y + PANEL_H
        {
            return Some(panel as i32);
        }
    }
    None
}

fn map_to_comic(
    detection: RawLocalDetection,
    origin_x: i32,
    origin_y: i32,
) -> RawLocalDetection {
    RawLocalDetection {
        class_id: detection.class_id,
        class_name: detection.class_name,
        confidence: detection.confidence,
        bbox_x: origin_x + detection.bbox_x.max(0),
        bbox_y: origin_y + detection.bbox_y.max(0),
        bbox_w: detection
            .bbox_w
            .min(PANEL_W - detection.bbox_x.max(0)),
        bbox_h: detection
            .bbox_h
            .min(PANEL_H - detection.bbox_y.max(0)),
    }
}

fn map_to_comic_scaled(
    detection: RawLocalDetection,
    origin_x: i32,
    origin_y: i32,
    scale_x: f64,
    scale_y: f64,
) -> RawLocalDetection {
    let local_x = (detection.bbox_x as f64 * scale_x) as i32;
    let local_y = (detection.bbox_y as f64 * scale_y) as i32;
    let local_width = (detection.bbox_w as f64 * scale_x) as i32;
    let local_height = (detection.bbox_h as f64 * scale_y) as i32;
    RawLocalDetection {
        class_id: detection.class_id,
        class_name: detection.class_name,
        confidence: detection.confidence,
        bbox_x: origin_x + local_x.max(0),
        bbox_y: origin_y + local_y.max(0),
        bbox_w: local_width.min(PANEL_W - local_x.max(0)),
        bbox_h: local_height.min(PANEL_H - local_y.max(0)),
    }
}

fn normalize_class(class_id: i32, class_name: String) -> String {
    if class_id == 16 {
        "cat".to_string()
    } else {
        class_name
    }
}

fn iou_raw(a: &RawLocalDetection, b: &RawLocalDetection) -> f64 {
    let x1 = a.bbox_x.max(b.bbox_x);
    let y1 = a.bbox_y.max(b.bbox_y);
    let x2 = (a.bbox_x + a.bbox_w).min(b.bbox_x + b.bbox_w);
    let y2 = (a.bbox_y + a.bbox_h).min(b.bbox_y + b.bbox_h);
    let intersection = (x2 - x1).max(0) as f64 * (y2 - y1).max(0) as f64;
    let union = a.bbox_w as f64 * a.bbox_h as f64 + b.bbox_w as f64 * b.bbox_h as f64
        - intersection;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}
