pub mod local;

use crate::db::DetectionInput;
use crate::ingest::filename::parse_comic_filename;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct DetectConfig {
    /// e.g. "http://camera-host:8083"
    pub camera_base_url: String,
    /// e.g. "http://album-host:8082" — URL the camera uses to fetch photos from us
    pub self_base_url: String,
    pub timeout: Duration,
    /// YOLO score threshold for panel detection (lower than live camera default)
    pub score_threshold: f64,
}

pub struct DetectClient {
    config: DetectConfig,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct DetectRequest {
    image_url: String,
    score_threshold: f64,
}

#[derive(Deserialize)]
struct DetectResponse {
    detections: Vec<RawDetection>,
}

#[derive(Deserialize)]
struct RawDetection {
    class_name: String,
    confidence: f64,
    bbox: RawBbox,
}

#[derive(Deserialize)]
struct RawBbox {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl DetectClient {
    pub fn new(config: DetectConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("failed to build HTTP client");
        Self { config, http }
    }

    /// Call rdk-x5 /detect endpoint for each of the 4 comic panels.
    /// Panel bbox coordinates are mapped back to the full comic image (848×496).
    /// Returns detection inputs ready for `ingest_with_detections`.
    pub async fn detect(&self, filename: &str) -> Result<Vec<DetectionInput>, String> {
        let detect_url = format!("{}/detect", self.config.camera_base_url);

        // Extract detected_at from filename, fallback to now
        let detected_at = parse_comic_filename(filename)
            .map(|m| crate::timestamps::to_db(m.captured_at))
            .unwrap_or_else(|_| crate::timestamps::now_db());

        let mut all_inputs = Vec::new();

        // Comic layout constants (must match server::crop_panel)
        const MARGIN: i32 = 12;
        const BORDER: i32 = 2;
        const GAP: i32 = 8;
        const PANEL_W: i32 = 404;
        const PANEL_H: i32 = 228;
        const CELL_W: i32 = PANEL_W + 2 * BORDER;
        const CELL_H: i32 = PANEL_H + 2 * BORDER;
        // Letterbox parameters (must match server::crop_panel)
        const TARGET: f64 = 640.0;
        let scale = (TARGET / PANEL_W as f64).min(TARGET / PANEL_H as f64);
        let new_w = (PANEL_W as f64 * scale) as i32;
        let new_h = (PANEL_H as f64 * scale) as i32;
        let pad_x = (TARGET as i32 - new_w) / 2;
        let pad_y = (TARGET as i32 - new_h) / 2;

        for panel in 0..4u32 {
            let image_url = format!(
                "{}/api/photos/{}/panel/{}",
                self.config.self_base_url, filename, panel
            );
            let request = DetectRequest {
                image_url,
                score_threshold: self.config.score_threshold,
            };

            let result = self.detect_one(&detect_url, &request).await;
            match result {
                Ok(resp) => {
                    let col = panel as i32 % 2;
                    let row = panel as i32 / 2;
                    // Panel origin in comic coordinates
                    let origin_x = MARGIN + BORDER + col * (CELL_W + GAP);
                    let origin_y = MARGIN + BORDER + row * (CELL_H + GAP);

                    for d in resp.detections {
                        // 640×640 letterbox → remove padding → scale to panel → offset to comic
                        let panel_x = ((d.bbox.x - pad_x) as f64 / scale) as i32;
                        let panel_y = ((d.bbox.y - pad_y) as f64 / scale) as i32;
                        let panel_w = (d.bbox.w as f64 / scale) as i32;
                        let panel_h = (d.bbox.h as f64 / scale) as i32;
                        all_inputs.push(DetectionInput {
                            panel_index: Some(panel as i32),
                            bbox_x: origin_x + panel_x.max(0),
                            bbox_y: origin_y + panel_y.max(0),
                            bbox_w: panel_w.min(PANEL_W - panel_x.max(0)),
                            bbox_h: panel_h.min(PANEL_H - panel_y.max(0)),
                            yolo_class: Some(d.class_name),
                            pet_class: None,
                            confidence: Some(d.confidence),
                            detected_at: detected_at.clone(),
                            color_metrics: None,
                            det_level: 1,
                            model: None,
                        });
                    }
                }
                Err(e) => {
                    tracing::warn!("Panel {panel} detect failed for {filename}: {e}");
                }
            }
        }

        Ok(all_inputs)
    }

