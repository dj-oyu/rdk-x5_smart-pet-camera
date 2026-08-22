use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use tracing::{debug, warn};

static FETCH_NONCE: AtomicU64 = AtomicU64::new(0);

/// Common SSH options: accept new host keys on first connect, optionally use
/// a specific identity file so the service can authenticate regardless of
/// which OS user it runs as.
fn ssh_opts(ssh_key: Option<&str>) -> Vec<String> {
    let mut opts = vec![
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "BatchMode=yes".into(),
    ];
    if let Some(key) = ssh_key {
        opts.push("-i".into());
        opts.push(key.into());
    }
    opts
}

/// Parsed frame info from remote filename like `feeding_00013775_1280x720.nv12`
#[derive(Debug, Clone)]
pub struct RemoteFrame {
    pub filename: String,
    pub width: i32,
    pub height: i32,
    /// Companion JSON filename (if exists)
    pub json_filename: Option<String>,
}

/// Frame extensions the camera may have written. Raw `.nv12` was the original
/// format; `.webp` (lossless luma) replaced it to cut the collected volume, and
/// both must be accepted so the frames already on the camera stay usable.
const FRAME_EXTENSIONS: [&str; 2] = [".nv12", ".webp"];

pub fn frame_stem(filename: &str) -> Option<&str> {
    FRAME_EXTENSIONS
        .iter()
        .find_map(|ext| filename.strip_suffix(ext))
}

/// Name of the cached JPEG preview for a frame.
///
/// Every caller used to derive this with `replace(".nv12", ".jpg")`, which
/// silently produced `frame.webp` once the camera changed formats — the preview
/// was then written and looked up under different names, so the cache never hit
/// and stale entries were never cleaned up.
pub fn jpeg_cache_name(filename: &str) -> String {
    format!("{}.jpg", frame_stem(filename).unwrap_or(filename))
}

/// Parse dimensions from filename pattern `*_WIDTHxHEIGHT.{nv12,webp}`
fn parse_frame_filename(filename: &str) -> Option<(i32, i32)> {
    let stem = frame_stem(filename)?;
    let dim_part = stem.rsplit('_').next()?;
    let (w, h) = dim_part.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

/// List NV12 frames on RDK X5 via SSH.
pub async fn list_remote_frames(
    ssh_host: &str,
    remote_dir: &str,
    ssh_key: Option<&str>,
) -> Result<Vec<RemoteFrame>, String> {
    let output = Command::new("ssh")
        .args(ssh_opts(ssh_key))
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
        if frame_stem(file).is_none() {
            continue;
        }
        let Some((width, height)) = parse_frame_filename(file) else {
            warn!("skipping unparseable NV12 filename: {file}");
            continue;
        };
        let json_name = format!("{}.json", frame_stem(file).unwrap_or(file));
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
    ssh_key: Option<&str>,
) -> Result<PathBuf, String> {
    let jpeg_name = jpeg_cache_name(filename);
    // Raw .nv12 needs the geometry spelled out; .webp carries its own header.
    let is_raw_nv12 = filename.ends_with(".nv12");
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
        .args(ssh_opts(ssh_key))
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

    // Convert the fetched frame → JPEG via ffmpeg (output to temp path).
    // -f mjpeg is required because the temp filename ends in .tmp, not .jpg.
    let mut ffmpeg_args: Vec<String> = vec!["-y".into()];
    if is_raw_nv12 {
        // Raw frames carry no header, so the decoder needs the geometry.
        ffmpeg_args.extend([
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "nv12".into(),
            "-s".into(),
            format!("{width}x{height}"),
        ]);
    }
    ffmpeg_args.extend([
        "-i".into(),
        nv12_tmp.to_str().unwrap().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        "2".into(),
        "-f".into(),
        "mjpeg".into(),
        jpeg_tmp.to_str().unwrap().to_string(),
    ]);
    let ffmpeg_out = Command::new("ffmpeg")
        .args(&ffmpeg_args)
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

/// Delete multiple NV12 files on the remote host in batch via SSH.
/// Files are sent in chunks of `CHUNK` to avoid command-line length limits.
/// Returns `(deleted_count, errors)` where deleted_count is the number of
/// successfully deleted files and errors is a list of per-chunk error strings.
pub async fn delete_remote_frames(
    ssh_host: &str,
    remote_dir: &str,
    filenames: &[String],
    ssh_key: Option<&str>,
) -> (usize, Vec<String>) {
    const CHUNK: usize = 50;
    let mut errors = Vec::new();
    let mut deleted = 0usize;

    for chunk in filenames.chunks(CHUNK) {
        let paths: Vec<String> = chunk.iter().map(|f| format!("{remote_dir}/{f}")).collect();

        let mut cmd = Command::new("ssh");
        cmd.args(ssh_opts(ssh_key));
        cmd.arg(ssh_host);
        cmd.arg("rm");
        cmd.arg("-f");
        cmd.args(&paths);

        match cmd.output().await {
            Err(e) => errors.push(format!("ssh rm failed ({} files): {e}", chunk.len())),
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                errors.push(format!("ssh rm error ({} files): {stderr}", chunk.len()));
            }
            Ok(_) => {
                deleted += chunk.len();
                debug!("deleted {} remote files on {ssh_host}", chunk.len());
            }
        }
    }

    (deleted, errors)
}

/// Fetch companion JSON metadata via SSH cat.
pub async fn fetch_frame_metadata(
    ssh_host: &str,
    remote_dir: &str,
    json_filename: &str,
    ssh_key: Option<&str>,
) -> Result<serde_json::Value, String> {
    let remote_path = format!("{remote_dir}/{json_filename}");
    let output = Command::new("ssh")
        .args(ssh_opts(ssh_key))
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
            parse_frame_filename("feeding_00013775_1280x720.webp"),
            Some((1280, 720))
        );
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

    #[test]
    fn frame_stem_strips_both_frame_formats() {
        // Label and sidecar names are derived from this. A blind
        // replace(".nv12", ...) left WebP frames with a label file named
        // "*.webp" once the camera switched formats, so the exported dataset
        // had no usable labels.
        assert_eq!(
            frame_stem("feeding_00013775_1280x720.nv12"),
            Some("feeding_00013775_1280x720")
        );
        assert_eq!(
            frame_stem("feeding_00013775_1280x720.webp"),
            Some("feeding_00013775_1280x720")
        );
        assert_eq!(frame_stem("feeding_00013775_1280x720.jpg"), None);
        assert_eq!(frame_stem("notaframe"), None);
    }
}
