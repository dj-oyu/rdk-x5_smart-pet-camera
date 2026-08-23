use crate::application::{AppContext, ObservationInput, ObservationResult};
use crate::detect::DetectClient;
use crate::detect::local::LocalDetector;
use crate::ingest::filename::parse_comic_filename;
use crate::vlm::{VlmClient, VlmConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

const MAX_VLM_ATTEMPTS: i32 = 5;
const RESCAN_INTERVAL: Duration = Duration::from_secs(300);
const FILE_STABLE_DELAY: Duration = Duration::from_millis(500);
const FILE_STABLE_MAX_RETRIES: u32 = 3;

/// Photos already queued for observation.
///
/// One comic reaches the queue from three directions: the filesystem watcher
/// (which sees both `Create` and `Modify` for a single file comic-sync writes),
/// the startup scan, and the periodic rescan. Without this set the same photo
/// was captioned twice — a second pass over the exclusive NPU, ~5-6s each, and
/// the later caption silently overwrote the earlier one (issue #242).
#[derive(Clone, Default)]
struct InFlight(Arc<Mutex<HashSet<String>>>);

impl InFlight {
    /// Take ownership of a name. `false` means it is already queued.
    fn claim(&self, name: &str) -> bool {
        self.lock().insert(name.to_string())
    }

    fn release(&self, name: &str) {
        self.lock().remove(name);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        // Nothing panics while holding this lock — it is only ever a set
        // insert or remove — so poisoning would mean a bug elsewhere.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Releases a claim once the observation finishes, however it ends.
struct Claimed {
    in_flight: InFlight,
    name: String,
}

impl Drop for Claimed {
    fn drop(&mut self) {
        self.in_flight.release(&self.name);
    }
}

/// Hand a name to the observation queue, unless it is already waiting.
async fn enqueue(in_flight: &InFlight, tx: &mpsc::Sender<String>, name: String) {
    if !in_flight.claim(&name) {
        return;
    }
    if tx.send(name.clone()).await.is_err() {
        in_flight.release(&name);
    }
}

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

    async fn queue_pending(&self, tx: &mpsc::Sender<String>, in_flight: &InFlight) {
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
                    enqueue(in_flight, tx, name).await;
                }
            }
            Err(error) => warn!("Failed to query pending sources: {error}"),
        }
    }

    pub async fn run(self) {
        let (tx, mut rx) = mpsc::channel::<String>(64);

        let in_flight = InFlight::default();

        self.initial_scan().await;
        self.queue_pending(&tx, &in_flight).await;

        let tx_for_watcher = tx.clone();
        let in_flight_for_watcher = in_flight.clone();
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
            let in_flight = in_flight_for_watcher;
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
                        enqueue(&in_flight, &tx, name).await;
                    }
                }
            });

            watcher
        };

        let vlm_client = VlmClient::new(self.vlm_config);
        let photos_dir = self.app.photos_dir().to_path_buf();
        let tx_for_rescan = tx.clone();
        let in_flight_for_rescan = in_flight.clone();
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
                        enqueue(&in_flight_for_rescan, &tx_for_rescan, name).await;
                    }
                }
            }
        });

        while let Some(filename) = rx.recv().await {
            // Held for the whole observation — including the detection pass
            // below — so a re-notified file cannot jump the queue mid-flight.
            let _claimed = Claimed {
                in_flight: in_flight.clone(),
                name: filename.clone(),
            };
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

    #[tokio::test]
    async fn a_photo_is_queued_once_until_it_is_observed() {
        // comic-sync writing one file emits Create and Modify; the rescan may
        // also see it. Only the first should reach the observation loop.
        let in_flight = InFlight::default();
        let (tx, mut rx) = mpsc::channel::<String>(8);

        enqueue(&in_flight, &tx, "comic_20260321_100000_mike.jpg".into()).await;
        enqueue(&in_flight, &tx, "comic_20260321_100000_mike.jpg".into()).await;
        enqueue(&in_flight, &tx, "comic_20260321_110000_mike.jpg".into()).await;

        assert_eq!(rx.recv().await.unwrap(), "comic_20260321_100000_mike.jpg");
        assert_eq!(rx.recv().await.unwrap(), "comic_20260321_110000_mike.jpg");
        assert!(rx.try_recv().is_err(), "the duplicate must not be queued");
    }

    #[tokio::test]
    async fn a_photo_can_be_queued_again_after_release() {
        // A retry after a failed observation still has to get through.
        let in_flight = InFlight::default();
        let (tx, mut rx) = mpsc::channel::<String>(8);
        let name = "comic_20260321_100000_mike.jpg";

        enqueue(&in_flight, &tx, name.into()).await;
        rx.recv().await.unwrap();
        drop(Claimed {
            in_flight: in_flight.clone(),
            name: name.to_string(),
        });

        enqueue(&in_flight, &tx, name.into()).await;
        assert_eq!(rx.recv().await.unwrap(), name);
    }

    #[tokio::test]
    async fn a_claim_is_released_when_the_queue_is_gone() {
        // If the send fails the name must not stay claimed forever.
        let in_flight = InFlight::default();
        let (tx, rx) = mpsc::channel::<String>(1);
        drop(rx);

        enqueue(&in_flight, &tx, "comic_20260321_100000_mike.jpg".into()).await;

        assert!(
            in_flight.claim("comic_20260321_100000_mike.jpg"),
            "a failed send must leave the name claimable"
        );
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
