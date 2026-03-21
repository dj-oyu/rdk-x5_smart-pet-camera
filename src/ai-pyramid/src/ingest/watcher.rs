use crate::db::PhotoStore;
use crate::ingest::filename::parse_comic_filename;
use crate::vlm::{VlmClient, VlmConfig};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

pub struct PhotoWatcher {
    photos_dir: PathBuf,
    store: Arc<Mutex<PhotoStore>>,
    vlm_config: VlmConfig,
}

impl PhotoWatcher {
    pub fn new(photos_dir: PathBuf, store: Arc<Mutex<PhotoStore>>, vlm_config: VlmConfig) -> Self {
        Self { photos_dir, store, vlm_config }
    }

    /// Scan existing files and insert any not yet in DB. Returns filenames queued for VLM.
    pub fn initial_scan(&self) -> Vec<String> {
        let mut queued = Vec::new();
        let entries = match std::fs::read_dir(&self.photos_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!("Cannot read photos dir {}: {e}", self.photos_dir.display());
                return queued;
            }
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jpg") && !name.ends_with(".JPG") && !name.ends_with(".jpeg") {
                continue;
            }
            if let Ok(meta) = parse_comic_filename(&name) {
                let store = self.store.lock().unwrap();
                if let Ok(existing) = store.get_by_filename(&name) {
                    if existing.is_none() {
                        let _ = store.insert(&name, meta.captured_at, meta.pet_id.as_deref());
                        queued.push(name.clone());
                    } else if existing.unwrap().is_valid.is_none() {
                        queued.push(name.clone());
                    }
                }
            }
        }
        info!("Initial scan: {} files queued for VLM", queued.len());
        queued
    }

    /// Start watching for new files and processing VLM queue.
    pub async fn run(self) {
        let (tx, mut rx) = mpsc::channel::<String>(64);

        // Queue initial scan results
        let initial = self.initial_scan();
        for name in initial {
            let _ = tx.send(name).await;
        }

        // Filesystem watcher
        let store_for_watcher = Arc::clone(&self.store);
        let tx_for_watcher = tx.clone();
        let photos_dir = self.photos_dir.clone();

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
                .watch(&photos_dir, RecursiveMode::NonRecursive)
                .expect("failed to watch photos directory");

            let store = Arc::clone(&store_for_watcher);
            let tx = tx_for_watcher;
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
                        if !name.ends_with(".jpg") && !name.ends_with(".JPG") && !name.ends_with(".jpeg") {
                            continue;
                        }
                        let meta = match parse_comic_filename(&name) {
                            Ok(m) => m,
                            Err(e) => { warn!("Skipping {name}: {e}"); continue; }
                        };
                        let s = store.lock().unwrap();
                        match s.insert(&name, meta.captured_at, meta.pet_id.as_deref()) {
                            Ok(_) => {
                                info!("New photo: {name}");
                                let _ = tx.blocking_send(name);
                            }
                            Err(e) => warn!("DB insert {name}: {e}"),
                        }
                    }
                }
            });

            watcher // keep alive
        };

        // VLM worker (concurrency=1)
        let vlm_client = VlmClient::new(self.vlm_config);
        let store_for_vlm = Arc::clone(&self.store);
        let photos_dir = self.photos_dir.clone();

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
                        &filename,
                        resp.is_valid,
                        &resp.caption,
                        &resp.behavior,
                    ) {
                        error!("DB update {filename}: {e}");
                    } else {
                        info!(
                            "VLM done: {filename} is_valid={} behavior={}",
                            resp.is_valid, resp.behavior
                        );
                    }
                }
                Err(e) => {
                    error!("VLM error for {filename}: {e}");
                }
            }
        }
    }
}
