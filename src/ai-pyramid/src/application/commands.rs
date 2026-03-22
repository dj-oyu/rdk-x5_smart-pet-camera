use crate::application::{AppResult, ObservationInput, ObservationResult, PetEvent, SharedEventRepository};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct ObservationCommands {
    repository: SharedEventRepository,
    event_tx: broadcast::Sender<PetEvent>,
}

impl ObservationCommands {
    pub(crate) fn new(
        repository: SharedEventRepository,
        event_tx: broadcast::Sender<PetEvent>,
    ) -> Self {
        Self { repository, event_tx }
    }

    pub async fn ingest_source_photo(&self, input: ObservationInput) -> AppResult<i64> {
        self.repository
            .store_source_photo(&input.source_filename, input.captured_at, input.pet_id.as_deref())
            .await
    }

    pub async fn apply_observation(&self, result: ObservationResult) -> AppResult<Option<PetEvent>> {
        self.repository
            .apply_observation(
                &result.source_filename,
                result.is_valid,
                &result.summary,
                &result.behavior,
            )
            .await?;
        let pet_id = self
            .repository
            .get_event_by_source(&result.source_filename)
            .await?
            .and_then(|event| event.pet_id);
        let event = PetEvent {
            source_filename: result.source_filename,
            is_valid: result.is_valid,
            summary: result.summary,
            behavior: result.behavior,
            pet_id,
        };
        let _ = self.event_tx.send(event.clone());
        Ok(Some(event))
    }

    pub async fn override_event_validity(&self, source_filename: &str, is_valid: bool) -> AppResult<bool> {
        let updated = self
            .repository
            .override_event_validity(source_filename, is_valid)
            .await?;
        Ok(updated > 0)
    }

    pub async fn record_observation_failure(&self, source_filename: &str, error: &str) -> AppResult<usize> {
        self.repository.record_observation_failure(source_filename, error).await
    }
}
