use crate::application::{AppContext, ObservationInput, ObservationResult};
use crate::detect::DetectClient;
use crate::detect::local::LocalDetector;
use crate::ingest::filename::parse_comic_filename;
use crate::vlm::{VlmClient, VlmConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

const MAX_VLM_ATTEMPTS: i32 = 5;
const RESCAN_INTERVAL: Duration = Duration::from_secs(300);
const FILE_STABLE_DELAY: Duration = Duration::from_millis(500);
const FILE_STABLE_MAX_RETRIES: u32 = 3;

pub struct PhotoWatcher {
    app: AppContext,
    vlm_config: VlmConfig,
    detect_client: Option<Arc<DetectClient>>,
    local_detector: Option<Arc<LocalDetector>>,
}

impl PhotoWatcher {
    pub fn new(
        app: AppContext,
        vlm_config: VlmConfig,
        detect_client: Option<Arc<DetectClient>>,
        local_detector: Option<Arc<LocalDetector>>,
    ) -> Self {
        Self {
            app,
            vlm_config,
            detect_client,
            local_detector,
        }
    }

    async fn initial_scan(&self) {
        let entries = match std::fs::read_dir(self.app.photos_dir()) {
            Ok(entries) => entries,
            Err(error) => {
                warn!(
                    "Cannot read photos dir {}: {error}",
                    self.app.photos_dir().display()
                );
                return;
            }
        };

        let commands = self.app.observation_commands();
        let queries = self.app.event_queries();
        let mut count = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_jpeg(&name) {
                continue;
            }
            if let Ok(meta) = parse_comic_filename(&name)
                && queries
                    .get_event_by_source(&name)
                    .await
                    .ok()
                    .flatten()
                    .is_none()
                && commands
                    .ingest_source_photo(ObservationInput {
                        source_filename: name.clone(),
                        captured_at: meta.captured_at,
                        pet_id: meta.pet_id,
                    })
                    .await
                    .is_ok()
            {
                count += 1;
            }
        }
        info!("Initial scan: inserted {count} new source photos");
    }

    async fn queue_pending(&self, tx: &mpsc::Sender<String>) {
        let queries = self.app.event_queries();
        match queries.list_pending_sources(MAX_VLM_ATTEMPTS).await {
            Ok(names) => {
                if !names.is_empty() {
                    info!(
                        "Rescan: {} pending sources queued for observation",
                        names.len()
                    );
                }
                for name in names {
                    let _ = tx.try_send(name);
                }
            }
            Err(error) => warn!("Failed to query pending sources: {error}"),
        }
    }

    pub async fn run(self) {
        let (tx, mut rx) = mpsc::channel::<String>(64);

        self.initial_scan().await;
        self.queue_pending(&tx).await;

        let tx_for_watcher = tx.clone();
        let app_for_watcher = self.app.clone();
        let photos_dir_for_watcher = self.app.photos_dir().to_path_buf();

        let _watcher = {
            let (notify_tx, mut notify_rx) = mpsc::channel(64);

            let mut watcher = RecommendedWatcher::new(
                move |res: Result<Event, notify::Error>| {
                    if let Ok(event) = res {
                        let _ = notify_tx.blocking_send(event);
                    }
                },
                notify::Config::default(),
            )
            .expect("failed to create filesystem watcher");

            watcher
                .watch(&photos_dir_for_watcher, RecursiveMode::NonRecursive)
                .expect("failed to watch photos directory");

            let tx = tx_for_watcher;
            let photos_dir = photos_dir_for_watcher.clone();
            tokio::spawn(async move {
                let commands = app_for_watcher.observation_commands();
                let queries = app_for_watcher.event_queries();
                while let Some(event) = notify_rx.recv().await {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for path in event.paths {
                        let name = match path.file_name() {
                            Some(name) => name.to_string_lossy().to_string(),
                            None => continue,
                        };
                        if !is_jpeg(&name) {
                            continue;
                        }

                        let full_path = photos_dir.join(&name);
                        if !wait_file_stable(&full_path).await {
                            warn!("File not stable, skipping: {name}");
                            continue;
                        }

                        let meta = match parse_comic_filename(&name) {
                            Ok(meta) => meta,
                            Err(error) => {
                                warn!("Skipping {name}: {error}");
                                continue;
                            }
                        };
                        if queries
                            .get_event_by_source(&name)
                            .await
                            .ok()
                            .flatten()
                            .is_none()
                        {
                            match commands
                                .ingest_source_photo(ObservationInput {
                                    source_filename: name.clone(),
                                    captured_at: meta.captured_at,
                                    pet_id: meta.pet_id,
                                })
                                .await
                            {
                                Ok(_) => info!("New source photo: {name}"),
                                Err(error) => {
                                    warn!("DB insert {name}: {error}");
                                    continue;
                                }
                            }
                        }
                        let _ = tx.send(name).await;
                    }
                }
            });

            watcher
        };

        let vlm_client = VlmClient::new(self.vlm_config);
        let photos_dir = self.app.photos_dir().to_path_buf();
        let tx_for_rescan = tx.clone();
        let app_for_rescan = self.app.clone();
        let commands = self.app.observation_commands();
        let vlm_semaphore = self.app.vlm_semaphore().clone();

        tokio::spawn(async move {
            let queries = app_for_rescan.event_queries();
            loop {
                tokio::time::sleep(RESCAN_INTERVAL).await;
                if let Ok(names) = queries.list_pending_sources(MAX_VLM_ATTEMPTS).await
                    && !names.is_empty()
                {
                    info!("Periodic rescan: {} pending sources", names.len());
                    for name in names {
                        let _ = tx_for_rescan.try_send(name);
                    }
                }
            }
        });

        while let Some(filename) = rx.recv().await {
            let jpeg_path = photos_dir.join(&filename);
            if !jpeg_path.exists() {
                // Source jpeg was deleted (e.g. by GC) after its DB row was
                // created. Bump vlm_attempts so the row eventually drops out of
                // the pending set instead of being re-queued forever every
                // rescan. A few retries still tolerate a transient race.
                warn!("Observation source missing {filename}");
                let _ = commands
                    .record_observation_failure(&filename, "source file missing on disk")
                    .await;
                continue;
            }

            info!("Observing source photo: {filename}");
            let _permit = vlm_semaphore.acquire().await.unwrap();
            match vlm_client.analyze(&jpeg_path).await {
                Ok(response) => {
                    if let Err(error) = commands
                        .apply_observation(ObservationResult {
                            source_filename: filename.clone(),
                            is_valid: response.is_valid,
                            summary: response.caption,
                            behavior: response.behavior,
                        })
                        .await
                    {
                        error!("DB update {filename}: {error}");
                    } else {
                        info!("Observation done: {filename}");
                    }
                }
                Err(error) => {
                    error!("Observation error for {filename}: {error}");
                    let _ = commands.record_observation_failure(&filename, &error).await;
                }
            }

            // Run YOLO detection: try remote (rdk-x5), fallback to local daemon
            let dets = if let Some(ref detect_client) = self.detect_client {
                match detect_client.detect(&filename).await {
                    Ok(dets) if !dets.is_empty() => {
                        info!("Remote detection: {filename} ({} dets)", dets.len());
                        Some(dets)
                    }
                    Ok(_) => {
                        info!("Remote detection: {filename} (0 dets)");
                        None
                    }
                    Err(e) => {
                        warn!("Remote detection failed for {filename}: {e}");
                        // Fallback to local detector
                        if let Some(ref ld) = self.local_detector {
                            match ld.detect_comic(&photos_dir, &filename).await {
                                Ok(dets) if !dets.is_empty() => {
                                    info!(
                                        "Local fallback detection: {filename} ({} dets)",
                                        dets.len()
                                    );
                                    Some(dets)
                                }
                                Ok(_) => None,
                                Err(e2) => {
                                    warn!("Local fallback also failed for {filename}: {e2}");
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    }
                }
            } else if let Some(ref ld) = self.local_detector {
                // No remote client configured — use local directly
                match ld.detect_comic(&photos_dir, &filename).await {
                    Ok(dets) if !dets.is_empty() => {
                        info!("Local detection: {filename} ({} dets)", dets.len());
                        Some(dets)
                    }
                    Ok(_) => None,
                    Err(e) => {
                        warn!("Local detection failed for {filename}: {e}");
                        None
                    }
                }
            } else {
                None
            };

            if let Some(dets) = dets
                && let Ok(meta) = parse_comic_filename(&filename)
            {
                let _ = commands
                    .ingest_with_detections(
                        &filename,
                        meta.captured_at,
                        meta.pet_id.as_deref(),
                        &dets,
                    )
                    .await;
                self.app
                    .notify_detection_complete(&filename, meta.pet_id.clone());
            }
        }
    }
}

fn is_jpeg(name: &str) -> bool {
    name.ends_with(".jpg") || name.ends_with(".JPG") || name.ends_with(".jpeg")
}

async fn wait_file_stable(path: &Path) -> bool {
    for _ in 0..FILE_STABLE_MAX_RETRIES {
        let size1 = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        if size1 == 0 {
            return false;
        }
        tokio::time::sleep(FILE_STABLE_DELAY).await;
        let size2 = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        if size1 == size2 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{ObservationInput, PhotoStoreRepository};
    use crate::db::PhotoStore;
    use chrono::NaiveDate;
    use tokio::sync::broadcast;

    fn test_watcher(photos_dir: &Path) -> PhotoWatcher {
        let store = PhotoStore::open_in_memory().unwrap();
        store.migrate().unwrap();
        let (repository, _db) = PhotoStoreRepository::shared(store);
        let (event_tx, _) = broadcast::channel(16);
        let app = AppContext::new(
            repository,
            photos_dir.to_path_buf(),
            event_tx,
            None,
            false,
            VlmConfig::default(),
            None,
        );
        PhotoWatcher::new(app, VlmConfig::default(), None, None)
    }

    fn observed_at(hour: u32) -> chrono::DateTime<chrono::Utc> {
        crate::timestamps::from_camera_local(
            NaiveDate::from_ymd_opt(2026, 3, 21)
                .unwrap()
                .and_hms_opt(hour, 0, 0)
                .unwrap(),
        )
    }

    #[test]
    fn jpeg_filter_matches_supported_extensions() {
        assert!(is_jpeg("comic.jpg"));
        assert!(is_jpeg("comic.JPG"));
        assert!(is_jpeg("comic.jpeg"));
        assert!(!is_jpeg("comic.JPEG"));
        assert!(!is_jpeg("comic.png"));
        assert!(!is_jpeg("comic.jpg.tmp"));
    }

    #[tokio::test]
    async fn initial_scan_ingests_only_valid_comic_filenames() {
        let photos = tempfile::tempdir().unwrap();
        std::fs::write(
            photos.path().join("comic_20260321_100000_mike.jpg"),
            b"jpeg",
        )
        .unwrap();
        std::fs::write(
            photos.path().join("comic_20260321_110000_chatora.JPG"),
            b"jpeg",
        )
        .unwrap();
        std::fs::write(photos.path().join("not-a-comic.jpg"), b"jpeg").unwrap();
        std::fs::write(photos.path().join("comic_20260321_120000_mike.png"), b"png").unwrap();

        let watcher = test_watcher(photos.path());
        watcher.initial_scan().await;
        let queries = watcher.app.event_queries();

        assert!(
            queries
                .get_event_by_source("comic_20260321_100000_mike.jpg")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            queries
                .get_event_by_source("comic_20260321_110000_chatora.JPG")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            queries
                .get_event_by_source("not-a-comic.jpg")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn queue_pending_excludes_sources_at_retry_limit() {
        let photos = tempfile::tempdir().unwrap();
        let watcher = test_watcher(photos.path());
        let commands = watcher.app.observation_commands();

        for (filename, hour) in [("retry.jpg", 10), ("ready.jpg", 11)] {
            commands
                .ingest_source_photo(ObservationInput {
                    source_filename: filename.to_string(),
                    captured_at: observed_at(hour),
                    pet_id: None,
                })
                .await
                .unwrap();
        }
        for _ in 0..MAX_VLM_ATTEMPTS {
            commands
                .record_observation_failure("retry.jpg", "source missing")
                .await
                .unwrap();
        }

        let (tx, mut rx) = mpsc::channel(4);
        watcher.queue_pending(&tx).await;

        let queued = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("pending source was not queued");
        assert_eq!(queued.as_deref(), Some("ready.jpg"));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn stable_file_check_rejects_missing_and_empty_files() {
        let photos = tempfile::tempdir().unwrap();
        let missing = photos.path().join("missing.jpg");
        let empty = photos.path().join("empty.jpg");
        std::fs::write(&empty, b"").unwrap();

        assert!(!wait_file_stable(&missing).await);
        assert!(!wait_file_stable(&empty).await);
    }

    #[tokio::test]
    async fn stable_file_check_accepts_unchanged_nonempty_file() {
        let photos = tempfile::tempdir().unwrap();
        let image = photos.path().join("stable.jpg");
        std::fs::write(&image, b"complete jpeg payload").unwrap();

        assert!(wait_file_stable(&image).await);
    }
}
