use crate::application::{EventQueries, ObservationCommands, PetEvent, SharedEventRepository};
use crate::vlm::VlmConfig;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Semaphore, broadcast};

#[derive(Clone)]
pub struct AppContext {
    repository: SharedEventRepository,
    photos_dir: PathBuf,
    event_tx: broadcast::Sender<PetEvent>,
    base_url: Option<String>,
    is_tls: bool,
    vlm_config: VlmConfig,
    vlm_semaphore: Arc<Semaphore>,
}

impl AppContext {
    pub fn new(
        repository: SharedEventRepository,
        photos_dir: PathBuf,
        event_tx: broadcast::Sender<PetEvent>,
        base_url: Option<String>,
        is_tls: bool,
        vlm_config: VlmConfig,
    ) -> Self {
        Self {
            repository,
            photos_dir,
            event_tx,
            base_url,
            is_tls,
            vlm_config,
            vlm_semaphore: Arc::new(Semaphore::new(1)),
        }
    }

    pub fn observation_commands(&self) -> ObservationCommands {
        ObservationCommands::new(self.repository.clone(), self.event_tx.clone())
    }

    pub fn event_queries(&self) -> EventQueries {
        EventQueries::new(self.repository.clone())
    }

    pub fn photos_dir(&self) -> &Path {
        &self.photos_dir
    }

    pub fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    pub fn is_tls(&self) -> bool {
        self.is_tls
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PetEvent> {
        self.event_tx.subscribe()
    }

    pub fn repository(&self) -> &SharedEventRepository {
        &self.repository
    }

    pub fn vlm_config(&self) -> VlmConfig {
        self.vlm_config.clone()
    }

    pub fn vlm_semaphore(&self) -> &Arc<Semaphore> {
        &self.vlm_semaphore
    }

    /// Notify listeners that detections were added for a photo.
    /// Bridges to SSE via PetEvent → PhotoEvent::Update.
    pub fn notify_detection_complete(&self, source_filename: &str, pet_id: Option<String>) {
        let _ = self.event_tx.send(PetEvent {
            source_filename: source_filename.to_string(),
            is_valid: true,
            summary: String::new(),
            behavior: String::new(),
            pet_id,
        });
    }
}
