use super::wire::{
    CMD_DETECT, CMD_LOAD, INPUT_JPEG_PATH, INPUT_NV12_RAW, RawLocalDetection, RequestHeader,
    raw_detection, request_bytes, response_header, wire_detection,
};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

pub(super) struct DaemonClient {
    socket_path: PathBuf,
}

impl DaemonClient {
    pub(super) fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    pub(super) fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub(super) async fn detect_image(
        &self,
        jpeg_path: &Path,
    ) -> Result<Vec<RawLocalDetection>, String> {
        let payload = jpeg_path.to_string_lossy().into_owned().into_bytes();
        let header = RequestHeader {
            cmd: CMD_DETECT,
            input_type: INPUT_JPEG_PATH,
            width: 0,
            height: 0,
            payload_size: payload.len() as u32,
            reserved: 0,
        };
        self.send_request(&header, &payload).await
    }

    pub(super) async fn detect_nv12(
        &self,
        nv12: &[u8],
        width: u16,
        height: u16,
    ) -> Result<Vec<RawLocalDetection>, String> {
        let header = RequestHeader {
            cmd: CMD_DETECT,
            input_type: INPUT_NV12_RAW,
            width,
            height,
            payload_size: nv12.len() as u32,
            reserved: 0,
        };
        self.send_request(&header, nv12).await
    }

    pub(super) async fn load_model(&self, name: &str) -> Result<(), String> {
        let payload = name.as_bytes();
        let header = RequestHeader {
            cmd: CMD_LOAD,
            input_type: 0,
            width: 0,
            height: 0,
            payload_size: payload.len() as u32,
            reserved: 0,
        };
        let mut stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        write_request(&mut stream, &header, payload).await?;

        let mut response = [0u8; 12];
        stream
            .read_exact(&mut response)
            .await
            .map_err(|e| format!("read response: {e}"))?;
        let response = response_header(&response);
        if response.status != 0 {
            let mut error = vec![0u8; response.error_len as usize];
            if response.error_len > 0 {
                let _ = stream.read_exact(&mut error).await;
            }
            return Err(String::from_utf8_lossy(&error).to_string());
        }
        Ok(())
    }

    async fn send_request(
        &self,
        header: &RequestHeader,
        payload: &[u8],
    ) -> Result<Vec<RawLocalDetection>, String> {
        let mut stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| format!("connect {}: {e}", self.socket_path.display()))?;
        write_request(&mut stream, header, payload).await?;

        let mut response = [0u8; 12];
        stream
            .read_exact(&mut response)
            .await
            .map_err(|e| format!("read response header: {e}"))?;
        let response = response_header(&response);

        if response.status != 0 {
            let mut error = vec![0u8; response.error_len as usize];
            if response.error_len > 0 {
                stream
                    .read_exact(&mut error)
                    .await
                    .map_err(|e| format!("read error: {e}"))?;
            }
            return Err(String::from_utf8_lossy(&error).to_string());
        }

        let mut detections = Vec::with_capacity(response.det_count as usize);
        for _ in 0..response.det_count {
            let mut bytes = [0u8; 12];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|e| format!("read detection: {e}"))?;
            detections.push(raw_detection(wire_detection(&bytes)));
        }
        Ok(detections)
    }
}

async fn write_request(
    stream: &mut UnixStream,
    header: &RequestHeader,
    payload: &[u8],
) -> Result<(), String> {
    stream
        .write_all(request_bytes(header))
        .await
        .map_err(|e| format!("write header: {e}"))?;
    if !payload.is_empty() {
        stream
            .write_all(payload)
            .await
            .map_err(|e| format!("write payload: {e}"))?;
    }
    stream
        .shutdown()
        .await
        .map_err(|e| format!("shutdown: {e}"))
}
