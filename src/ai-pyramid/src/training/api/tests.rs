use super::*;
use crate::db::PhotoStore;
use crate::training::{bg, db::AnnotationInput};
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use tower::util::ServiceExt;

struct Fixture {
    state: TrainingState,
    pending_id: i64,
    _cache: tempfile::TempDir,
}

fn annotation(class_label: &str, x_center: f64) -> AnnotationInput {
    AnnotationInput {
        class_label: class_label.to_string(),
        x_center,
        y_center: 0.5,
        width: 0.2,
        height: 0.3,
    }
}

fn fixture() -> Fixture {
    let store = PhotoStore::open_in_memory().unwrap();
    store.migrate_training().unwrap();

    let pending_id = store
        .upsert_training_frame("frame-a.nv12", 640, 480, Some("2026-01-02T03:04:05"))
        .unwrap();
    store
        .replace_training_annotations(
            pending_id,
            &[annotation("cat", 0.25), annotation("dog", 0.75)],
        )
        .unwrap();
    store.bulk_update_bg_scores(&[(pending_id, 2.0)]).unwrap();

    let approved_id = store
        .upsert_training_frame("frame-b.nv12", 1280, 720, None)
        .unwrap();
    store
        .update_training_frame_status(approved_id, "approved")
        .unwrap();
    store
        .replace_training_annotations(approved_id, &[annotation("cat", 0.5)])
        .unwrap();

    let cache = tempfile::tempdir().unwrap();
    let cache_dir = cache.path().to_path_buf();

    Fixture {
        state: TrainingState {
            db: Database::new(store),
            ssh_host: "unused.invalid".to_string(),
            remote_dir: "/unused".to_string(),
            cache_dir,
            ssh_key: None,
        },
        pending_id,
        _cache: cache,
    }
}

#[tokio::test]
async fn export_derives_label_names_from_webp_frames() {
    // The camera stores frames as lossless WebP luma; raw .nv12 predates that.
    // Deriving the label name with replace(".nv12", ".txt") silently left WebP
    // frames labelled "*.webp", so an exported dataset had no usable labels.
    let store = PhotoStore::open_in_memory().unwrap();
    store.migrate_training().unwrap();
    let id = store
        .upsert_training_frame("feeding_00013775_1280x720.webp", 1280, 720, None)
        .unwrap();
    store
        .replace_training_annotations(id, &[annotation("cat", 0.5)])
        .unwrap();
    store.update_training_frame_status(id, "approved").unwrap();

    let cache = tempfile::tempdir().unwrap();
    let state = TrainingState {
        db: Database::new(store),
        ssh_host: "unused.invalid".to_string(),
        remote_dir: "/unused".to_string(),
        cache_dir: cache.path().to_path_buf(),
        ssh_key: None,
    };

    let (_, body) = send(&state, Method::GET, "/api/training/export", None).await;
    let body = json(&body);
    assert_eq!(body["files"][0]["image"], "feeding_00013775_1280x720.webp");
    assert_eq!(
        body["files"][0]["label_file"],
        "feeding_00013775_1280x720.txt"
    );
}

