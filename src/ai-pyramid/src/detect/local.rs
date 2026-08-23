mod client;
mod image_conversion;
mod pipeline;
mod wire;

use crate::db::DetectionInput;
use crate::ingest::filename::parse_comic_filename;
use client::DaemonClient;
use pipeline::{detect_comic_raw_first, raw_dets_to_inputs};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

pub use wire::{RawLocalDetection, coco_name, stream_request_header};

#[derive(Debug, Clone)]
pub struct LocalDetectorConfig {
    /// Unix socket path for ax_yolo_daemon.
    pub daemon_socket: PathBuf,
    /// Model used for raw-first comic detection (e.g. "yolo26l").
    pub model: String,
}

impl Default for LocalDetectorConfig {
    fn default() -> Self {
        Self {
            daemon_socket: PathBuf::from(
                std::env::var("AX_YOLO_DAEMON_SOCKET")
                    .unwrap_or_else(|_| "/run/ax_yolo_daemon.sock".to_string()),
            ),
            model: std::env::var("YOLO_ACCURATE_MODEL").unwrap_or_else(|_| "yolo26l".into()),
        }
    }
}

pub struct LocalDetector {
    config: LocalDetectorConfig,
    client: DaemonClient,
}

impl LocalDetector {
    pub fn new(config: LocalDetectorConfig) -> Self {
        let client = DaemonClient::new(config.daemon_socket.clone());
        Self { config, client }
    }

    /// Check if the daemon socket exists.
    pub fn is_available(&self) -> bool {
        self.client.socket_path().exists()
    }

    /// Get the daemon socket path.
    pub fn socket_path(&self) -> &Path {
        self.client.socket_path()
    }

    /// Run detection on a single JPEG image via the daemon socket.
    pub async fn detect_image(&self, jpeg_path: &Path) -> Result<Vec<RawLocalDetection>, String> {
        self.client.detect_image(jpeg_path).await
    }

    /// Run detection on a raw NV12 frame via the daemon socket.
    pub async fn detect_nv12(
        &self,
        nv12: &[u8],
        width: u16,
        height: u16,
    ) -> Result<Vec<RawLocalDetection>, String> {
        self.client.detect_nv12(nv12, width, height, width).await
    }

    /// Hot-swap the daemon's loaded model by name.
    pub async fn load_model(&self, name: &str) -> Result<(), String> {
        self.client.load_model(name).await
    }

    /// Detect pets in a comic image using YOLO26l raw-first detection.
    pub async fn detect_comic(
        &self,
        photos_dir: &Path,
        filename: &str,
    ) -> Result<Vec<DetectionInput>, String> {
        self.detect_comic_inputs(photos_dir, filename).await
    }

    /// Send each detection through `tx` after the raw-first pipeline completes.
    pub async fn detect_comic_stream(
        &self,
        photos_dir: &Path,
        filename: &str,
        tx: &mpsc::Sender<DetectionInput>,
    ) -> Result<Vec<DetectionInput>, String> {
        let inputs = self.detect_comic_inputs(photos_dir, filename).await?;
        for input in &inputs {
            let _ = tx.send(input.clone()).await;
        }
        Ok(inputs)
    }

