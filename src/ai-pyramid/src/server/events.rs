use super::{AppState, PhotoEvent};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

pub(super) async fn handle_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(ref photo_event) => {
            let event_name = match photo_event {
                PhotoEvent::Update { .. } => "event",
                PhotoEvent::DetectionPartial { .. } => "detection-partial",
                PhotoEvent::DetectionReady { .. } => "detection-ready",
            };
            let json = serde_json::to_string(&photo_event).unwrap_or_default();
            Some(Ok(Event::default().event(event_name).data(json)))
        }
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub(super) async fn handle_night_assist_sse(State(state): State<AppState>) -> impl IntoResponse {
    let Some(ref host) = state.night_assist_host else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "night assist not configured",
        )
            .into_response();
    };

    let socket_path = state
        .local_detector
        .as_ref()
        .map(|ld| ld.socket_path().to_path_buf())
        .unwrap_or_else(|| {
            std::path::PathBuf::from(
                std::env::var("AX_YOLO_DAEMON_SOCKET")
                    .unwrap_or_else(|_| "/run/ax_yolo_daemon.sock".to_string()),
            )
        });

    let host = host.clone();

    // Connect to daemon and send CMD_STREAM.
    let setup = async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut conn = tokio::net::UnixStream::connect(&socket_path).await.ok()?;
        let header = crate::detect::local::stream_request_header(host.as_bytes());
        conn.write_all(&header).await.ok()?;
        // Read initial OK response (12 bytes).
        let mut resp_buf = [0u8; 12];
        conn.read_exact(&mut resp_buf).await.ok()?;
        Some(conn)
    };

    let conn = setup.await;
    let stream = futures_util::stream::unfold(conn, |state| async move {
        use tokio::io::AsyncReadExt;
        let mut conn = state?;

        // Read ResponseHeader (12 bytes).
        let mut hdr_buf = [0u8; 12];
        conn.read_exact(&mut hdr_buf).await.ok()?;
        let det_count = u16::from_ne_bytes([hdr_buf[2], hdr_buf[3]]) as usize;

        // Read detections (12 bytes each).
        let mut dets = Vec::new();
        for _ in 0..det_count {
            let mut det_buf = [0u8; 12];
            conn.read_exact(&mut det_buf).await.ok()?;
            let x1 = i16::from_ne_bytes([det_buf[0], det_buf[1]]);
            let y1 = i16::from_ne_bytes([det_buf[2], det_buf[3]]);
            let x2 = i16::from_ne_bytes([det_buf[4], det_buf[5]]);
            let y2 = i16::from_ne_bytes([det_buf[6], det_buf[7]]);
            let class_id = u16::from_ne_bytes([det_buf[8], det_buf[9]]);
            let confidence = u16::from_ne_bytes([det_buf[10], det_buf[11]]);
            dets.push(crate::night_assist::NightAssistDetection {
                class_name: crate::detect::local::coco_name(class_id),
                confidence: confidence as f64 / 10000.0,
                bbox: crate::night_assist::BBox {
                    x: x1 as i32,
                    y: y1 as i32,
                    w: (x2 - x1) as i32,
                    h: (y2 - y1) as i32,
                },
            });
        }

        let event_name = if dets.is_empty() {
            "heartbeat"
        } else {
            "detection"
        };
        let event = crate::night_assist::DetectionEvent {
            detections: dets,
            source_width: 1280,
            source_height: 720,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
        };
        let json = serde_json::to_string(&event).unwrap_or_default();
        let sse_event =
            Ok::<_, std::convert::Infallible>(Event::default().event(event_name).data(json));
        Some((sse_event, Some(conn)))
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}
