use crate::application::{
    ActivityStats, AppResult, EventQuery, EventSummary, SharedEventRepository,
};
use crate::db::{Detection, EditHistoryEntry};

#[derive(Clone)]
pub struct EventQueries {
    repository: SharedEventRepository,
}

impl EventQueries {
    pub(crate) fn new(repository: SharedEventRepository) -> Self {
        Self { repository }
    }

    pub async fn get_event_by_source(
        &self,
        source_filename: &str,
    ) -> AppResult<Option<EventSummary>> {
        self.repository.get_event_by_source(source_filename).await
    }

    pub async fn get_event_by_id(&self, id: i64) -> AppResult<Option<EventSummary>> {
        self.repository.get_event_by_id(id).await
    }

    pub async fn list_events(&self, query: EventQuery) -> AppResult<(Vec<EventSummary>, i64)> {
        self.repository.list_events(query).await
    }

    pub async fn list_pending_sources(&self, max_attempts: i32) -> AppResult<Vec<String>> {
        self.repository.list_pending_sources(max_attempts).await
    }

    pub async fn activity_stats(&self) -> AppResult<ActivityStats> {
        self.repository.activity_stats().await
    }

    pub async fn get_observation_attempts(&self, source_filename: &str) -> AppResult<Option<i32>> {
        self.repository
            .get_observation_attempts(source_filename)
            .await
    }

    pub async fn get_detections(&self, photo_id: i64) -> AppResult<Vec<Detection>> {
        self.repository.get_detections(photo_id).await
    }

    pub async fn get_edit_history(&self, since: Option<&str>) -> AppResult<Vec<EditHistoryEntry>> {
        self.repository.get_edit_history(since).await
    }

    pub async fn distinct_pet_ids(&self) -> AppResult<Vec<String>> {
        self.repository.distinct_pet_ids().await
    }

    pub async fn distinct_behaviors(&self) -> AppResult<Vec<String>> {
        self.repository.distinct_behaviors().await
    }

    pub async fn captions_for_date(&self, date: &str) -> AppResult<Vec<String>> {
        self.repository.captions_for_date(date).await
    }

    pub async fn list_photos_without_detections(&self, limit: i64) -> AppResult<Vec<EventSummary>> {
        self.repository.list_photos_without_detections(limit).await
    }
}
