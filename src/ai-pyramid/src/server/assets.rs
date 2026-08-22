use axum::extract::Path;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use include_dir::{Dir, include_dir};

static EMBEDDED_UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/ui/dist");

pub(super) async fn handle_embedded_app() -> Response {
    embedded_ui_response(None)
}

pub(super) async fn handle_embedded_asset(Path(path): Path<String>) -> Response {
    embedded_ui_response(Some(path.as_str()))
}

fn embedded_ui_response(path: Option<&str>) -> Response {
    let requested = path.unwrap_or("index.html").trim_start_matches('/');
    let file = EMBEDDED_UI
        .get_file(requested)
        .or_else(|| EMBEDDED_UI.get_file("index.html"));

    match file {
        Some(file) => {
            let mime = mime_guess::from_path(file.path())
                .first_or_octet_stream()
                .to_string();
            let mut response = Response::new(file.contents().to_vec().into_response().into_body());
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&mime)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            response
        }
        None => (StatusCode::NOT_FOUND, "embedded asset not found").into_response(),
    }
}
