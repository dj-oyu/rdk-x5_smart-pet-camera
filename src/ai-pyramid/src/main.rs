use clap::Parser;
use pet_album::bootstrap::{self, Args};

#[tokio::main]
async fn main() {
    bootstrap::load_dotenv();
    tracing_subscriber::fmt::init();
    bootstrap::run(Args::parse()).await;
}
