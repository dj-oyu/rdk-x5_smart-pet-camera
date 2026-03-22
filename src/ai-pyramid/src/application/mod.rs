mod commands;
mod context;
mod db_thread;
mod event;
mod model;
mod queries;
mod repository;

pub use commands::ObservationCommands;
pub use context::AppContext;
pub use event::PetEvent;
pub use model::{ActivityStats, EventQuery, EventStatus, EventStatusFilter, EventSummary, ObservationInput, ObservationResult};
pub use queries::EventQueries;
pub use repository::{EventRepositoryPort, PhotoStoreRepository, SharedEventRepository};

pub type AppResult<T> = Result<T, String>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::PhotoStore;
    use chrono::{NaiveDate, NaiveDateTime};
    use std::path::PathBuf;
    use tokio::sync::broadcast;

    fn dt(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, s)
            .unwrap()
    }

    fn test_context() -> AppContext {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let repository = PhotoStoreRepository::shared(store);
        let (event_tx, _) = broadcast::channel(16);
        AppContext::new(repository, PathBuf::from("data/photos"), event_tx, None, false)
    }

    #[tokio::test]
    async fn override_event_validity_does_not_increment_observation_attempts() {
        let context = test_context();
        let commands = context.observation_commands();
        let queries = context.event_queries();

        commands
            .ingest_source_photo(ObservationInput {
                source_filename: "comic_test.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 0, 0),
                pet_id: None,
            })
            .await
            .unwrap();
        commands
            .record_observation_failure("comic_test.jpg", "timeout")
            .await
            .unwrap();

        let before = queries.get_observation_attempts("comic_test.jpg").await.unwrap().unwrap();
        let updated = commands
            .override_event_validity("comic_test.jpg", true)
            .await
            .unwrap();
        let after = queries.get_observation_attempts("comic_test.jpg").await.unwrap().unwrap();
        let event = queries.get_event_by_source("comic_test.jpg").await.unwrap().unwrap();

        assert!(updated);
        assert_eq!(before, 1);
        assert_eq!(after, 1);
        assert_eq!(event.status, EventStatus::Valid);
        assert_eq!(event.summary, None);
        assert_eq!(event.behavior, None);
    }

    #[tokio::test]
    async fn apply_observation_publishes_pet_event() {
        let context = test_context();
        let commands = context.observation_commands();
        let mut rx = context.subscribe();

        commands
            .ingest_source_photo(ObservationInput {
                source_filename: "comic_20260321_104532_chatora.jpg".into(),
                captured_at: dt(2026, 3, 21, 10, 45, 32),
                pet_id: Some("chatora".into()),
            })
            .await
            .unwrap();

        let event = commands
            .apply_observation(ObservationResult {
                source_filename: "comic_20260321_104532_chatora.jpg".into(),
                is_valid: true,
                summary: "A tabby cat resting".into(),
                behavior: "resting".into(),
            })
            .await
            .unwrap()
            .unwrap();
        let received = rx.try_recv().unwrap();

        assert_eq!(event.source_filename, "comic_20260321_104532_chatora.jpg");
        assert_eq!(event.pet_id.as_deref(), Some("chatora"));
        assert_eq!(received.source_filename, event.source_filename);
        assert_eq!(received.summary, event.summary);
    }
}