async fn send(
    state: &TrainingState,
    method: Method,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    let request_body = if let Some(json) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(serde_json::to_vec(&json).unwrap())
    } else {
        Body::empty()
    };
    let response = router(state.clone())
        .oneshot(builder.body(request_body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn frames_list_and_detail_keep_response_shape() {
    let fixture = fixture();
    let (status, body) = send(
        &fixture.state,
        Method::GET,
        "/api/training/frames?status=pending&limit=1&offset=0",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = json(&body);
    assert_eq!(body["total"], 1);
    assert_eq!(body["frames"][0]["id"], fixture.pending_id);
    assert_eq!(body["frames"][0]["filename"], "frame-a.nv12");
    assert_eq!(body["frames"][0]["annotation_count"], 2);

    let (status, body) = send(
        &fixture.state,
        Method::GET,
        &format!("/api/training/frames/{}", fixture.pending_id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = json(&body);
    assert_eq!(body["frame"]["status"], "pending");
    assert_eq!(body["annotations"].as_array().unwrap().len(), 2);

    let (status, body) = send(
        &fixture.state,
        Method::GET,
        "/api/training/frames/999999",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(String::from_utf8(body).unwrap(), "frame not found");
}

#[tokio::test]
async fn status_route_rejects_unknown_status_and_accepts_known_status() {
    let fixture = fixture();
    let uri = format!("/api/training/frames/{}/status", fixture.pending_id);
    let (status, body) = send(
        &fixture.state,
        Method::PUT,
        &uri,
        Some(serde_json::json!({"status": "archived"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "status must be pending/approved/rejected"
    );

    let (status, body) = send(
        &fixture.state,
        Method::PUT,
        &uri,
        Some(serde_json::json!({"status": "rejected"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(json(&body)["ok"].as_bool().unwrap());

    let (_, body) = send(
        &fixture.state,
        Method::GET,
        "/api/training/frames?status=rejected",
        None,
    )
    .await;
    assert_eq!(json(&body)["total"], 1);
}

#[tokio::test]
async fn annotations_route_validates_normalized_coordinates_and_replaces_atomically() {
    let fixture = fixture();
    let uri = format!("/api/training/frames/{}/annotations", fixture.pending_id);
    let invalid = serde_json::json!([{
        "class_label": "cat",
        "x_center": 1.01,
        "y_center": 0.5,
        "width": 0.2,
        "height": 0.3
    }]);
    let (status, body) = send(&fixture.state, Method::PUT, &uri, Some(invalid)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "coordinates must be normalized (0.0-1.0)"
    );
    let (_, body) = send(&fixture.state, Method::GET, &uri, None).await;
    assert_eq!(json(&body)["annotations"].as_array().unwrap().len(), 2);

    let replacement = serde_json::json!([{
        "class_label": "bird",
        "x_center": 0.4,
        "y_center": 0.6,
        "width": 0.1,
        "height": 0.2
    }]);
    let (status, body) = send(&fixture.state, Method::PUT, &uri, Some(replacement)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["count"], 1);

    let (_, body) = send(&fixture.state, Method::GET, &uri, None).await;
    let body = json(&body);
    assert_eq!(body["annotations"][0]["class_label"], "bird");
    let annotation_id = body["annotations"][0]["id"].as_i64().unwrap();

    let (status, body) = send(
        &fixture.state,
        Method::DELETE,
        &format!("/api/training/annotations/{annotation_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(json(&body)["ok"].as_bool().unwrap());
    let (_, body) = send(&fixture.state, Method::GET, &uri, None).await;
    assert!(json(&body)["annotations"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn stats_classes_and_export_keep_public_json_contracts() {
    let fixture = fixture();
    let (status, body) = send(&fixture.state, Method::GET, "/api/training/stats", None).await;
    assert_eq!(status, StatusCode::OK);
    let body = json(&body);
    assert_eq!(body["total"], 2);
    assert_eq!(body["pending"], 1);
    assert_eq!(body["approved"], 1);
    assert_eq!(body["total_annotations"], 3);

    let (_, body) = send(&fixture.state, Method::GET, "/api/training/classes", None).await;
    assert_eq!(json(&body)["classes"], serde_json::json!(["cat", "dog"]));

    let (_, body) = send(&fixture.state, Method::GET, "/api/training/export", None).await;
    let body = json(&body);
    assert_eq!(body["total_frames"], 1);
    assert_eq!(body["total_annotations"], 1);
    assert_eq!(body["classes"], serde_json::json!(["cat"]));
    assert_eq!(body["files"][0]["image"], "frame-b.nv12");
    assert_eq!(body["files"][0]["label_file"], "frame-b.txt");
    assert_eq!(
        body["files"][0]["labels"][0],
        "0 0.500000 0.500000 0.200000 0.300000"
    );
}

#[tokio::test]
async fn background_status_and_reject_routes_work_without_external_processes() {
    let fixture = fixture();
    let (status, body) = send(&fixture.state, Method::GET, "/api/training/bg/status", None).await;
    assert_eq!(status, StatusCode::OK);
    let body = json(&body);
    assert!(!body["model_exists"].as_bool().unwrap());
    assert_eq!(body["bg_ref_count"], 0);
    assert!(!body["stale"].as_bool().unwrap());
    assert_eq!(
        body["min_refs_required"].as_u64(),
        Some(bg::MIN_REF_FRAMES as u64)
    );

    let (status, _) = send(
        &fixture.state,
        Method::PUT,
        &format!("/api/training/frames/{}/bg_ref", fixture.pending_id),
        Some(serde_json::json!({"is_bg_ref": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = send(&fixture.state, Method::GET, "/api/training/bg/status", None).await;
    assert_eq!(json(&body)["bg_ref_count"], 1);

    for threshold in [-0.1, 100.1] {
        let (status, body) = send(
            &fixture.state,
            Method::POST,
            "/api/training/bg/reject",
            Some(serde_json::json!({"threshold": threshold})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "threshold must be 0.0–100.0"
        );
    }

    let (status, body) = send(
        &fixture.state,
        Method::POST,
        "/api/training/bg/reject",
        Some(serde_json::json!({"threshold": 5.0})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["rejected"], 1);
}

#[tokio::test]
async fn external_process_routes_fail_safely_before_spawning_tools() {
    let fixture = fixture();

    let (status, body) = send(
        &fixture.state,
        Method::GET,
        "/api/training/frames/999999/image",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(String::from_utf8(body).unwrap(), "frame not found");

    let (status, body) = send(&fixture.state, Method::POST, "/api/training/bg/build", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        String::from_utf8(body)
            .unwrap()
            .contains("background reference frames")
    );

    let (status, body) = send(&fixture.state, Method::POST, "/api/training/bg/score", None).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert!(
        String::from_utf8(body)
            .unwrap()
            .contains("no background model")
    );
}

#[tokio::test]
async fn cleanup_can_delete_rejected_rows_without_remote_ssh() {
    let fixture = fixture();
    let status_uri = format!("/api/training/frames/{}/status", fixture.pending_id);
    let (status, _) = send(
        &fixture.state,
        Method::PUT,
        &status_uri,
        Some(serde_json::json!({"status": "rejected"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &fixture.state,
        Method::POST,
        "/api/training/cleanup",
        Some(serde_json::json!({"delete_remote": false})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = json(&body);
    assert_eq!(body["deleted"], 1);
    assert_eq!(body["remote_deleted"], 0);
    assert!(body["remote_errors"].as_array().unwrap().is_empty());

    let (status, body) = send(
        &fixture.state,
        Method::GET,
        &format!("/api/training/frames/{}", fixture.pending_id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(String::from_utf8(body).unwrap(), "frame not found");
}
