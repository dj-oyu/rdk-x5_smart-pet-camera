# 録画機能設計ドキュメント

## 概要

ペットカメラの映像を録画する機能の設計。2つのアプローチを検討する。

## 1. 閲覧端末に保存（ブラウザ側録画）

### 目標
- ブラウザAPIを使って軽量に実装
- できるだけH.264をそのまま保存（再エンコードなし）
- フォールバックとしてcanvasキャプチャ

### 技術選択肢

#### Option A: MediaRecorder API + WebRTC MediaStream（推奨）

WebRTCで受信したMediaStreamを直接MediaRecorder APIで録画。

```javascript
// WebRTCのMediaStreamを取得
const stream = videoElement.captureStream();
const recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=h264',  // または 'video/mp4;codecs=avc1'
  videoBitsPerSecond: 2000000
});
```

**メリット:**
- H.264をそのままWebMまたはMP4コンテナに格納可能
- 再エンコード不要で低CPU負荷
- ブラウザネイティブAPI

**デメリット:**
- ブラウザによってサポートするコーデック/コンテナが異なる
- iOSではMediaRecorderのH.264サポートが限定的

**ブラウザサポート:**
| ブラウザ | video/webm;codecs=h264 | video/mp4 |
|---------|------------------------|-----------|
| Chrome  | ✅ | ❌ |
| Firefox | ✅ | ❌ |
| Safari  | ❌ | ✅ (iOS 14.3+) |
| Edge    | ✅ | ❌ |

#### Option B: MediaRecorder + VP8/VP9フォールバック

H.264が使えない場合、VP8/VP9で録画。

```javascript
const mimeTypes = [
  'video/webm;codecs=h264',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
];
const supported = mimeTypes.find(t => MediaRecorder.isTypeSupported(t));
```

**トレードオフ:**
- VP8/VP9は再エンコードが発生するが、ほぼ全ブラウザでサポート

#### Option C: Canvas Capture（フォールバック）

MediaRecorderが使えない環境用のフォールバック。

```javascript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

function captureFrame() {
  ctx.drawImage(videoElement, 0, 0);
  // フレームをWebMに追加
}
```

**デメリット:**
- 完全に再エンコードが必要
- CPU負荷が高い
- フレームレート制限

### 推奨実装方針

1. **優先順位:**
   ```
   H.264 WebM > MP4 (Safari) > VP9 > VP8 > Canvas
   ```

2. **UIフロー:**
   - 録画ボタンクリック → 録画開始
   - 再度クリック → 録画停止 → ダウンロードダイアログ

3. **ファイル命名:**
   ```
   pet_camera_YYYYMMDD_HHMMSS.webm
   ```

### 実装タスク

- [ ] MediaRecorder対応状況の検出ロジック
- [ ] 録画開始/停止のUI実装
- [ ] Blobのダウンロード処理
- [ ] iOS Safari向けの特別対応（必要に応じて）

---

## 2. 配信端末に保存（サーバー側録画）

> **注意:** この機能は今回は実装しない。将来の参考用に設計のみ記載。

### 目標
- SBCの限られたリソースを考慮
- H.264データを再圧縮なしで保存
- Detection履歴・BBoxを後から合成可能に

### アーキテクチャ案

```
┌─────────────────────────────────────────────────────────┐
│                    配信端末 (SBC)                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Camera Daemon ──H.264 NALs──> Recording Service         │
│       │                              │                   │
│       v                              v                   │
│  Shared Memory               ┌──────────────┐            │
│       │                      │ video.h264   │ Raw H.264  │
│       v                      │ meta.jsonl   │ Timestamps │
│  YOLO Detector               │ detect.jsonl │ BBoxes     │
│       │                      └──────────────┘            │
│       v                                                  │
│  Detection SHM ─────────────────────────────────────────>│
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### ファイル構造

```
recordings/
└── 2026-01-18_19-30-00/
    ├── video.h264          # Raw H.264 bitstream (Annex B format)
    ├── timestamps.jsonl    # フレームタイムスタンプ
    │   {"frame": 1, "pts": 0, "dts": 0, "time": 1705574400.123}
    │   {"frame": 2, "pts": 33, "dts": 33, "time": 1705574400.156}
    │   ...
    └── detections.jsonl    # 検出結果
        {"frame": 1, "time": 1705574400.123, "detections": [...]}
        {"frame": 5, "time": 1705574400.189, "detections": [...]}
        ...
