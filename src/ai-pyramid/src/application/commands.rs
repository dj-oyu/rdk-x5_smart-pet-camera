use crate::application::{
    AppResult, ObservationInput, ObservationResult, PetEvent, SharedEventRepository,
};
use crate::db::DetectionInput;
use chrono::NaiveDateTime;
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
        Self {
            repository,
            event_tx,
        }
    }

    pub async fn ingest_source_photo(&self, input: ObservationInput) -> AppResult<i64> {
        let id = self
            .repository
            .store_source_photo(
                &input.source_filename,
                input.captured_at,
                input.pet_id.as_deref(),
            )
            .await?;
        let _ = self.event_tx.send(PetEvent {
            source_filename: input.source_filename,
            is_valid: false,
            summary: String::new(),
            behavior: String::new(),
            pet_id: input.pet_id,
        });
        Ok(id)
    }

    pub async fn apply_observation(
        &self,
        result: ObservationResult,
    ) -> AppResult<Option<PetEvent>> {
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

    pub async fn override_event_validity(
        &self,
        source_filename: &str,
        is_valid: bool,
    ) -> AppResult<bool> {
        let updated = self
            .repository
            .override_event_validity(source_filename, is_valid)
            .await?;
        Ok(updated > 0)
    }

    pub async fn record_observation_failure(
        &self,
        source_filename: &str,
        error: &str,
    ) -> AppResult<usize> {
        self.repository
            .record_observation_failure(source_filename, error)
            .await
    }

    pub async fn ingest_with_detections(
        &self,
        source_filename: &str,
        captured_at: NaiveDateTime,
        pet_id: Option<&str>,
        detections: &[DetectionInput],
    ) -> AppResult<i64> {
        self.repository
            .ingest_with_detections(source_filename, captured_at, pet_id, detections)
            .await
    }

    pub async fn update_detection_override(
        &self,
        detection_id: i64,
        pet_id: &str,
    ) -> AppResult<usize> {
        self.repository
            .update_detection_override(detection_id, pet_id)
            .await
    }

    pub async fn update_pet_id(&self, source_filename: &str, pet_id: &str) -> AppResult<usize> {
        self.repository.update_pet_id(source_filename, pet_id).await
    }

    pub async fn update_behavior(&self, source_filename: &str, behavior: &str) -> AppResult<usize> {
        self.repository
            .update_behavior(source_filename, behavior)
            .await
    }
}
