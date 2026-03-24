use clap::Parser;
use pet_album::application::{AppContext, PhotoStoreRepository};
use pet_album::db::PhotoStore;
use pet_album::ingest::watcher::PhotoWatcher;
use pet_album::server;
use pet_album::vlm::VlmConfig;
use std::net::SocketAddr;
use std::path::PathBuf;
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

    #[arg(long, default_value = "AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4-C256-P3584-CTX4095")]
    vlm_model: String,

    #[arg(long, default_value_t = 128)]
    vlm_max_tokens: u32,
}

const CERT_SEARCH_PATHS: &[&str] = &[
    "/data/tailscale/certs/<album-host>",
    "../../<album-host>", // repo root from src/ai-pyramid
];

fn find_tls_certs() -> Option<(PathBuf, PathBuf)> {
    for base in CERT_SEARCH_PATHS {
        let cert = PathBuf::from(format!("{base}.crt"));
        let key = PathBuf::from(format!("{base}.key"));
        if cert.exists() && key.exists() {
            return Some((cert, key));
        }
    }
    None
}

#[tokio::main]
async fn main() {
    // Load .env file if present (before parsing args and reading env vars)
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt::init();

    let args = Args::parse();

    std::fs::create_dir_all(&args.photos_dir).expect("failed to create photos directory");

    let store = PhotoStore::open(&args.db_path).expect("failed to open database");
    store.migrate().expect("failed to migrate database");
    let repository = PhotoStoreRepository::shared(store);

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
            let _ = sse_bridge.send(server::PhotoEvent {
                filename: event.source_filename,
                is_valid: event.is_valid,
                caption: event.summary,
                behavior: event.behavior,
                pet_id: event.pet_id,
            });
        }
    });

    let watcher = PhotoWatcher::new(app_context.clone(), vlm_config);
    tokio::spawn(async move {
        watcher.run().await;
    });

    let pet_names = server::load_pet_names();
    if !pet_names.is_empty() {
        info!("Pet names: {:?}", pet_names);
    }

    let app_state = server::AppState {
        context: app_context,
        photos_dir: args.photos_dir,
        event_tx: sse_event_tx,
        pet_names,
    };
    let app = server::router(app_state);

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
