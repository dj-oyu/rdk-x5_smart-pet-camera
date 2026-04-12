use clap::Parser;
use pet_album::application::{AppContext, PhotoStoreRepository};
use pet_album::db::PhotoStore;
use pet_album::detect::{DetectClient, DetectConfig};
use pet_album::ingest::watcher::PhotoWatcher;
use pet_album::server;
use pet_album::vlm::VlmConfig;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tracing::info;

#[derive(Parser)]
#[command(name = "pet-album", about = "AI Pyramid Pro album service")]
struct Args {
    /// Listen address (e.g. :8082 or 0.0.0.0:8082)
    #[arg(long, default_value = ":8082")]
    addr: String,

    /// TLS cert path (auto-detected if omitted)
    #[arg(long)]
    tls_cert: Option<PathBuf>,

    /// TLS key path (auto-detected if omitted)
    #[arg(long)]
    tls_key: Option<PathBuf>,

    #[arg(long, default_value = "data/photos")]
    photos_dir: PathBuf,

    #[arg(long, default_value = "data/pet-album.db")]
    db_path: String,

    #[arg(long, default_value = "http://localhost:8000")]
    vlm_url: String,

    #[arg(
        long,
        default_value = "AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4-C256-P3584-CTX4095"
    )]
    vlm_model: String,

    #[arg(long, default_value_t = 128)]
    vlm_max_tokens: u32,

    /// Disable night assist (supplementary YOLO for rdk-x5 night camera)
    #[arg(long)]
    no_night_assist: bool,
}

fn find_tls_certs() -> Option<(PathBuf, PathBuf)> {
    let cert = std::env::var("PET_ALBUM_TLS_CERT").ok()?;
    let key = std::env::var("PET_ALBUM_TLS_KEY").ok()?;
    let cert = PathBuf::from(cert);
    let key = PathBuf::from(key);
    if cert.exists() && key.exists() {
        Some((cert, key))
    } else {
        None
    }
}