```

### 再生・合成の考慮

1. **Web再生機能:**
   - video.h264をMP4にmux（ffmpegまたはmp4box）
   - timestamps.jsonlでシーク位置を計算
   - detections.jsonlを読み込んでオーバーレイ描画

2. **オフライン合成:**
   ```bash
   # H.264をMP4にmux
   ffmpeg -f h264 -i video.h264 -c copy video.mp4

   # BBox付きで合成（要カスタムスクリプト）
   python render_with_bbox.py video.mp4 detections.jsonl output.mp4
   ```

3. **メタデータ同期:**
   - フレーム番号をキーにして video と detection を同期
   - PTS/DTSを使って正確なタイミングで描画

### リソース見積もり

| 項目 | 値 |
|-----|-----|
| H.264ビットレート | ~600kbps |
| 1分あたりのファイルサイズ | ~4.5MB |
| 1時間あたり | ~270MB |
| メタデータ（detection込み） | ~1MB/時間 |

### 実装タスク（将来）

- [ ] Recording Serviceの実装（Go）
- [ ] H.264 NALパケットの直接ファイル書き込み
- [ ] JSONLメタデータ生成
- [ ] Web再生UIの実装
- [ ] ストレージ管理（古い録画の自動削除）

---

## 決定事項

| 項目 | 決定 |
|------|------|
| Phase 1実装対象 | ブラウザ側録画のみ |
| 優先コーデック | H.264 (WebM) → MP4 → VP9 → VP8 |
| UIデザイン | 既存の録画ボタンを活用 |

---

## 3. マイコン端末からのコントロール（M5Stack Tab5等）

### 背景

- M5Stack Tab5等のマイコンでMJPEG再生専用端末を構築
- TLS/HTTPSに対応していない（または制限がある）
- シンプルなHTTP APIでコントロールしたい

### 要件

1. **MJPEGストリームはHTTPでも配信**
   - マイコンはTLS非対応の場合が多い
   - `/stream` エンドポイントはHTTPでアクセス可能に

2. **コントロールAPI**
   - 録画開始/停止
   - カメラ切り替え（Day/Night）
   - ステータス取得

### アーキテクチャ

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  iPhone/PC      │     │  M5Stack Tab5   │     │  SBC (RDK-X5)   │
│  (フル機能)      │     │  (MJPEG表示)    │     │                 │
└────────┬────────┘     └────────┬────────┘     │  ┌───────────┐  │
         │                       │              │  │ Go Server │  │
         │ HTTPS:8080            │ HTTP:8081    │  │           │  │
         │ - WebRTC              │ - /stream    │  │ :8080 TLS │  │
         │ - WebUI               │ - /api/*     │  │ :8081 HTTP│  │
         │ - API                 │              │  └───────────┘  │
         └───────────────────────┴──────────────┴─────────────────┘
```

### HTTP API エンドポイント（ポート8081）

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/stream` | GET | MJPEGストリーム |
| `/api/status` | GET | システムステータス |
| `/api/recording/start` | POST | 録画開始 |
| `/api/recording/stop` | POST | 録画停止 |
| `/api/recording/status` | GET | 録画状態 |
| `/api/camera/switch` | POST | カメラ切替 `{"camera": "day"\|"night"}` |
| `/api/camera/status` | GET | 現在のカメラ |

### 実装方針

#### Option A: デュアルポート（推奨）

```
:8080 - HTTPS (WebRTC + WebUI + API)
:8081 - HTTP  (MJPEG + API のみ)
```

**メリット:**
- セキュリティとアクセシビリティの両立
- iOS SafariはHTTPSでWebRTC、マイコンはHTTPでMJPEG

#### Option B: HTTP/HTTPS両対応（単一ポート）

同じポートでHTTPとHTTPSの両方を受け付ける。

**デメリット:**
- 実装が複雑
- 多くのクライアントがHTTPにダウングレード可能になる

### M5Stack Tab5 実装例

```cpp
// MJPEG表示
HTTPClient http;
http.begin("http://rdk-x5.local:8081/stream");

// 録画開始
http.begin("http://rdk-x5.local:8081/api/recording/start");
http.POST("");

// ステータス取得
http.begin("http://rdk-x5.local:8081/api/status");
String status = http.getString();
```

### 実装タスク

- [ ] HTTP専用ポート（8081）の追加
- [ ] MJPEGストリームをHTTPポートで配信
- [ ] APIエンドポイントをHTTPポートでも公開
- [ ] カメラ切替APIの実装

---

## 決定事項

| 項目 | 決定 |
|------|------|
| Phase 1実装対象 | ブラウザ側録画のみ |
| 優先コーデック | H.264 (WebM) → MP4 → VP9 → VP8 |
| UIデザイン | 既存の録画ボタンを活用 |
| HTTP/HTTPS | デュアルポート方式（:8080 HTTPS, :8081 HTTP） |
| マイコン対応 | HTTP APIで録画コントロール可能に |

## 次のステップ

1. **即時対応**: HTTP専用ポートでMJPEG配信（M5Stack対応）
2. ブラウザ側録画の実装
3. iOS Safariでのテスト
4. （将来）サーバー側録画の検討

---

## 参考リンク

- [MediaRecorder API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [MediaRecorder.isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)
- [captureStream() - MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream)
