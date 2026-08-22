use crate::application::db_thread::Database;
use axum::Router;
use axum::routing::{delete, get, post, put};
use std::path::PathBuf;
use std::sync::Arc;

mod annotations;
mod background;
mod frames;

#[derive(Clone)]
pub struct TrainingState {
    pub db: Database,
    pub ssh_host: String,
    pub remote_dir: String,
    pub cache_dir: PathBuf,
    /// Path to SSH identity file (e.g. /home/admin-user/.ssh/id_ed25519).
    /// When set, passed as `-i <key>` to ssh/scp. Required when the service
    /// runs as a user (e.g. root) that has no key for the remote host.
    pub ssh_key: Option<String>,
}

pub fn router(state: TrainingState) -> Router {
    Router::new()
        .route("/api/training/sync", post(frames::sync))
        .route("/api/training/frames", get(frames::list))
        .route("/api/training/frames/{id}", get(frames::get))
        .route(
            "/api/training/frames/{id}/status",
            put(frames::update_status),
        )
        .route("/api/training/frames/{id}/image", get(frames::image))
        .route(
            "/api/training/frames/{id}/annotations",
            get(annotations::list).put(annotations::replace),
        )
        .route(
            "/api/training/annotations/{id}",
            delete(annotations::delete),
        )
        .route("/api/training/cleanup", post(frames::cleanup))
        .route("/api/training/stats", get(annotations::stats))
        .route("/api/training/export", get(annotations::export))
        .route("/api/training/classes", get(annotations::classes))
        .route(
            "/api/training/frames/{id}/bg_ref",
            put(background::set_ref),
        )
        .route("/api/training/bg/status", get(background::status))
        .route("/api/training/bg/build", post(background::build))
        .route("/api/training/bg/score", post(background::score))
        .route("/api/training/bg/reject", post(background::reject))
        .with_state(Arc::new(state))
}

#[cfg(test)]
mod tests;

