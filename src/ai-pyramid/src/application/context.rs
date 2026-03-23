use crate::application::{EventQueries, ObservationCommands, PetEvent, SharedEventRepository};
use std::path::{Path, PathBuf};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppContext {
    repository: SharedEventRepository,
    photos_dir: PathBuf,
    event_tx: broadcast::Sender<PetEvent>,
    base_url: Option<String>,
    is_tls: bool,
}

impl AppContext {
    pub fn new(
        repository: SharedEventRepository,
        photos_dir: PathBuf,
        event_tx: broadcast::Sender<PetEvent>,
        base_url: Option<String>,
        is_tls: bool,
    ) -> Self {
        Self {
            repository,
            photos_dir,
            event_tx,
            base_url,
            is_tls,
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
}
