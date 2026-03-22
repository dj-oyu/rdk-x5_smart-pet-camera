use crate::application::{ActivityStats, AppResult, EventQuery, EventSummary, SharedEventRepository};

#[derive(Clone)]
pub struct EventQueries {
    repository: SharedEventRepository,
}

impl EventQueries {
    pub(crate) fn new(repository: SharedEventRepository) -> Self {
        Self { repository }
    }

    pub async fn get_event_by_source(&self, source_filename: &str) -> AppResult<Option<EventSummary>> {
        self.repository.get_event_by_source(source_filename).await
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
        self.repository.get_observation_attempts(source_filename).await
    }
}
