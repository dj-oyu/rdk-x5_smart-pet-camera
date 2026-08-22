use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Run `systemctl <args...>` as the current user. The service runs as root, so
/// no sudo hop is required from the deployed process.
pub(super) async fn systemctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .args(args)
        .output()
        .await
        .map_err(|error| format!("systemctl {args:?} spawn failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "systemctl {args:?} exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(())
}

/// Poll `<base_url>/v1/models` until the requested model is ready.
pub(super) async fn wait_for_model(
    http: &reqwest::Client,
    base_url: &str,
    model_id: &str,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<(), String> {
    let url = format!("{base_url}/v1/models");
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(response) = http.get(&url).send().await
            && response.status().is_success()
            && let Ok(body) = response.json::<ModelsResponse>().await
            && body.data.iter().any(|model| model.id == model_id)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "model {model_id} not ready within {:?} via {url}",
                timeout
            ));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}