    async fn detect_comic_inputs(
        &self,
        photos_dir: &Path,
        filename: &str,
    ) -> Result<Vec<DetectionInput>, String> {
        let jpeg_path = photos_dir.join(filename);
        if !jpeg_path.exists() {
            return Err(format!("file not found: {}", jpeg_path.display()));
        }

        let detected_at = parse_comic_filename(filename)
            .map(|metadata| crate::timestamps::to_db(metadata.captured_at))
            .unwrap_or_else(|_| crate::timestamps::now_db());
        let image = image::open(&jpeg_path)
            .map_err(|error| format!("open {}: {error}", jpeg_path.display()))?;
        let detections =
            detect_comic_raw_first(&self.client, &self.config.model, &jpeg_path, &image).await?;
        Ok(raw_dets_to_inputs(
            &detections,
            &detected_at,
            "yolo26l-ax650-raw-first",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::pipeline::{bbox_to_panel, has_pet_detection, merge_detections, raw_dets_to_inputs};
    use super::wire::{
        CMD_STREAM, RequestHeader, ResponseHeader, WireDetection, nv12_request_header,
        request_bytes,
    };
    use super::*;

    #[test]
    fn wire_detection_round_trip() {
        let wire = WireDetection {
            x1: 231,
            y1: 325,
            x2: 343,
            y2: 406,
            class_id: 15,
            confidence: 7100,
        };
        let detection = RawLocalDetection {
            class_id: wire.class_id as i32,
            class_name: coco_name(wire.class_id),
            confidence: wire.confidence as f64 / 10000.0,
            bbox_x: wire.x1 as i32,
            bbox_y: wire.y1 as i32,
            bbox_w: (wire.x2 - wire.x1) as i32,
            bbox_h: (wire.y2 - wire.y1) as i32,
        };
        assert_eq!(detection.class_name, "cat");
        assert_eq!(detection.class_id, 15);
        assert!((detection.confidence - 0.71).abs() < 0.01);
        assert_eq!(detection.bbox_x, 231);
        assert_eq!(detection.bbox_w, 343 - 231);
    }

    #[test]
    fn wire_struct_sizes() {
        assert_eq!(std::mem::size_of::<RequestHeader>(), 16);
        assert_eq!(std::mem::size_of::<ResponseHeader>(), 12);
        assert_eq!(std::mem::size_of::<WireDetection>(), 12);
    }

    #[test]
    fn stream_request_header_matches_daemon_wire_contract() {
        let request = stream_request_header(b"rdk-x5");
        assert_eq!(request.len(), 22);
        assert_eq!(&request[0..2], &CMD_STREAM.to_ne_bytes());
        assert_eq!(&request[2..4], &0u16.to_ne_bytes());
        assert_eq!(&request[4..8], &[0, 0, 0, 0]);
        assert_eq!(&request[8..12], &6u32.to_ne_bytes());
        assert_eq!(&request[12..16], &[0, 0, 0, 0]);
        assert_eq!(&request[16..], b"rdk-x5");
    }

    #[test]
    fn nv12_request_carries_aligned_stride_in_reserved_field() {
        let header = nv12_request_header(404, 228, 416, 416 * 228 * 3 / 2);
        let request = request_bytes(&header);

        assert_eq!(&request[4..6], &404u16.to_ne_bytes());
        assert_eq!(&request[6..8], &228u16.to_ne_bytes());
        assert_eq!(&request[8..12], &(416u32 * 228 * 3 / 2).to_ne_bytes());
        assert_eq!(&request[12..16], &416u32.to_ne_bytes());
    }

    #[test]
    fn merge_dedup_same_class() {
        let detections = vec![
            detection(15, "cat", 0.81, 231, 329, 113, 77),
            detection(15, "cat", 0.71, 231, 325, 112, 81),
        ];
        let merged = merge_detections(detections);
        assert_eq!(merged.len(), 1);
        assert!((merged[0].confidence - 0.9449).abs() < 0.01);
    }

    #[test]
    fn merge_keeps_different_classes() {
        let detections = vec![
            detection(15, "cat", 0.81, 231, 329, 113, 77),
            detection(45, "bowl", 0.50, 231, 329, 113, 77),
        ];
        assert_eq!(merge_detections(detections).len(), 2);
    }

    #[test]
    fn panel_fallback_only_when_raw_detection_has_no_pet() {
        let objects = vec![detection(45, "bowl", 0.8, 10, 10, 20, 20)];
        assert!(!has_pet_detection(&objects));

        let mut with_cat = objects;
        with_cat.push(detection(15, "cat", 0.6, 30, 30, 40, 40));
        assert!(has_pet_detection(&with_cat));
    }

    #[test]
    fn bbox_to_panel_mapping() {
        assert_eq!(bbox_to_panel(100, 50, 100, 80), Some(0));
        assert_eq!(bbox_to_panel(500, 50, 100, 80), Some(1));
        assert_eq!(bbox_to_panel(100, 300, 100, 80), Some(2));
        assert_eq!(bbox_to_panel(500, 300, 100, 80), Some(3));
        assert_eq!(bbox_to_panel(416, 50, 8, 80), None);
    }

    #[test]
    fn raw_dets_to_inputs_maps_panels() {
        let detections = vec![
            detection(15, "cat", 0.90, 100, 50, 100, 80),
            detection(16, "dog", 0.42, 500, 300, 100, 80),
            detection(56, "chair", 0.30, 500, 50, 50, 50),
            detection(1, "bicycle", 0.80, 100, 300, 50, 50),
            detection(73, "book", 0.95, 200, 300, 50, 50),
        ];
        let inputs = raw_dets_to_inputs(&detections, "2026-03-30T01:00:00", "yolo26l-ax650-raw");
        assert_eq!(inputs.len(), 3);
        assert_eq!(inputs[0].panel_index, Some(0));
        assert_eq!(inputs[0].yolo_class.as_deref(), Some("cat"));
        assert_eq!(inputs[1].panel_index, Some(3));
        assert_eq!(inputs[1].yolo_class.as_deref(), Some("dog"));
        assert_eq!(inputs[2].panel_index, Some(1));
        assert_eq!(inputs[2].yolo_class.as_deref(), Some("chair"));
    }

    fn detection(
        class_id: i32,
        class_name: &str,
        confidence: f64,
        bbox_x: i32,
        bbox_y: i32,
        bbox_w: i32,
        bbox_h: i32,
    ) -> RawLocalDetection {
        RawLocalDetection {
            class_id,
            class_name: class_name.into(),
            confidence,
            bbox_x,
            bbox_y,
            bbox_w,
            bbox_h,
        }
    }
}