#[tokio::main]
async fn main() {
    // Load .env — walk up to repo root if not found in cwd
    let _ = dotenvy::dotenv().or_else(|_| {
        let mut dir = std::env::current_dir().ok();
        while let Some(d) = dir {
            let candidate = d.join(".env");
            if candidate.is_file() {
                return dotenvy::from_path(&candidate).map(|_| candidate);
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
        Err(dotenvy::Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            ".env not found",
        )))
    });

    tracing_subscriber::fmt::init();

    let args = Args::parse();

    std::fs::create_dir_all(&args.photos_dir).expect("failed to create photos directory");

    let store = PhotoStore::open(&args.db_path).expect("failed to open database");
    store.migrate().expect("failed to migrate database");
    let (repository, db_handle) = PhotoStoreRepository::shared(store);

    info!("Database: {}", args.db_path);
    info!("Photos dir: {}", args.photos_dir.display());

    let vlm_config = VlmConfig {
        base_url: args.vlm_url,
        model: args.vlm_model,
        max_tokens: args.vlm_max_tokens,
        timeout: Duration::from_secs(30),
    };

    // Broadcast channels: PetEvent for application layer, PhotoEvent for SSE
    let (pet_event_tx, _) = tokio::sync::broadcast::channel::<pet_album::application::PetEvent>(64);
    let (sse_event_tx, _) = tokio::sync::broadcast::channel::<server::PhotoEvent>(64);

    let bind_addr: SocketAddr = args
        .addr
        .strip_prefix(':')
        .map_or_else(|| args.addr.clone(), |port| format!("0.0.0.0:{port}"))
        .parse()
        .expect("invalid bind address");

    // Resolve TLS certs: explicit args > auto-detect > HTTP fallback
    let tls = match (args.tls_cert, args.tls_key) {
        (Some(c), Some(k)) => Some((c, k)),
        _ => find_tls_certs(),
    };

    let base_url = std::env::var("PUBLIC_URL").ok();
    if let Some(ref url) = base_url {
        info!("PUBLIC_URL: {url}");
    }

    let app_context = AppContext::new(
        repository,
        args.photos_dir.clone(),
        pet_event_tx,
        base_url,
        tls.is_some(),
        vlm_config.clone(),
    );

    // Bridge PetEvent → PhotoEvent for SSE
    let mut app_events = app_context.subscribe();
    let sse_bridge = sse_event_tx.clone();
    tokio::spawn(async move {
        while let Ok(event) = app_events.recv().await {
            let _ = sse_bridge.send(server::PhotoEvent::Update {
                filename: event.source_filename,
                is_valid: event.is_valid,
                caption: event.summary,
                behavior: event.behavior,
                pet_id: event.pet_id,
            });
        }
    });

    let camera_host = std::env::var("PET_CAMERA_HOST").ok();
    let album_host = std::env::var("PET_ALBUM_HOST").ok();
    let detect_client: Option<Arc<DetectClient>> = if camera_host.is_some() || album_host.is_some()
    {
        let camera_host = camera_host.unwrap_or_else(|| "localhost".into());
        let album_host = album_host.unwrap_or_else(|| "localhost".into());
        let camera_port = std::env::var("PET_CAMERA_PORT").unwrap_or_else(|_| "8080".into());
        let detect_port = std::env::var("PET_CAMERA_DETECT_PORT").ok();
        let album_port = std::env::var("PET_ALBUM_PORT").unwrap_or_else(|_| "8082".into());
        let config = DetectConfig {
            camera_base_url: if let Some(ref dp) = detect_port {
                // Direct to Python detector (HTTP)
                format!("http://{camera_host}:{dp}")
            } else {
                // Via Go proxy (HTTPS)
                format!("https://{camera_host}:{camera_port}")
            },
            self_base_url: format!("https://{album_host}:{album_port}"),
            timeout: Duration::from_secs(30),
            score_threshold: 0.2,
        };
        info!(
            "Detection enabled: camera={}, self={}",
            config.camera_base_url, config.self_base_url
        );
        Some(Arc::new(DetectClient::new(config)))
    } else {
        info!("Detection disabled: neither PET_CAMERA_HOST nor PET_ALBUM_HOST set");
        None
    };

    // Local NPU detector (YOLO26l on AX650)
    let local_detector = {
        let config = pet_album::detect::local::LocalDetectorConfig::default();
        let ld = pet_album::detect::local::LocalDetector::new(config);
        if ld.is_available() {
            info!("Local detection enabled (YOLO26l on NPU)");
            Some(std::sync::Arc::new(ld))
        } else {
            info!("Local detection unavailable (missing binaries or models)");
            None
        }
    };

    let watcher = PhotoWatcher::new(
        app_context.clone(),
        vlm_config,
        detect_client.clone(),
        local_detector.clone(),
    );
    tokio::spawn(async move {
        watcher.run().await;
    });

    let pet_names = server::load_pet_names();
    if !pet_names.is_empty() {
        info!("Pet names: {:?}", pet_names);
    }

    // Night assist host: detection is handled by ax_yolo_daemon CMD_STREAM.
    // We just pass the host to the SSE handler for daemon connection.
    let night_assist_host = if args.no_night_assist {
        None
    } else {
        std::env::var("PET_CAMERA_HOST").ok()
    };
    if let Some(ref h) = night_assist_host {
        info!("Night assist enabled: rdk-x5 at {h} (via ax_yolo_daemon)");
    }

    // Training annotation subsystem
    // Reuse PET_CAMERA_HOST (rdk-x5 tailscale hostname) for SSH.
    // Prepend "sunrise@" since that's the rdk-x5 login user.
    let training_ssh_host = std::env::var("PET_CAMERA_HOST")
        .map(|h| format!("sunrise@{h}"))
        .unwrap_or_else(|_| "rdk-x5".into());
    let training_remote_dir = std::env::var("TRAINING_REMOTE_DIR")
        .unwrap_or_else(|_| "/tmp/night_collect/feeding".into());
    let training_ssh_key = std::env::var("TRAINING_SSH_KEY").ok();
    let training_cache_dir = args
        .photos_dir
        .parent()
        .unwrap_or(&args.photos_dir)
        .join("training");
    info!(
        "Training: ssh={training_ssh_host} remote={training_remote_dir} key={} cache={}",
        training_ssh_key.as_deref().unwrap_or("(default)"),
        training_cache_dir.display()
    );
    let training_state = pet_album::training::api::TrainingState {
        db: db_handle,
        ssh_host: training_ssh_host,
        remote_dir: training_remote_dir,
        cache_dir: training_cache_dir,
        ssh_key: training_ssh_key,
    };
    let training_router = pet_album::training::api::router(training_state);

    let app_state = server::AppState::new(
        app_context,
        args.photos_dir,
        sse_event_tx,
        pet_names,
        detect_client,
        local_detector,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        night_assist_host,
    );
    let app = server::router(app_state).merge(training_router);

    match tls {
        Some((cert, key)) => {
            info!("HTTPS on {bind_addr} (cert: {})", cert.display());
            let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
                .await
                .expect("failed to load TLS cert/key");
            axum_server::bind_rustls(bind_addr, tls_config)
                .serve(app.into_make_service())
                .await
                .expect("HTTPS server error");
        }
        None => {
            info!("HTTP on {bind_addr} (no TLS certs found)");
            let listener = tokio::net::TcpListener::bind(bind_addr)
                .await
                .expect("failed to bind");
            axum::serve(listener, app).await.expect("server error");
        }
    }
}
