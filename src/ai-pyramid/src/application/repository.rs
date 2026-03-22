use crate::application::db_thread::{Database, DbCommand};
use crate::application::{ActivityStats, AppResult, EventQuery, EventSummary};
use crate::db::PhotoStore;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use std::sync::Arc;

#[async_trait]
pub trait EventRepositoryPort: Send + Sync {
    async fn store_source_photo(
        &self,
        source_filename: &str,
        captured_at: NaiveDateTime,
        pet_id: Option<&str>,
    ) -> AppResult<i64>;
    async fn get_event_by_source(&self, source_filename: &str) -> AppResult<Option<EventSummary>>;
    async fn get_event_by_id(&self, id: i64) -> AppResult<Option<EventSummary>>;
    async fn list_events(&self, query: EventQuery) -> AppResult<(Vec<EventSummary>, i64)>;
    async fn list_pending_sources(&self, max_attempts: i32) -> AppResult<Vec<String>>;
    async fn apply_observation(
        &self,
        source_filename: &str,
        is_valid: bool,
        summary: &str,
        behavior: &str,
    ) -> AppResult<usize>;
    async fn override_event_validity(&self, source_filename: &str, is_valid: bool) -> AppResult<usize>;
    async fn record_observation_failure(&self, source_filename: &str, error: &str) -> AppResult<usize>;
    async fn activity_stats(&self) -> AppResult<ActivityStats>;
    async fn get_observation_attempts(&self, source_filename: &str) -> AppResult<Option<i32>>;
}

pub type SharedEventRepository = Arc<dyn EventRepositoryPort>;

pub struct PhotoStoreRepository {
    db: Database,
}

impl PhotoStoreRepository {
    pub fn new(store: PhotoStore) -> Self {
        Self {
            db: Database::new(store),
        }
    }

    pub fn shared(store: PhotoStore) -> SharedEventRepository {
        Arc::new(Self::new(store))
    }
}

#[async_trait]
impl EventRepositoryPort for PhotoStoreRepository {
    async fn store_source_photo(
        &self,
        source_filename: &str,
        captured_at: NaiveDateTime,
        pet_id: Option<&str>,
    ) -> AppResult<i64> {
        self.db
            .request(|reply| DbCommand::InsertPhoto {
                filename: source_filename.to_string(),
                captured_at,
                pet_id: pet_id.map(str::to_string),
                reply,
            })
            .await
    }

    async fn get_event_by_source(&self, source_filename: &str) -> AppResult<Option<EventSummary>> {
        self.db
            .request(|reply| DbCommand::GetPhoto {
                filename: source_filename.to_string(),
                reply,
            })
            .await
            .map(|photo| photo.map(EventSummary::from))
    }

    async fn get_event_by_id(&self, id: i64) -> AppResult<Option<EventSummary>> {
        self.db
            .request(|reply| DbCommand::GetPhotoById { id, reply })
            .await
            .map(|photo| photo.map(EventSummary::from))
    }

    async fn list_events(&self, query: EventQuery) -> AppResult<(Vec<EventSummary>, i64)> {
        self.db
            .request(|reply| DbCommand::ListPhotos {
                filter: query.to_photo_filter(),
                reply,
            })
            .await
            .map(|(photos, total)| (photos.into_iter().map(EventSummary::from).collect(), total))
    }

    async fn list_pending_sources(&self, max_attempts: i32) -> AppResult<Vec<String>> {
        self.db
            .request(|reply| DbCommand::ListPendingFilenames {
                max_attempts,
                reply,
            })
            .await
    }

    async fn apply_observation(
        &self,
        source_filename: &str,
        is_valid: bool,
        summary: &str,
        behavior: &str,
    ) -> AppResult<usize> {
        self.db
            .request(|reply| DbCommand::ApplyVlmResult {
                filename: source_filename.to_string(),
                is_valid,
                caption: summary.to_string(),
                behavior: behavior.to_string(),
                reply,
            })
            .await
    }

    async fn override_event_validity(&self, source_filename: &str, is_valid: bool) -> AppResult<usize> {
        self.db
            .request(|reply| DbCommand::OverrideValidation {
                filename: source_filename.to_string(),
                is_valid,
                reply,
            })
            .await
    }

    async fn record_observation_failure(&self, source_filename: &str, error: &str) -> AppResult<usize> {
        self.db
            .request(|reply| DbCommand::RecordVlmFailure {
                filename: source_filename.to_string(),
                error: error.to_string(),
                reply,
            })
            .await
    }

    async fn activity_stats(&self) -> AppResult<ActivityStats> {
        self.db
            .request(|reply| DbCommand::Stats { reply })
            .await
            .map(ActivityStats::from)
    }

    async fn get_observation_attempts(&self, source_filename: &str) -> AppResult<Option<i32>> {
        self.db
            .request(|reply| DbCommand::GetVlmAttempts {
                filename: source_filename.to_string(),
                reply,
            })
            .await
    }
}
