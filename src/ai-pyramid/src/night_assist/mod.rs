//! Night Assist — supplementary YOLO detection for rdk-x5 night camera.
//!
//! Connects to rdk-x5 H.265 TCP relay via ffmpeg, decodes keyframes to raw RGB,
//! applies CLAHE for IR contrast enhancement, runs YOLO26l on NPU, and broadcasts
//! detections over SSE.

mod clahe;

use crate::detect::local::{LocalDetector, RawLocalDetection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Semaphore, broadcast, watch};
use tracing::{info, warn};

/// COCO class IDs matching rdk-x5 DetectionClass (6 classes).
const NIGHT_ASSIST_CLASSES: &[i32] = &[
    0,  // person
    15, // cat
    16, // dog → normalized to "cat"
    41, // cup
    45, // bowl (food_bowl)
    56, // chair
];

/// Frame dimensions (must match encoder config on rdk-x5).
const FRAME_WIDTH: usize = 1280;
const FRAME_HEIGHT: usize = 720;
const FRAME_SIZE: usize = FRAME_WIDTH * FRAME_HEIGHT * 3 / 2; // NV12

/// Configuration for the night assist worker.
#[derive(Debug, Clone)]
pub struct NightAssistConfig {
    /// rdk-x5 hostname or IP
    pub rdk_x5_host: String,
    /// TCP relay port (default 9265)
    pub relay_port: u16,
    /// Temp file for JPEG frames (after CLAHE)
    pub frame_path: PathBuf,
}

impl NightAssistConfig {
    pub fn new(rdk_x5_host: String) -> Self {
        Self {
            rdk_x5_host,
            relay_port: 9265,
            frame_path: PathBuf::from("/tmp/night_assist_frame.jpg"),
        }
    }
}

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

/// Night assist worker: ffmpeg decode + CLAHE + YOLO loop + broadcast.
pub struct NightAssistWorker {
    config: NightAssistConfig,
    detector: Arc<LocalDetector>,
    npu_semaphore: Arc<Semaphore>,
    detection_tx: broadcast::Sender<DetectionEvent>,
}

impl NightAssistWorker {
    pub fn new(
        config: NightAssistConfig,
        detector: Arc<LocalDetector>,
        npu_semaphore: Arc<Semaphore>,
        detection_tx: broadcast::Sender<DetectionEvent>,
    ) -> Self {
        Self {
            config,
            detector,
            npu_semaphore,
            detection_tx,
        }
    }

    /// Run the worker loop (never returns unless cancelled).
    pub async fn run(self) {
        let mut backoff = Duration::from_secs(5);
        let max_backoff = Duration::from_secs(30);

        loop {
            info!(
                "Connecting to rdk-x5 H.265 relay at {}:{}",
                self.config.rdk_x5_host, self.config.relay_port
            );

            match self.run_session().await {
                Ok(()) => {
                    info!("ffmpeg session ended normally");
                    backoff = Duration::from_secs(5);
                }
                Err(e) => {
                    warn!("ffmpeg session error: {e}");
                }
            }

            info!("Reconnecting in {}s...", backoff.as_secs());
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(max_backoff);
        }
    }

