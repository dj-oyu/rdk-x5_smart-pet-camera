use super::client::DaemonClient;
use super::image_conversion::rgb_to_nv12;
use super::wire::RawLocalDetection;
use crate::db::DetectionInput;
use std::path::Path;

// Keep aligned with pet-camera's COCO_TO_DETECTION_CLASS.
const KEEP_CLASSES: &[i32] = &[0, 15, 16, 41, 45, 56];

const MARGIN: i32 = 12;
const BORDER: i32 = 2;
const GAP: i32 = 8;
pub(super) const PANEL_W: i32 = 404;
pub(super) const PANEL_H: i32 = 228;
const CELL_W: i32 = PANEL_W + 2 * BORDER;
const CELL_H: i32 = PANEL_H + 2 * BORDER;

pub(super) async fn detect_comic_raw_first(
    client: &DaemonClient,
    model: &str,
    jpeg_path: &Path,
    image: &image::DynamicImage,
) -> Result<Vec<RawLocalDetection>, String> {
    if model.is_empty() {
        tracing::warn!("No local YOLO model configured (YOLO_ACCURATE_MODEL)");
        return Ok(Vec::new());
    }

    tracing::info!("Loading local detection model {model}");
    client.load_model(model).await?;

    let raw_detections = client.detect_image(jpeg_path).await?;
    if has_pet_detection(&raw_detections) {
        return Ok(raw_detections);
    }

    tracing::info!(
        "Raw comic detection found no pet; running four-panel fallback for {}",
        jpeg_path.display()
    );

    let panel_width = PANEL_W as u32;
    let panel_height = PANEL_H as u32;
    let mut combined = raw_detections;
    for index in 0..4u32 {
        let (origin_x, origin_y) = panel_origin(index);
        let rgb = image
            .crop_imm(origin_x as u32, origin_y as u32, panel_width, panel_height)
            .to_rgb8();
        let nv12 = rgb_to_nv12(&rgb, panel_width, panel_height);
        let panel_detections = client
            .detect_nv12(&nv12, panel_width as u16, panel_height as u16)
            .await?;
        combined.extend(
            panel_detections
                .into_iter()
                .map(|detection| map_to_comic(detection, origin_x, origin_y)),
        );
    }
    Ok(merge_detections(combined))
}

pub(super) fn has_pet_detection(detections: &[RawLocalDetection]) -> bool {
    detections
        .iter()
        .any(|detection| matches!(detection.class_id, 15 | 16))
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

pub(super) fn merge_detections(mut detections: Vec<RawLocalDetection>) -> Vec<RawLocalDetection> {
    detections.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut merged: Vec<RawLocalDetection> = Vec::new();
    for detection in detections {
        if let Some(existing) = merged.iter_mut().find(|candidate| {
            candidate.class_id == detection.class_id && iou_raw(candidate, &detection) > 0.5
        }) {
            existing.confidence = 1.0 - (1.0 - existing.confidence) * (1.0 - detection.confidence);
        } else {
            merged.push(detection);
        }
    }

    merged.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let mut result: Vec<RawLocalDetection> = Vec::new();
    for detection in merged {
        if !result.iter().any(|candidate| {
            candidate.class_id == detection.class_id && iou_raw(candidate, &detection) > 0.3
        }) {
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

fn map_to_comic(detection: RawLocalDetection, origin_x: i32, origin_y: i32) -> RawLocalDetection {
    RawLocalDetection {
        class_id: detection.class_id,
        class_name: detection.class_name,
        confidence: detection.confidence,
        bbox_x: origin_x + detection.bbox_x.max(0),
        bbox_y: origin_y + detection.bbox_y.max(0),
        bbox_w: detection.bbox_w.min(PANEL_W - detection.bbox_x.max(0)),
        bbox_h: detection.bbox_h.min(PANEL_H - detection.bbox_y.max(0)),
    }
}

fn normalize_class(_class_id: i32, class_name: String) -> String {
    class_name
}

fn iou_raw(a: &RawLocalDetection, b: &RawLocalDetection) -> f64 {
    let x1 = a.bbox_x.max(b.bbox_x);
    let y1 = a.bbox_y.max(b.bbox_y);
    let x2 = (a.bbox_x + a.bbox_w).min(b.bbox_x + b.bbox_w);
    let y2 = (a.bbox_y + a.bbox_h).min(b.bbox_y + b.bbox_h);
    let intersection = (x2 - x1).max(0) as f64 * (y2 - y1).max(0) as f64;
    let union =
        a.bbox_w as f64 * a.bbox_h as f64 + b.bbox_w as f64 * b.bbox_h as f64 - intersection;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}
