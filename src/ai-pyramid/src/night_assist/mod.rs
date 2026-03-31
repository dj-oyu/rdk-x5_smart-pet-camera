//! Night Assist — SSE types for rdk-x5 night camera detection.
//!
//! Detection processing (H.265 decode, CLAHE, IVPS, NPU) is handled by
//! ax_yolo_daemon's CMD_STREAM mode. This module only defines the SSE
//! event types used by the server to relay detection results.

use serde::Serialize;

/// A single detection from night assist YOLO.
#[derive(Debug, Clone, Serialize)]
pub struct NightAssistDetection {
    pub class_name: String,
    pub confidence: f64,
    pub bbox: BBox,
}

#[derive(Debug, Clone, Serialize)]
pub struct BBox {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// SSE event payload.
#[derive(Debug, Clone, Serialize)]
pub struct DetectionEvent {
    pub detections: Vec<NightAssistDetection>,
    pub source_width: i32,
    pub source_height: i32,
    pub timestamp: f64,
}
