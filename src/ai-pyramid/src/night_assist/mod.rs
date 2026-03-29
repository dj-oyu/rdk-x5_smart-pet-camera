//! Night Assist — supplementary YOLO detection for rdk-x5 night camera.
//!
//! Connects to rdk-x5 H.265 TCP relay via ffmpeg, decodes keyframes,
//! runs YOLO26l on NPU, and broadcasts detections over SSE.

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

/// Configuration for the night assist worker.
#[derive(Debug, Clone)]
pub struct NightAssistConfig {
    /// rdk-x5 hostname or IP
    pub rdk_x5_host: String,
    /// TCP relay port (default 9265)
    pub relay_port: u16,
    /// Temp file for JPEG frames
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

/// Heartbeat event payload.
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatEvent {
    pub status: String,
    pub fps: f64,
}

/// Night assist worker: ffmpeg decode + YOLO loop + broadcast.
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

    /// Run a single ffmpeg session: decode + YOLO loop.
    async fn run_session(&self) -> Result<(), String> {
        let tcp_url = format!(
            "tcp://{}:{}",
            self.config.rdk_x5_host, self.config.relay_port
        );

        // Spawn ffmpeg: H.265 HW decode → keyframe-only → JPEG pipe
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

        // Frame watch channel: producer writes JPEG bytes, consumer reads latest
        let (frame_tx, mut frame_rx) = watch::channel::<Option<Vec<u8>>>(None);

        // JPEG reader task: parse JPEG stream from ffmpeg stdout
        let reader_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(256 * 1024);

            loop {
                match read_jpeg_frame(&mut reader, &mut buf).await {
                    Ok(true) => {
                        let _ = frame_tx.send(Some(buf.clone()));
                        buf.clear();
                    }
                    Ok(false) => break, // EOF
                    Err(e) => {
                        warn!("JPEG read error: {e}");
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
            // Wait for new frame or timeout
            let got_frame = tokio::time::timeout(idle_timeout, frame_rx.changed()).await;

            match got_frame {
                Ok(Ok(())) => {
                    // New frame available
                    let jpeg_data = frame_rx.borrow_and_update().clone();
                    if let Some(data) = jpeg_data {
                        self.process_frame(&data, &mut frames_processed).await;
                    }
                }
                Ok(Err(_)) => {
                    // Channel closed (ffmpeg exited)
                    break;
                }
                Err(_) => {
                    // Timeout — no frames for 3s, likely day mode
                    // Just keep waiting (don't break — TCP reconnect is expensive)
                }
            }

            // Periodic heartbeat
            if last_heartbeat.elapsed() >= heartbeat_interval {
                let fps =
                    frames_processed as f64 / last_heartbeat.elapsed().as_secs_f64().max(0.001);
                let _ = self.detection_tx.send(DetectionEvent {
                    detections: vec![],
                    source_width: 0,
                    source_height: 0,
                    timestamp: now_timestamp(),
                });
                // Reset for next interval
                frames_processed = 0;
                last_heartbeat = tokio::time::Instant::now();
                let _ = fps; // used for logging only
            }
        }

        // Cleanup
        let _ = child.kill().await;
        reader_handle.abort();
        Ok(())
    }

    /// Process a single keyframe: write to disk, run YOLO, broadcast.
    async fn process_frame(&self, jpeg_data: &[u8], frames_processed: &mut u64) {
        // Try to acquire NPU — skip if VLM is running
        let permit = self.npu_semaphore.clone().try_acquire_owned();
        let permit = match permit {
            Ok(p) => p,
            Err(_) => return, // NPU busy (VLM running)
        };

        // Write JPEG to temp file
        if let Err(e) = tokio::fs::write(&self.config.frame_path, jpeg_data).await {
            warn!("Failed to write frame: {e}");
            drop(permit);
            return;
        }

        // Run YOLO26l
        let result = self.detector.detect_image(&self.config.frame_path).await;
        drop(permit); // release NPU ASAP

        match result {
            Ok(dets) => {
                let filtered = filter_night_assist_classes(&dets);
                if !filtered.is_empty() {
                    let event = DetectionEvent {
                        detections: filtered,
                        source_width: 1280,
                        source_height: 720,
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

/// Spawn ffmpeg for H.265 keyframe decode to JPEG pipe.
///
/// Uses SW decoder with increased probesize to handle mid-stream TCP joins
/// (hevc_axdec crashes on streams without leading VPS/SPS/PPS).
/// At 1fps keyframe-only, SW decode CPU cost is negligible.
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
            "-f",
            "hevc",
            "-i",
            tcp_url,
            "-vf",
            "select=eq(pict_type\\,I)",
            "-fps_mode",
            "passthrough",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "2",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// Read one JPEG frame from an image2pipe stream.
/// JPEG starts with FF D8 and ends with FF D9.
async fn read_jpeg_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    buf: &mut Vec<u8>,
) -> Result<bool, String> {
    // Find JPEG SOI marker (FF D8)
    loop {
        let byte = reader.read_u8().await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                return "EOF".to_string();
            }
            format!("read: {e}")
        })?;

        if byte == 0xFF {
            let next = reader.read_u8().await.map_err(|_| "EOF".to_string())?;
            if next == 0xD8 {
                buf.clear();
                buf.push(0xFF);
                buf.push(0xD8);
                break;
            }
        }
    }

    // Read until EOI marker (FF D9)
    loop {
        let byte = reader.read_u8().await.map_err(|_| "EOF".to_string())?;
        buf.push(byte);

        if buf.len() >= 4 && buf[buf.len() - 2] == 0xFF && buf[buf.len() - 1] == 0xD9 {
            return Ok(true);
        }

        // Safety: reject if frame > 2MB (corrupt stream)
        if buf.len() > 2 * 1024 * 1024 {
            return Err("JPEG frame too large (>2MB)".to_string());
        }
    }
}

fn now_timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
