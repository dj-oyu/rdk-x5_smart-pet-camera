use crate::application::{EventQueries, ObservationCommands, PetEvent, SharedEventRepository};
use std::path::{Path, PathBuf};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppContext {
    repository: SharedEventRepository,
    photos_dir: PathBuf,
    event_tx: broadcast::Sender<PetEvent>,
}

impl AppContext {
    pub fn new(
        repository: SharedEventRepository,
        photos_dir: PathBuf,
        event_tx: broadcast::Sender<PetEvent>,
    ) -> Self {
        Self {
            repository,
            photos_dir,
            event_tx,
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

    pub fn subscribe(&self) -> broadcast::Receiver<PetEvent> {
        self.event_tx.subscribe()
    }
}
