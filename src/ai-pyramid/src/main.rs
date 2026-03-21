use clap::Parser;
use pet_album::db::PhotoStore;
use pet_album::ingest::watcher::PhotoWatcher;
use pet_album::server;
use pet_album::vlm::VlmConfig;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::info;

#[derive(Parser)]
#[command(name = "pet-album", about = "AI Pyramid Pro album service")]
struct Args {
    #[arg(long, default_value = ":8090")]
    addr: String,

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

    let bind_addr = args.addr.strip_prefix(':').map_or_else(
        || args.addr.clone(),
        |port| format!("0.0.0.0:{port}"),
    );

    info!("Listening on {bind_addr}");

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind");

    axum::serve(listener, app).await.expect("server error");
}
