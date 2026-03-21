use clap::Parser;
use pet_album::db::PhotoStore;
use pet_album::ingest::watcher::PhotoWatcher;
use pet_album::server;
use pet_album::vlm::VlmConfig;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

    #[arg(long, default_value = "qwen3-vl-2B-Int4-ax650")]
    vlm_model: String,

    #[arg(long, default_value_t = 128)]
    vlm_max_tokens: u32,
}

const CERT_SEARCH_PATHS: &[&str] = &[
    "/data/tailscale/certs/m5stack-ai-pyramid.tail848eb5.ts.net",
    "../../m5stack-ai-pyramid.tail848eb5.ts.net", // repo root from src/ai-pyramid
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
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    std::fs::create_dir_all(&args.photos_dir).expect("failed to create photos directory");

    let store = PhotoStore::open(&args.db_path).expect("failed to open database");
    store.migrate().expect("failed to migrate database");
    let store = Arc::new(Mutex::new(store));

    info!("Database: {}", args.db_path);
    info!("Photos dir: {}", args.photos_dir.display());

    let vlm_config = VlmConfig {
        base_url: args.vlm_url,
        model: args.vlm_model,
        max_tokens: args.vlm_max_tokens,
        timeout: Duration::from_secs(30),
    };

    let watcher = PhotoWatcher::new(args.photos_dir.clone(), Arc::clone(&store), vlm_config);
    tokio::spawn(async move {
        watcher.run().await;
    });

    let app_state = server::AppState {
        store,
        photos_dir: args.photos_dir,
    };
    let app = server::router(app_state);

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
