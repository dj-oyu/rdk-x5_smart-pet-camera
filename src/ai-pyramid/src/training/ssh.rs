use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use tracing::{debug, warn};

static FETCH_NONCE: AtomicU64 = AtomicU64::new(0);

/// Parsed frame info from remote filename like `feeding_00013775_1280x720.nv12`
#[derive(Debug, Clone)]
pub struct RemoteFrame {
    pub filename: String,
    pub width: i32,
    pub height: i32,
    /// Companion JSON filename (if exists)
    pub json_filename: Option<String>,
}

/// Parse dimensions from filename pattern `*_WIDTHxHEIGHT.nv12`
fn parse_frame_filename(filename: &str) -> Option<(i32, i32)> {
    let stem = filename.strip_suffix(".nv12")?;
    let dim_part = stem.rsplit('_').next()?;
    let (w, h) = dim_part.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

/// List NV12 frames on RDK X5 via SSH.
pub async fn list_remote_frames(
    ssh_host: &str,
    remote_dir: &str,
) -> Result<Vec<RemoteFrame>, String> {
    let output = Command::new("ssh")
        .args([ssh_host, "ls", remote_dir])
        .output()
        .await
        .map_err(|e| format!("ssh ls failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh ls error: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let all_files: Vec<&str> = stdout.lines().collect();

    let mut frames = Vec::new();
    for file in &all_files {
        if !file.ends_with(".nv12") {
            continue;
        }
        let Some((width, height)) = parse_frame_filename(file) else {
            warn!("skipping unparseable NV12 filename: {file}");
            continue;
        };
        let json_name = file.replace(".nv12", ".json");
        let json_filename = if all_files.iter().any(|f| *f == json_name) {
            Some(json_name)
        } else {
            None
        };
        frames.push(RemoteFrame {
            filename: file.to_string(),
            width,
            height,
            json_filename,
        });
    }

    debug!(
        "found {} NV12 frames on {ssh_host}:{remote_dir}",
        frames.len()
    );
    Ok(frames)
}

/// Fetch a single NV12 file via SCP and convert to JPEG using ffmpeg.
/// Returns the path to the cached JPEG.
pub async fn fetch_and_convert_frame(
    ssh_host: &str,
    remote_dir: &str,
    filename: &str,
    width: i32,
    height: i32,
    cache_dir: &Path,
) -> Result<PathBuf, String> {
    let jpeg_name = filename.replace(".nv12", ".jpg");
    let jpeg_path = cache_dir.join(&jpeg_name);

    // Return cached version if exists
    if jpeg_path.exists() {
        return Ok(jpeg_path);
    }

    // Ensure cache dir exists
    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|e| format!("failed to create cache dir: {e}"))?;

    let remote_path = format!("{remote_dir}/{filename}");
    // Unique per-request suffix prevents concurrent fetches of the same frame
    // from colliding on the same temp path.
    let nonce = FETCH_NONCE.fetch_add(1, Ordering::Relaxed);
    let nv12_tmp = cache_dir.join(format!("{filename}.{nonce}.tmp"));
    // Write JPEG to a unique temp path; atomically rename into place on success.
    let jpeg_tmp = cache_dir.join(format!("{jpeg_name}.{nonce}.tmp"));

    // SCP the NV12 file
    let scp_out = Command::new("scp")
        .args([
            &format!("{ssh_host}:{remote_path}"),
            nv12_tmp.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| format!("scp failed: {e}"))?;

    if !scp_out.status.success() {
        let _ = tokio::fs::remove_file(&nv12_tmp).await;
        let stderr = String::from_utf8_lossy(&scp_out.stderr);
        return Err(format!("scp error: {stderr}"));
    }

    // Convert NV12 → JPEG via ffmpeg (output to temp path)
    let ffmpeg_out = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "nv12",
            "-s",
            &format!("{width}x{height}"),
            "-i",
            nv12_tmp.to_str().unwrap(),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            jpeg_tmp.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;

    // Clean up NV12 temp file
    let _ = tokio::fs::remove_file(&nv12_tmp).await;

    if !ffmpeg_out.status.success() {
        let _ = tokio::fs::remove_file(&jpeg_tmp).await;
        let stderr = String::from_utf8_lossy(&ffmpeg_out.stderr);
        return Err(format!("ffmpeg convert error: {stderr}"));
    }

    // Atomic rename: last writer wins, result is always a valid JPEG
    tokio::fs::rename(&jpeg_tmp, &jpeg_path)
        .await
        .map_err(|e| format!("rename jpeg into cache: {e}"))?;

    debug!("converted {filename} → {jpeg_name}");
    Ok(jpeg_path)
}

/// Fetch companion JSON metadata via SSH cat.
pub async fn fetch_frame_metadata(
    ssh_host: &str,
    remote_dir: &str,
    json_filename: &str,
) -> Result<serde_json::Value, String> {
    let remote_path = format!("{remote_dir}/{json_filename}");
    let output = Command::new("ssh")
        .args([ssh_host, "cat", &remote_path])
        .output()
        .await
        .map_err(|e| format!("ssh cat failed: {e}"))?;

    if !output.status.success() {
        return Err("json file not found".to_string());
    }

    serde_json::from_slice(&output.stdout).map_err(|e| format!("json parse error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_standard_filename() {
        assert_eq!(
            parse_frame_filename("feeding_00013775_1280x720.nv12"),
            Some((1280, 720))
        );
    }

    #[test]
    fn parse_night_filename() {
        assert_eq!(
            parse_frame_filename("night_00001234_1920x1080.nv12"),
            Some((1920, 1080))
        );
    }

    #[test]
    fn parse_invalid() {
        assert_eq!(parse_frame_filename("random.nv12"), None);
        assert_eq!(parse_frame_filename("feeding_1280x720.jpg"), None);
    }
}
