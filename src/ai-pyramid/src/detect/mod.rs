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

    /// Call rdk-x5 /detect endpoint for each of the 4 comic panels.
    /// Panel bbox coordinates are mapped back to the full comic image (848×496).
    /// Returns detection inputs ready for `ingest_with_detections`.
    pub async fn detect(&self, filename: &str) -> Result<Vec<DetectionInput>, String> {
        let detect_url = format!("{}/detect", self.config.camera_base_url);

        // Extract detected_at from filename, fallback to now
        let detected_at = parse_comic_filename(filename)
            .map(|m| m.captured_at.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_else(|_| chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());

        let mut all_inputs = Vec::new();

        // Comic layout constants (must match server::crop_panel)
        const MARGIN: i32 = 12;
        const BORDER: i32 = 2;
        const GAP: i32 = 8;
        const PANEL_W: i32 = 404;
        const PANEL_H: i32 = 228;
        const CELL_W: i32 = PANEL_W + 2 * BORDER;
        const CELL_H: i32 = PANEL_H + 2 * BORDER;
        // Upscale factor used by crop_panel (fit 640px longest side, aspect-ratio preserved)
        let upscale = (640.0_f64 / PANEL_W as f64).min(640.0 / PANEL_H as f64);

        for panel in 0..4u32 {
            let image_url = format!(
                "{}/api/photos/{}/panel/{}",
                self.config.self_base_url, filename, panel
            );
            let request = DetectRequest { image_url };

            let result = self.detect_one(&detect_url, &request).await;
            match result {
                Ok(resp) => {
                    let col = panel as i32 % 2;
                    let row = panel as i32 / 2;
                    // Panel origin in comic coordinates
                    let origin_x = MARGIN + BORDER + col * (CELL_W + GAP);
                    let origin_y = MARGIN + BORDER + row * (CELL_H + GAP);

                    for d in resp.detections {
                        // Map upscaled coords back to original panel size, then offset
                        all_inputs.push(DetectionInput {
                            panel_index: Some(panel as i32),
                            bbox_x: origin_x + (d.bbox.x as f64 / upscale) as i32,
                            bbox_y: origin_y + (d.bbox.y as f64 / upscale) as i32,
                            bbox_w: (d.bbox.w as f64 / upscale) as i32,
                            bbox_h: (d.bbox.h as f64 / upscale) as i32,
                            yolo_class: Some(d.class_name),
                            pet_class: None,
                            confidence: Some(d.confidence),
                            detected_at: detected_at.clone(),
                            color_metrics: None,
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
    use axum::{Json, Router, routing::post};

    #[tokio::test]
    async fn detect_panels_with_offset() {
        // Upscaled image size: 404×228 * (640/404) ≈ 640×361
        let app = Router::new().route(
            "/detect",
            post(|Json(body): Json<serde_json::Value>| async move {
                let url = body["image_url"].as_str().unwrap().to_string();
                assert!(url.contains("/panel/"));
                let panel: u32 = url.chars().last().unwrap().to_digit(10).unwrap();
                let resp = match panel {
                    // Bbox coords are in upscaled (640×361) space
                    0 => serde_json::json!({
                        "detections": [{
                            "class_name": "cat", "confidence": 0.85,
                            "bbox": {"x": 158, "y": 79, "w": 141, "h": 141}
                        }],
                        "width": 640, "height": 361
                    }),
                    2 => serde_json::json!({
                        "detections": [{
                            "class_name": "cup", "confidence": 0.62,
                            "bbox": {"x": 317, "y": 158, "w": 127, "h": 95}
                        }],
                        "width": 640, "height": 361
                    }),
                    _ => serde_json::json!({
                        "detections": [], "width": 640, "height": 361
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
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert_eq!(dets.len(), 2);

        // upscale = 640/404 ≈ 1.5842
        // Panel 0 origin: (14, 14)
        // bbox_x = 14 + (158 / 1.5842) ≈ 14 + 99 = 113
        assert_eq!(dets[0].yolo_class.as_deref(), Some("cat"));
        assert_eq!(dets[0].panel_index, Some(0));
        assert_eq!(dets[0].bbox_x, 14 + (158.0 / (640.0 / 404.0)) as i32);
        assert_eq!(dets[0].bbox_y, 14 + (79.0 / (640.0 / 404.0)) as i32);

        // Panel 2 origin: (14, 14 + 228 + 4 + 8) = (14, 254)
        // origin_y = 12 + 2 + 1*(228+4+8) = 254
        assert_eq!(dets[1].yolo_class.as_deref(), Some("cup"));
        assert_eq!(dets[1].panel_index, Some(2));
        assert_eq!(dets[0].detected_at, "2026-03-21T10:45:32");
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
        });

        let dets = client
            .detect("comic_20260321_104532_chatora.jpg")
            .await
            .unwrap();
        assert!(dets.is_empty());
    }
}