    /// Send a single detect request with retry.
    async fn detect_one(
        &self,
        url: &str,
        request: &DetectRequest,
    ) -> Result<DetectResponse, String> {
        let mut last_err = String::new();
        for attempt in 0..2 {
            match self.http.post(url).json(request).send().await {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        let status = resp.status();
                        let body = resp.text().await.unwrap_or_default();
                        last_err = format!("detect API {status}: {body}");
                        if attempt == 0 {
                            continue;
                        }
                        return Err(last_err);
                    }
                    return resp
                        .json()
                        .await
                        .map_err(|e| format!("detect response decode: {e}"));
                }
                Err(e) => {
                    last_err = format!("detect request failed: {e}");
                    if attempt == 0 {
                        continue;
                    }
                }
            }
        }
        Err(last_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::StatusCode, routing::post};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn detect_panels_with_offset() {
        // Letterbox: 404×228 → scale=640/404≈1.5842 → 640×361, pad_x=0, pad_y=139
        // Python returns bbox in 640×640 letterbox space (since image is already 640×640)
        // But Python's own letterbox is identity (640×640 → 640×640, scale=1, pad=0)
        // so bbox coords ARE in the 640×640 space from our letterbox
        let app = Router::new().route(
            "/detect",
            post(|Json(body): Json<serde_json::Value>| async move {
                let url = body["image_url"].as_str().unwrap().to_string();
                assert!(url.contains("/panel/"));
                let panel: u32 = url.chars().last().unwrap().to_digit(10).unwrap();
                let resp = match panel {
                    // Bbox in 640×640 space (content at y=139..500)
                    0 => serde_json::json!({
                        "detections": [{
                            "class_name": "cat", "confidence": 0.85,
                            "bbox": {"x": 100, "y": 200, "w": 141, "h": 100}
                        }],
                        "width": 640, "height": 640
                    }),
                    2 => serde_json::json!({
                        "detections": [{
                            "class_name": "cup", "confidence": 0.62,
                            "bbox": {"x": 300, "y": 250, "w": 80, "h": 60}
                        }],
                        "width": 640, "height": 640
                    }),
                    _ => serde_json::json!({
                        "detections": [], "width": 640, "height": 640
                    }),
                };
                Json(resp)
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let client = DetectClient::new(DetectConfig {
            camera_base_url: format!("http://{addr}"),
            self_base_url: "http://localhost:8082".into(),
            timeout: Duration::from_secs(5),
            score_threshold: 0.2,
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert_eq!(dets.len(), 2);

        // scale = 640/404 ≈ 1.5842, pad_x=0, pad_y=(640-361)/2=139
        // Panel 0 origin in comic: (14, 14)
        // panel_x = (100 - 0) / 1.5842 ≈ 63
        // panel_y = (200 - 139) / 1.5842 ≈ 38
        let scale = 640.0 / 404.0_f64;
        let pad_y = (640 - (228.0 * scale) as i32) / 2; // 139
        assert_eq!(dets[0].yolo_class.as_deref(), Some("cat"));
        assert_eq!(dets[0].panel_index, Some(0));
        assert_eq!(dets[0].bbox_x, 14 + (100.0 / scale) as i32);
        assert_eq!(dets[0].bbox_y, 14 + ((200 - pad_y) as f64 / scale) as i32);

        // Panel 2 origin: (14, 12+2+1*(228+4+8)) = (14, 254)
        assert_eq!(dets[1].yolo_class.as_deref(), Some("cup"));
        assert_eq!(dets[1].panel_index, Some(2));
        // detected_at comes from the filename, which the camera writes in its
        // local time; stored as the UTC instant that names.
        assert_eq!(
            dets[0].detected_at,
            crate::timestamps::to_db(
                crate::timestamps::from_camera_local(
                    chrono::NaiveDate::from_ymd_opt(2026, 3, 21)
                        .unwrap()
                        .and_hms_opt(10, 45, 32)
                        .unwrap()
                )
            )
        );
    }

    #[tokio::test]
    async fn detect_all_panels_empty() {
        let app = Router::new().route(
            "/detect",
            post(|| async {
                Json(serde_json::json!({
                    "detections": [], "width": 640, "height": 361
                }))
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });

        let client = DetectClient::new(DetectConfig {
            camera_base_url: format!("http://{addr}"),
            self_base_url: "http://localhost:8082".into(),
            timeout: Duration::from_secs(5),
            score_threshold: 0.2,
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert!(dets.is_empty());
    }

    #[tokio::test]
    async fn detect_request_retries_http_failure_once() {
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let app = Router::new().route(
            "/detect",
            post(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::BAD_GATEWAY, "detector unavailable")
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        let client = DetectClient::new(DetectConfig {
            camera_base_url: format!("http://{addr}"),
            self_base_url: "http://localhost:8082".into(),
            timeout: Duration::from_secs(5),
            score_threshold: 0.2,
        });

        let request = DetectRequest {
            image_url: "http://localhost:8082/api/photos/test.jpg/panel/0".into(),
            score_threshold: 0.2,
        };
        let error = match client
            .detect_one(&format!("http://{addr}/detect"), &request)
            .await
        {
            Ok(_) => panic!("the detector should return its HTTP error"),
            Err(error) => error,
        };

        assert!(error.contains("502 Bad Gateway"));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn malformed_panel_responses_are_omitted_without_aborting_batch() {
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let app = Router::new().route(
            "/detect",
            post(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({"unexpected": true}))
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        let client = DetectClient::new(DetectConfig {
            camera_base_url: format!("http://{addr}"),
            self_base_url: "http://localhost:8082".into(),
            timeout: Duration::from_secs(5),
            score_threshold: 0.2,
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();

        assert!(dets.is_empty());
        // Decode errors are not retried; retry is reserved for request/status failures.
        assert_eq!(requests.load(Ordering::SeqCst), 4);
    }
}
