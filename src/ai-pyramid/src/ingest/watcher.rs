use crate::db::PhotoStore;
use crate::ingest::filename::parse_comic_filename;
use crate::vlm::{VlmClient, VlmConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

const MAX_VLM_ATTEMPTS: i32 = 5;
const RESCAN_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes
const FILE_STABLE_DELAY: Duration = Duration::from_millis(500);
const FILE_STABLE_MAX_RETRIES: u32 = 3;

pub struct PhotoWatcher {
    photos_dir: PathBuf,
    store: Arc<Mutex<PhotoStore>>,
    vlm_config: VlmConfig,
}

impl PhotoWatcher {
    pub fn new(photos_dir: PathBuf, store: Arc<Mutex<PhotoStore>>, vlm_config: VlmConfig) -> Self {
        Self { photos_dir, store, vlm_config }
    }

    /// Scan existing files and insert any not yet in DB.
    fn initial_scan(&self) {
        let entries = match std::fs::read_dir(&self.photos_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!("Cannot read photos dir {}: {e}", self.photos_dir.display());
                return;
            }
        };

        let mut count = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_jpeg(&name) { continue; }
            if let Ok(meta) = parse_comic_filename(&name) {
                let store = self.store.lock().unwrap();
                if store.get_by_filename(&name).ok().flatten().is_none() {
                    let _ = store.insert(&name, meta.captured_at, meta.pet_id.as_deref());
                    count += 1;
                }
            }
        }
        info!("Initial scan: inserted {count} new files");
    }

    /// Query DB for pending files and send them to VLM queue.
    fn queue_pending(&self, tx: &mpsc::Sender<String>) {
        let store = self.store.lock().unwrap();
        match store.list_pending_filenames(MAX_VLM_ATTEMPTS) {
            Ok(names) => {
                if !names.is_empty() {
                    info!("Rescan: {} pending files queued for VLM", names.len());
                }
                for name in names {
                    let _ = tx.try_send(name);
                }
            }
            Err(e) => warn!("Failed to query pending: {e}"),
        }
    }

    pub async fn run(self) {
        let (tx, mut rx) = mpsc::channel::<String>(64);

        // Initial scan: insert new files, then queue all pending
        self.initial_scan();
        self.queue_pending(&tx);

        // Filesystem watcher
        let store_for_watcher = Arc::clone(&self.store);
        let tx_for_watcher = tx.clone();
        let photos_dir_for_watcher = self.photos_dir.clone();

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

            let store = Arc::clone(&store_for_watcher);
            let tx = tx_for_watcher;
            let photos_dir = photos_dir_for_watcher.clone();
            tokio::spawn(async move {
                while let Some(event) = notify_rx.recv().await {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        continue;
                    }
                    for path in event.paths {
                        let name = match path.file_name() {
                            Some(n) => n.to_string_lossy().to_string(),
                            None => continue,
                        };
                        if !is_jpeg(&name) { continue; }

                        // Wait for file to stabilize (rsync partial write protection)
                        let full_path = photos_dir.join(&name);
                        if !wait_file_stable(&full_path).await {
                            warn!("File not stable, skipping: {name}");
                            continue;
                        }

                        let meta = match parse_comic_filename(&name) {
                            Ok(m) => m,
                            Err(e) => { warn!("Skipping {name}: {e}"); continue; }
                        };
                        {
                            let s = store.lock().unwrap();
                            match s.insert(&name, meta.captured_at, meta.pet_id.as_deref()) {
                                Ok(_) => info!("New photo: {name}"),
                                Err(e) => { warn!("DB insert {name}: {e}"); continue; }
                            }
                        }
                        let _ = tx.send(name).await;
                    }
                }
            });

            watcher
        };

        // VLM worker with periodic rescan
        let vlm_client = VlmClient::new(self.vlm_config);
        let store_for_vlm = Arc::clone(&self.store);
        let photos_dir = self.photos_dir.clone();
        let tx_for_rescan = tx.clone();
        let store_for_rescan = Arc::clone(&self.store);

        // Periodic rescan task
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(RESCAN_INTERVAL).await;
                let store = store_for_rescan.lock().unwrap();
                if let Ok(names) = store.list_pending_filenames(MAX_VLM_ATTEMPTS) {
                    if !names.is_empty() {
                        info!("Periodic rescan: {} pending files", names.len());
                        for name in names {
                            let _ = tx_for_rescan.try_send(name);
                        }
                    }
                }
            }
        });

        // VLM processing loop
        while let Some(filename) = rx.recv().await {
            let jpeg_path = photos_dir.join(&filename);
            if !jpeg_path.exists() {
                warn!("VLM: file missing {filename}");
                continue;
            }

            info!("VLM processing: {filename}");
            match vlm_client.analyze(&jpeg_path).await {
                Ok(resp) => {
                    let s = store_for_vlm.lock().unwrap();
                    if let Err(e) = s.update_vlm_result(
                        &filename, resp.is_valid, &resp.caption, &resp.behavior,
                    ) {
                        error!("DB update {filename}: {e}");
                    } else {
                        info!("VLM done: {filename} is_valid={} behavior={}", resp.is_valid, resp.behavior);
                    }
                }
                Err(e) => {
                    error!("VLM error for {filename}: {e}");
                    let s = store_for_vlm.lock().unwrap();
                    let _ = s.record_vlm_failure(&filename, &e);
                }
            }
        }
    }
}

fn is_jpeg(name: &str) -> bool {
    name.ends_with(".jpg") || name.ends_with(".JPG") || name.ends_with(".jpeg")
}

/// Wait until file size stops changing, to avoid reading partial rsync transfers.
async fn wait_file_stable(path: &PathBuf) -> bool {
    for _ in 0..FILE_STABLE_MAX_RETRIES {
        let size1 = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size1 == 0 { return false; }
        tokio::time::sleep(FILE_STABLE_DELAY).await;
        let size2 = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size1 == size2 {
            return true;
        }
    }
    false
}
