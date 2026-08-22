use super::TrainingState;
use crate::application::db_thread::DbCommand;
use crate::training::db::AnnotationInput;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use std::sync::Arc;

pub(super) async fn list(
    State(state): State<Arc<TrainingState>>,
    Path(frame_id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let annotations = state
        .db
        .request(move |reply| DbCommand::TrainingListAnnotations { frame_id, reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"annotations": annotations})))
}

pub(super) async fn replace(
    State(state): State<Arc<TrainingState>>,
    Path(frame_id): Path<i64>,
    Json(body): Json<Vec<AnnotationInput>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    for ann in &body {
        if ann.x_center < 0.0
            || ann.x_center > 1.0
            || ann.y_center < 0.0
            || ann.y_center > 1.0
            || ann.width < 0.0
            || ann.width > 1.0
            || ann.height < 0.0
            || ann.height > 1.0
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "coordinates must be normalized (0.0-1.0)".to_string(),
            ));
        }
    }

    let annotations = body.clone();
    state
        .db
        .request(move |reply| DbCommand::TrainingReplaceAnnotations {
            frame_id,
            annotations,
            reply,
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true, "count": body.len()})))
}

pub(super) async fn delete(
    State(state): State<Arc<TrainingState>>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    state
        .db
        .request(move |reply| DbCommand::TrainingDeleteAnnotation { id, reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({"ok": true})))
}

pub(super) async fn stats(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stats = state
        .db
        .request(move |reply| DbCommand::TrainingStats { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!(stats)))
}

pub(super) async fn export(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let dataset = state
        .db
        .request(move |reply| DbCommand::TrainingExport { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let classes: Vec<String> = dataset
        .iter()
        .flat_map(|(_, _, _, anns)| anns.iter().map(|a| a.class_label.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let class_index: std::collections::HashMap<&str, usize> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
        .collect();

    let mut files = Vec::new();
    for (filename, _w, _h, annotations) in &dataset {
        let label_filename = filename.replace(".nv12", ".txt");
        let lines: Vec<String> = annotations
            .iter()
            .filter_map(|a| {
                class_index.get(a.class_label.as_str()).map(|&idx| {
                    format!(
                        "{} {:.6} {:.6} {:.6} {:.6}",
                        idx, a.x_center, a.y_center, a.width, a.height
                    )
                })
            })
            .collect();
        files.push(serde_json::json!({
            "image": filename,
            "label_file": label_filename,
            "labels": lines,
        }));
    }

    Ok(Json(serde_json::json!({
        "total_frames": dataset.len(),
        "total_annotations": dataset.iter().map(|(_, _, _, a)| a.len()).sum::<usize>(),
        "classes": classes,
        "files": files,
    })))
}

pub(super) async fn classes(
    State(state): State<Arc<TrainingState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stats = state
        .db
        .request(move |reply| DbCommand::TrainingStats { reply })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let classes: Vec<&str> = stats
        .class_counts
        .iter()
        .map(|c| c.class_label.as_str())
        .collect();

    Ok(Json(serde_json::json!({"classes": classes})))
}
