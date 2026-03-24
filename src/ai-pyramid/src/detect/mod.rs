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
}

pub struct DetectClient {
    config: DetectConfig,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct DetectRequest {
    image_url: String,
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

    /// Call rdk-x5 /detect endpoint with the photo URL.
    /// Returns detection inputs ready for `ingest_with_detections`.
    pub async fn detect(&self, filename: &str) -> Result<Vec<DetectionInput>, String> {
        let image_url = format!("{}/api/photos/{}", self.config.self_base_url, filename);
        let url = format!("{}/detect", self.config.camera_base_url);

        let request = DetectRequest { image_url };

        // Extract detected_at from filename, fallback to now
        let detected_at = parse_comic_filename(filename)
            .map(|m| m.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_else(|_| chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());

        // Single retry (same pattern as VlmClient)
        let mut last_err = String::new();
        for attempt in 0..2 {
            match self.http.post(&url).json(&request).send().await {
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
                    let detect_resp: DetectResponse = resp
                        .json()
                        .await
                        .map_err(|e| format!("detect response decode: {e}"))?;

                    let inputs: Vec<DetectionInput> = detect_resp
                        .detections
                        .into_iter()
                        .map(|d| DetectionInput {
                            panel_index: None,
                            bbox_x: d.bbox.x,
                            bbox_y: d.bbox.y,
                            bbox_w: d.bbox.w,
                            bbox_h: d.bbox.h,
                            yolo_class: Some(d.class_name),
                            pet_class: None,
                            confidence: Some(d.confidence),
                            detected_at: detected_at.clone(),
                        })
                        .collect();

                    return Ok(inputs);
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
    use axum::{Json, Router, routing::post};

    #[tokio::test]
    async fn detect_parses_response() {
        let app = Router::new().route(
            "/detect",
            post(|Json(body): Json<serde_json::Value>| async move {
                // Verify the request has image_url
                assert!(body.get("image_url").is_some());
                Json(serde_json::json!({
                    "detections": [
                        {
                            "class_name": "cat",
                            "confidence": 0.85,
                            "bbox": {"x": 146, "y": 147, "w": 89, "h": 89}
                        },
                        {
                            "class_name": "cup",
                            "confidence": 0.62,
                            "bbox": {"x": 300, "y": 100, "w": 80, "h": 60}
                        }
                    ],
                    "width": 848,
                    "height": 496
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
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert_eq!(dets.len(), 2);
        assert_eq!(dets[0].yolo_class.as_deref(), Some("cat"));
        assert_eq!(dets[0].bbox_x, 146);
        assert_eq!(dets[0].confidence, Some(0.85));
        assert_eq!(dets[1].yolo_class.as_deref(), Some("cup"));
        assert!(dets[0].panel_index.is_none());
        assert!(dets[0].pet_class.is_none());
        assert_eq!(dets[0].detected_at, "2026-03-21T10:45:32");
    }

    #[tokio::test]
    async fn detect_empty_response() {
        let app = Router::new().route(
            "/detect",
            post(|| async {
                Json(serde_json::json!({
                    "detections": [],
                    "width": 848,
                    "height": 496
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
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert!(dets.is_empty());
    }
}
