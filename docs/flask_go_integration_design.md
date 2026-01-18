# Flask + Go 統合設計

**Version**: 1.0
**Date**: 2025-12-26
**Status**: 設計中

---

## 目次

1. [概要](#概要)
2. [統合パターンの比較](#統合パターンの比較)
3. [推奨アーキテクチャ](#推奨アーキテクチャ)
4. [データフロー](#データフロー)
5. [API設計](#api設計)
6. [状態管理](#状態管理)
7. [実装詳細](#実装詳細)
8. [段階的移行](#段階的移行)

---

## 概要

### 背景

現在のシステム構成:
- **Flask Web UI**: BBox描画、MJPEG配信、録画制御UI
- **Go Streaming Server** (新規): WebRTC配信、H.264録画

### 課題

1. 録画開始・停止の制御をどちらが管理するか？
2. WebRTC接続状態をFlask UIでどう表示するか？
3. 録画状態をリアルタイムで表示するには？
4. ブラウザはFlaskとGoの両方にアクセスするのか？

---

## 統合パターンの比較

### パターン1: Flask → Go プロキシ型 ✅ **推奨**

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                             │
│  - UI表示 (Flask HTML)                                   │
│  - WebRTC接続 (直接Goへ)                                 │
│  - Canvas BBox描画                                       │
└────────┬──────────────────────────────┬─────────────────┘
         │ HTTP/SSE                     │ WebRTC
         ▼                              ▼
┌────────────────────┐       ┌─────────────────────────┐
│  Flask (Port 8080) │       │  Go Server (Port 8081)  │
│  - Web UI          │◄─────►│  - WebRTC配信           │
│  - API Proxy       │ HTTP  │  - H.264録画            │
│  - BBox SSE        │       │  - 状態管理             │
└────────────────────┘       └─────────────────────────┘
```

**メリット**:
- ✅ 既存のFlask UIをそのまま使用可能
- ✅ ブラウザからのアクセス先は1つ（Flask: 8080）
- ✅ 段階的な移行が可能
- ✅ FlaskとGoの責任が明確

**デメリット**:
- ⚠️ FlaskがGoを呼び出すオーバーヘッド（~1-2ms）
- ⚠️ 2つのプロセスを管理

---

### パターン2: 並列型

```
Browser → Flask (UI, BBox)
Browser → Go (WebRTC, Recording API)
```

**メリット**:
- ✅ プロキシオーバーヘッドなし

**デメリット**:
- ❌ ブラウザが2つのサーバーにアクセス（CORS設定必要）
- ❌ 状態同期が複雑
- ❌ 録画制御UIがどちらにあるか不明確

---

### パターン3: Go完全置き換え

```
Browser → Go (WebRTC, Recording, UI, BBox)
```

**メリット**:
- ✅ シンプル（単一サーバー）

**デメリット**:
- ❌ Flask UIを全部Goで再実装（大量の工数）
- ❌ BBox描画ロジックもGoで実装
- ❌ 移行リスクが高い

---

## 推奨アーキテクチャ

### パターン1を採用: Flask API Proxy型

```
┌──────────────────────────────────────────────────────────────┐
│                         Browser                               │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │  HTML/CSS/JS    │  │  WebRTC Client   │  │ Canvas BBox │ │
│  │  (Flask served) │  │  (直接Go接続)    │  │ (SSE受信)   │ │
│  └────────┬────────┘  └────────┬─────────┘  └──────┬──────┘ │
│           │                    │                    │         │
└───────────┼────────────────────┼────────────────────┼─────────┘
            │                    │                    │
            │ HTTP               │ WebRTC             │ SSE
            ▼                    │                    ▼
┌────────────────────────────────┼────────────────────────────┐
│        Flask Server (Port 8080)│                            │
├────────────────────────────────┼────────────────────────────┤
│                                │                            │
│  ┌───────────────────┐         │  ┌──────────────────────┐  │
│  │  /                │         │  │  /api/detections/    │  │
│  │  index.html       │         │  │  stream (SSE)        │  │
│  └───────────────────┘         │  └──────────────────────┘  │
│                                │                            │
│  ┌───────────────────────────┐ │                            │
│  │ Recording Control API     │ │                            │
│  │ - POST /api/recording/    │ │                            │
│  │        start              │ │                            │
│  │ - POST /api/recording/    │ │                            │
│  │        stop               │ │                            │
│  │ - GET  /api/recording/    │ │                            │
│  │        status             │ │                            │
│  │                           │ │                            │
│  │ → Proxy to Go Server      │ │                            │
│  └───────────┬───────────────┘ │                            │
│              │ HTTP            │                            │
└──────────────┼─────────────────┼────────────────────────────┘
               │                 │
               ▼                 │
┌──────────────────────────────┐ │
│  Go Server (Port 8081)       │ │
├──────────────────────────────┤ │
│                              │ │
│  ┌────────────────────────┐  │ │
│  │ WebRTC Signaling       │◄─┼─┘
│  │ POST /api/webrtc/offer │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ Recording API          │  │
│  │ POST /start            │◄─┤ Flask Proxy
│  │ POST /stop             │  │
│  │ GET  /status           │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ Metrics/Health         │  │
│  │ GET /metrics           │  │
│  │ GET /health            │  │
│  └────────────────────────┘  │
│                              │
└──────────────────────────────┘
```

---

## データフロー

### 1. WebRTC配信フロー

```
[Browser]
    │
    │ 1. HTMLページ取得
    ├──────────────────────────► [Flask: GET /]
    │◄──────────────────────────── index.html (WebRTCクライアント含む)
    │
    │ 2. WebRTC SDP Offer送信
    ├─────────────────────────────────────────► [Go: POST /api/webrtc/offer]
    │◄──────────────────────────────────────────── SDP Answer
    │
    │ 3. WebRTC接続確立 (RTP/H.264)
    │◄═════════════════════════════════════════► [Go: WebRTC Server]
    │
    │ 4. BBox情報取得 (並行)
    ├──────────────────────────► [Flask: GET /api/detections/stream (SSE)]
    │◄────────────────────────────── JSON detections
```

**ポイント**:
- WebRTC接続は**直接ブラウザ → Go**（低遅延）
- BBox情報は**Flask → SSE**（既存の仕組み）
- HTMLはFlaskから配信

---

### 2. 録画制御フロー

```
[Browser UI]
    │
    │ 1. ユーザーが「録画開始」ボタンクリック
    ├──────────────────────────► [Flask: POST /api/recording/start]
    │                                      │
    │                                      │ 2. Goにプロキシ
    │                                      ├─────────► [Go: POST /start]
    │                                      │                │
    │                                      │                │ 3. 録画開始
    │                                      │                │    - ファイルオープン
    │                                      │                │    - フラグ設定
    │                                      │◄────────────── {"status": "recording"}
    │                                      │
    │◄──────────────────────────────────────── {"status": "recording"}
    │
    │ 4. 状態ポーリング開始 (1秒ごと)
    ├──────────────────────────► [Flask: GET /api/recording/status]
    │                                      │
    │                                      ├─────────► [Go: GET /status]
    │                                      │◄───────── {"recording": true, "frame_count": 123, ...}
    │◄──────────────────────────────────────── {"recording": true, "frame_count": 123, ...}
    │
    │ 5. ユーザーが「録画停止」ボタンクリック
    ├──────────────────────────► [Flask: POST /api/recording/stop]
    │                                      │
    │                                      ├─────────► [Go: POST /stop]
    │                                      │◄───────── {"status": "stopped", "file": "...", ...}
    │◄──────────────────────────────────────── {"status": "stopped", "file": "...", ...}
```

**ポイント**:
- Flask APIが**プロキシ**としてGoを呼び出す
- ブラウザは**Flaskにのみ**アクセス
- 状態はGoが管理、Flaskが定期的にポーリング

---

## API設計

### Flask API (Port 8080)

#### 1. UI配信

```python
@app.route("/")
def index():
    """WebRTC + BBox統合UI"""
    return render_template("index.html", go_server_url=GO_SERVER_URL)
```

#### 2. 録画制御 (Goへのプロキシ)

```python
import requests

GO_SERVER_URL = "http://localhost:8081"

@app.route("/api/recording/start", methods=["POST"])
def recording_start():
    """録画開始（Goにプロキシ）"""
    try:
        data = request.get_json() or {}

        # Goサーバーに転送
        response = requests.post(
            f"{GO_SERVER_URL}/start",
            json=data,
            timeout=5
        )

        return jsonify(response.json()), response.status_code

    except requests.RequestException as e:
        return jsonify({
            "error": "Go server unavailable",
            "details": str(e)
        }), 503

@app.route("/api/recording/stop", methods=["POST"])
def recording_stop():
    """録画停止（Goにプロキシ）"""
    try:
        response = requests.post(
            f"{GO_SERVER_URL}/stop",
            timeout=5
        )

        return jsonify(response.json()), response.status_code

    except requests.RequestException as e:
        return jsonify({
            "error": "Go server unavailable",
            "details": str(e)
        }), 503

@app.route("/api/recording/status", methods=["GET"])
def recording_status():
    """録画状態取得（Goにプロキシ）"""
    try:
        response = requests.get(
            f"{GO_SERVER_URL}/status",
            timeout=2
        )

        return jsonify(response.json()), response.status_code

    except requests.RequestException as e:
        return jsonify({
            "error": "Go server unavailable",
            "details": str(e),
            "recording": False
        }), 503
```

#### 3. WebRTC統合ヘルパー

```python
@app.route("/api/webrtc/config", methods=["GET"])
def webrtc_config():
    """WebRTC設定を返す（ブラウザが直接Goに接続するため）"""
    return jsonify({
        "signaling_url": GO_SERVER_URL,
        "ice_servers": [
            {"urls": "stun:stun.l.google.com:19302"}
        ]
    })
```

#### 4. 既存のBBox SSE (変更なし)

```python
@app.route("/api/detections/stream")
def detections_stream():
    """BBox情報のSSE配信（既存）"""
    def generate():
        while True:
            detections = shm.read_detection()
            data = {
                "detections": [...]
            }
            yield f"data: {json.dumps(data)}\n\n"
            time.sleep(0.033)  # 30fps

    return Response(generate(), mimetype='text/event-stream')
```

---

### Go API (Port 8081)

#### 1. WebRTC Signaling (直接ブラウザから呼ばれる)

```go
// POST /api/webrtc/offer
func (s *Server) handleWebRTCOffer(w http.ResponseWriter, r *http.Request) {
    // CORS設定（ブラウザから直接アクセスされるため）
    w.Header().Set("Access-Control-Allow-Origin", "http://localhost:8080")
    w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

    if r.Method == "OPTIONS" {
        w.WriteHeader(http.StatusOK)
        return
    }

    offerJSON, _ := io.ReadAll(r.Body)
    answerJSON, err := s.webrtcServer.HandleOffer(offerJSON)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Write(answerJSON)
}
```

#### 2. 録画API (Flaskから呼ばれる)

```go
// POST /start
func (s *Server) handleRecordingStart(w http.ResponseWriter, r *http.Request) {
    // CORS不要（同じサーバー内部からのリクエスト）

    var req struct {
        Filename string `json:"filename,omitempty"`
    }
    json.NewDecoder(r.Body).Decode(&req)

    filename, err := s.recorder.StartRecording(req.Filename)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    resp := map[string]interface{}{
        "status":   "recording",
        "filename": filename,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

// POST /stop
func (s *Server) handleRecordingStop(w http.ResponseWriter, r *http.Request) {
    stats, err := s.recorder.StopRecording()
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    resp := map[string]interface{}{
        "status":        "stopped",
        "filename":      stats.Filename,
        "frame_count":   stats.FrameCount,
        "bytes_written": stats.BytesWritten,
        "duration":      stats.Duration.Seconds(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

// GET /status
func (s *Server) handleRecordingStatus(w http.ResponseWriter, r *http.Request) {
    stats := s.recorder.GetStats()

    resp := map[string]interface{}{
        "recording": s.recorder.IsRecording(),
    }

    if stats != nil {
        resp["filename"] = stats.Filename
        resp["frame_count"] = stats.FrameCount
        resp["bytes_written"] = stats.BytesWritten
        resp["duration"] = stats.Duration.Seconds()
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}
```

#### 3. ヘルスチェック

```go
// GET /health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    status := map[string]interface{}{
        "status": "ok",
        "uptime": time.Since(s.startTime).Seconds(),
        "webrtc_clients": s.webrtcServer.GetClientCount(),
        "recording": s.recorder.IsRecording(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(status)
}
```

---

## 状態管理

### ブラウザUI側の状態表示

```javascript
// webrtc_status.js
class ServerStatusMonitor {
    constructor() {
        this.statusElement = document.getElementById('server-status');
        this.recordingStatus = document.getElementById('recording-status');

        // 1秒ごとに状態をポーリング
        setInterval(() => this.updateStatus(), 1000);
    }

    async updateStatus() {
        try {
            // Flask経由でGo状態を取得
            const response = await fetch('/api/recording/status');
            const data = await response.json();

            this.updateRecordingUI(data);
            this.updateHealthStatus('ok');
        } catch (error) {
            this.updateHealthStatus('error');
        }
    }

    updateRecordingUI(data) {
        if (data.recording) {
            this.recordingStatus.innerHTML = `
                <span class="badge badge-danger">● 録画中</span>
                <div>
                    ファイル: ${data.filename}<br>
                    フレーム数: ${data.frame_count}<br>
                    サイズ: ${(data.bytes_written / 1024 / 1024).toFixed(2)} MB<br>
                    時間: ${data.duration.toFixed(1)}秒
                </div>
            `;
        } else {
            this.recordingStatus.innerHTML = `
                <span class="badge badge-secondary">○ 停止中</span>
            `;
        }
    }

    updateHealthStatus(status) {
        if (status === 'ok') {
            this.statusElement.innerHTML = '<span class="badge badge-success">接続中</span>';
        } else {
            this.statusElement.innerHTML = '<span class="badge badge-danger">切断</span>';
        }
    }
}

// 初期化
const statusMonitor = new ServerStatusMonitor();
```

### HTML UI例

```html
<!-- index.html (Flask配信) -->
<!DOCTYPE html>
<html>
<head>
    <title>Smart Pet Camera</title>
    <link rel="stylesheet" href="/static/style.css">
</head>
<body>
    <div class="header">
        <h1>Smart Pet Camera</h1>
        <div id="server-status">接続確認中...</div>
    </div>

    <div class="main-container">
        <!-- WebRTC Video -->
        <div class="video-container">
            <video id="webrtc-video" autoplay playsinline></video>
            <canvas id="bbox-canvas"></canvas>
        </div>

        <!-- 録画コントロール -->
        <div class="controls">
            <h2>録画制御</h2>
            <div id="recording-status">状態確認中...</div>

            <button id="start-recording" class="btn btn-danger">
                録画開始
            </button>
            <button id="stop-recording" class="btn btn-secondary" disabled>
                録画停止
            </button>
        </div>
    </div>

    <script type="module">
        import { WebRTCVideoClient } from './static/webrtc_client.js';
        import { BBoxOverlay } from './static/bbox_overlay.js';

        // WebRTC設定を取得
        const configResponse = await fetch('/api/webrtc/config');
        const config = await configResponse.json();

        // WebRTCクライアント初期化（Goサーバーに直接接続）
        const video = document.getElementById('webrtc-video');
        const webrtcClient = new WebRTCVideoClient(video, config.signaling_url);
        await webrtcClient.start();

        // BBoxオーバーレイ（Flask SSEから受信）
        const canvas = document.getElementById('bbox-canvas');
        const overlay = new BBoxOverlay(video, canvas);

        // 録画制御
        document.getElementById('start-recording').addEventListener('click', async () => {
            const response = await fetch('/api/recording/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({})
            });
            const data = await response.json();
            console.log('Recording started:', data);
        });

        document.getElementById('stop-recording').addEventListener('click', async () => {
            const response = await fetch('/api/recording/stop', {
                method: 'POST'
            });
            const data = await response.json();
            console.log('Recording stopped:', data);
        });
    </script>
    <script src="/static/server_status.js"></script>
</body>
</html>
```

---

## 実装詳細

### Flask側の実装

```python
# src/monitor/web_monitor.py
import os
import requests
from flask import Flask, jsonify, request, Response, render_template

app = Flask(__name__)

# Go Server URL (環境変数で設定可能)
GO_SERVER_URL = os.getenv("GO_SERVER_URL", "http://localhost:8081")

# ================
# UI配信
# ================

@app.route("/")
def index():
    """WebRTC統合UI"""
    return render_template("index.html")

# ================
# WebRTC設定
# ================

@app.route("/api/webrtc/config")
def webrtc_config():
    """WebRTC設定を返す"""
    return jsonify({
        "signaling_url": GO_SERVER_URL,
        "ice_servers": [
            {"urls": "stun:stun.l.google.com:19302"}
        ]
    })

# ================
# 録画制御（Goプロキシ）
# ================

def proxy_to_go(path, method="GET", data=None, timeout=5):
    """Go Serverへのプロキシヘルパー"""
    try:
        url = f"{GO_SERVER_URL}{path}"

        if method == "GET":
            response = requests.get(url, timeout=timeout)
        elif method == "POST":
            response = requests.post(url, json=data, timeout=timeout)
        else:
            return jsonify({"error": "Unsupported method"}), 400

        return jsonify(response.json()), response.status_code

    except requests.ConnectionError:
        return jsonify({
            "error": "Go server unavailable",
            "message": "ストリーミングサーバーに接続できません"
        }), 503
    except requests.Timeout:
        return jsonify({
            "error": "Go server timeout",
            "message": "ストリーミングサーバーの応答がタイムアウトしました"
        }), 504
    except Exception as e:
        return jsonify({
            "error": "Proxy error",
            "message": str(e)
        }), 500

@app.route("/api/recording/start", methods=["POST"])
def recording_start():
    """録画開始（Goプロキシ）"""
    data = request.get_json() or {}
    return proxy_to_go("/start", method="POST", data=data)

@app.route("/api/recording/stop", methods=["POST"])
def recording_stop():
    """録画停止（Goプロキシ）"""
    return proxy_to_go("/stop", method="POST")

@app.route("/api/recording/status", methods=["GET"])
def recording_status():
    """録画状態（Goプロキシ）"""
    return proxy_to_go("/status", method="GET", timeout=2)

# ================
# Go Serverヘルスチェック
# ================

@app.route("/api/go/health", methods=["GET"])
def go_health():
    """Go Serverのヘルスチェック"""
    return proxy_to_go("/health", method="GET", timeout=2)

# ================
# BBox SSE（既存）
# ================

@app.route("/api/detections/stream")
def detections_stream():
    """BBox情報のSSE配信（既存のまま）"""
    def generate():
        while True:
            detections, _ = shm.read_detection()
            if detections:
                data = {
                    "detections": [
                        {
                            "class_name": d.class_name,
                            "confidence": d.confidence,
                            "bbox": {
                                "x": d.bbox.x,
                                "y": d.bbox.y,
                                "w": d.bbox.w,
                                "h": d.bbox.h
                            }
                        }
                        for d in detections.detections
                    ]
                }
                yield f"data: {json.dumps(data)}\n\n"
            time.sleep(0.033)  # 30fps

    return Response(generate(), mimetype='text/event-stream')

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
```

---

## 段階的移行

### Phase 1: 並行稼働（検証）

```
┌────────────────┐
│ Browser        │
└───┬────────┬───┘
    │        │
    │        └──────────────────┐
    │                           │
    ▼                           ▼
┌────────────────┐      ┌──────────────┐
│ Flask (8080)   │      │ Go (8081)    │
│ - UI           │      │ - WebRTC     │
│ - Proxy        │◄────►│ - Recording  │
│ - BBox SSE     │      └──────────────┘
└────────────────┘
```

**期間**: 1週間
**目標**:
- Go実装の安定性確認
- 性能測定（CPU、メモリ、レイテンシ）
- Flask-Go連携の動作確認

---

### Phase 2: 本番切り替え

```
┌────────────────┐
│ Browser        │
└────────┬───────┘
         │
         ▼
┌────────────────┐
│ Flask (8080)   │
│ - UI           │◄──────┐
│ - Proxy        │       │
│ - BBox SSE     │       │
└────────┬───────┘       │
         │               │
         ▼               │
┌──────────────┐         │
│ Go (8081)    │─────────┘
│ - WebRTC     │
│ - Recording  │
└──────────────┘
```

**期間**: 本番運用開始
**rollback**: 問題があればPython WebRTCに戻す

---

### Phase 3: 最適化（将来）

```
┌────────────────┐
│ Browser        │
└────────┬───────┘
         │
         ▼
┌──────────────────────┐
│ Go (8080)            │
│ - UI (embed静的)     │
│ - WebRTC             │
│ - Recording          │
│ - BBox SSE           │
└──────────────────────┘
```

**目標**: Flaskを完全に置き換え（オプション）

---

## まとめ

### 推奨構成

| コンポーネント | ポート | 役割 |
|--------------|-------|------|
| **Flask** | 8080 | UI配信、APIプロキシ、BBox SSE |
| **Go Server** | 8081 | WebRTC配信、H.264録画、状態管理 |

### データフロー

| 機能 | フロー |
|------|--------|
| **UI表示** | Browser → Flask → HTML |
| **WebRTC** | Browser → Go (直接) |
| **BBox** | Browser ← Flask ← SSE |
| **録画制御** | Browser → Flask → Go (proxy) |
| **状態取得** | Browser → Flask → Go (proxy) |

### 利点

1. ✅ **既存UI維持**: Flask UIをそのまま使用
2. ✅ **段階的移行**: リスク最小化
3. ✅ **責任分離**: Flask=UI、Go=ストリーミング
4. ✅ **低遅延**: WebRTCは直接接続
5. ✅ **シンプルな管理**: ブラウザは1つのURL（Flask）にアクセス

---

**Last Updated**: 2025-12-26
**Author**: Claude Sonnet 4.5
**Status**: 設計完了