    /// Run a single ffmpeg session: raw decode + CLAHE + YOLO loop.
    async fn run_session(&self) -> Result<(), String> {
        let tcp_url = format!(
            "tcp://{}:{}",
            self.config.rdk_x5_host, self.config.relay_port
        );

        let mut child = spawn_ffmpeg(&tcp_url).map_err(|e| format!("spawn ffmpeg: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no ffmpeg stdout".to_string())?;

        // Stderr logging task
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.contains("Error") || line.contains("error") {
                        warn!("[ffmpeg] {line}");
                    }
                }
            });
        }

        // Frame watch channel: raw RGB24 frames
        let (frame_tx, mut frame_rx) = watch::channel::<Option<Vec<u8>>>(None);

        // Raw frame reader: read exactly FRAME_SIZE bytes per frame
        let reader_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = vec![0u8; FRAME_SIZE];

            loop {
                match reader.read_exact(&mut buf).await {
                    Ok(_) => {
                        let _ = frame_tx.send(Some(buf.clone()));
                    }
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::UnexpectedEof {
                            warn!("Raw frame read error: {e}");
                        }
                        break;
                    }
                }
            }
        });

        // YOLO detection loop
        let mut frames_processed: u64 = 0;
        let mut last_heartbeat = tokio::time::Instant::now();
        let idle_timeout = Duration::from_secs(3);
        let heartbeat_interval = Duration::from_secs(10);

        loop {
            let got_frame = tokio::time::timeout(idle_timeout, frame_rx.changed()).await;

            match got_frame {
                Ok(Ok(())) => {
                    let rgb_data = frame_rx.borrow_and_update().clone();
                    if let Some(data) = rgb_data {
                        self.process_frame(&data, &mut frames_processed).await;
                    }
                }
                Ok(Err(_)) => break, // Channel closed
                Err(_) => {}         // Timeout — idle, keep waiting
            }

            // Periodic heartbeat
            if last_heartbeat.elapsed() >= heartbeat_interval {
                let _ = self.detection_tx.send(DetectionEvent {
                    detections: vec![],
                    source_width: 0,
                    source_height: 0,
                    timestamp: now_timestamp(),
                });
                frames_processed = 0;
                last_heartbeat = tokio::time::Instant::now();
            }
        }

        let _ = child.kill().await;
        reader_handle.abort();
        Ok(())
    }

    /// Process a single raw RGB frame: CLAHE → JPEG → YOLO → broadcast.
    async fn process_frame(&self, nv12_data: &[u8], frames_processed: &mut u64) {
        // Try to acquire NPU — skip if VLM is running
        let permit = match self.npu_semaphore.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => return,
        };

        // CLAHE + JPEG encode (blocking CPU work, run in spawn_blocking)
        let nv12 = nv12_data.to_vec();
        let jpeg_data = tokio::task::spawn_blocking(move || {
            clahe::apply_clahe_nv12_to_jpeg(&nv12, FRAME_WIDTH, FRAME_HEIGHT, 90)
        })
        .await;

        let jpeg_data = match jpeg_data {
            Ok(data) => data,
            Err(e) => {
                warn!("CLAHE/JPEG encode failed: {e}");
                drop(permit);
                return;
            }
        };

        // Write JPEG to temp file for YOLO
        if let Err(e) = tokio::fs::write(&self.config.frame_path, &jpeg_data).await {
            warn!("Failed to write frame: {e}");
            drop(permit);
            return;
        }

        // Run YOLO26l
        let result = self.detector.detect_image(&self.config.frame_path).await;
        drop(permit);

        match result {
            Ok(dets) => {
                let filtered = filter_night_assist_classes(&dets);
                if !filtered.is_empty() {
                    let event = DetectionEvent {
                        detections: filtered,
                        source_width: FRAME_WIDTH as i32,
                        source_height: FRAME_HEIGHT as i32,
                        timestamp: now_timestamp(),
                    };
                    let _ = self.detection_tx.send(event);
                }
                *frames_processed += 1;
            }
            Err(e) => {
                warn!("YOLO detection failed: {e}");
            }
        }
    }
}

/// Filter detections to rdk-x5's 6-class set.
fn filter_night_assist_classes(dets: &[RawLocalDetection]) -> Vec<NightAssistDetection> {
    dets.iter()
        .filter(|d| NIGHT_ASSIST_CLASSES.contains(&d.class_id))
        .map(|d| NightAssistDetection {
            class_name: normalize_class_name(d.class_id, &d.class_name),
            confidence: d.confidence,
            bbox: BBox {
                x: d.bbox_x,
                y: d.bbox_y,
                w: d.bbox_w,
                h: d.bbox_h,
            },
        })
        .collect()
}

/// Match rdk-x5 class naming: dog→cat, bowl→food_bowl.
fn normalize_class_name(class_id: i32, name: &str) -> String {
    match class_id {
        16 => "cat".to_string(),       // dog → cat (no dogs in this house)
        45 => "food_bowl".to_string(), // COCO "bowl" → rdk-x5 "food_bowl"
        _ => name.to_string(),
    }
}

/// Spawn ffmpeg for H.265 keyframe decode to raw NV12 pipe.
///
/// NV12 output: FRAME_SIZE (W×H×1.5) bytes per frame, no marker parsing needed.
/// CLAHE operates directly on Y plane — no RGB↔YCrCb conversion in ffmpeg.
/// SW decoder with `-skip_frame nokey` skips non-IDR at decoder level (CPU ~0%).
fn spawn_ffmpeg(tcp_url: &str) -> Result<Child, std::io::Error> {
    Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-analyzeduration",
            "10000000",
            "-probesize",
            "10000000",
            "-skip_frame",
            "nokey",
            "-f",
            "hevc",
            "-i",
            tcp_url,
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "nv12",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

fn now_timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
