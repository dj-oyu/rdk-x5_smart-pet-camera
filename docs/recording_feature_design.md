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

1. **即時対応**: HTTP専用ポートでMJPEG配信（M5Stack対応） ✅完了
2. ブラウザ側録画の実装
3. iOS Safariでのテスト
4. （将来）サーバー側録画の検討

---

## 4. MJPEG視聴時の録画対応

### 課題

MJPEGモードではMediaRecorder APIが使用できない（MediaStreamがない）。
WebRTCモードでのみ録画可能という制限がある。

### 解決策の検討

#### Option A: サーバー側H.264保存 + ダウンロード（推奨）

```
┌─────────────────────────────────────────────────────────────┐
│                      サーバー側                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Camera Daemon ──H.264 NALs──> Ring Buffer (共有メモリ)      │
│                                      │                       │
│                    POST /api/recording/start                 │
│                                      ▼                       │
│                              Recording Service               │
│                              (Go goroutine)                  │
│                                      │                       │
│                                      ▼                       │
│                              recordings/                     │
│                              └── {timestamp}.h264            │
│                                                              │
│                    POST /api/recording/stop                  │
│                                      ▼                       │
│                              ffmpeg -c copy → .mp4           │
│                                      │                       │
│                    GET /api/recording/download               │
│                                      ▼                       │
│                              ブラウザでダウンロード            │
└─────────────────────────────────────────────────────────────┘
```

**メリット:**
- MJPEGモードでも録画可能
- H.264をそのまま保存（再エンコードなし、CPU負荷ゼロ）
- サーバー側で一元管理

**デメリット:**
- ストレージ容量の管理が必要
- ダウンロード待ち時間（mux処理）

**実装ポイント:**
1. 録画開始時にH.264 NALパケットをファイルに直接書き込み
2. 録画停止時に `ffmpeg -f h264 -i input.h264 -c copy output.mp4` でmux
3. MP4をダウンロード可能にする

#### Option B: Canvas Capture（フォールバック）

MJPEGの`<img>`要素からcanvasにキャプチャして録画。

```javascript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
const imgElement = document.getElementById('stream');

function captureFrame() {
    ctx.drawImage(imgElement, 0, 0);
}
// 30fpsでキャプチャしてMediaRecorderに渡す
```

**デメリット:**
- 完全な再エンコード（CPU負荷高）
- フレームレート制限（実質15-20fps程度）
- 画質劣化

#### Option C: ハイブリッドアプローチ（最終推奨）

| モード | 録画方法 |
|--------|----------|
| WebRTC | ブラウザ側 MediaRecorder（現行実装） |
| MJPEG  | サーバー側 H.264保存 + ダウンロード |

**UI:**
- 録画ボタンは共通
- 内部で現在のモードを判定して適切な録画方法を選択

---

## 5. BBox・日時オーバーレイ付き録画

### 要件

録画時にオプションで選択可能：
1. **素の映像** - H.264そのまま
2. **BBox付き** - 検出結果のバウンディングボックスを合成
3. **日時付き** - タイムスタンプを合成
4. **BBox + 日時** - 両方を合成

### 実現性分析

#### WebRTCモード（ブラウザ側録画）

| オプション | 実現性 | 方法 |
|-----------|--------|------|
| 素の映像 | ✅ 簡単 | video.srcObjectをそのまま録画 |
| BBox付き | ✅ 効率的 | **既存の配信画面をそのままキャプチャ** |
| 日時付き | ✅ 効率的 | 既存のbbox-canvasに日時描画を追加 |
| 両方 | ✅ 効率的 | 同上 |

**効率的なアプローチ: 配信画面の流用**

現在の配信画面は既に `video + bbox-canvas` の合成表示になっている。
録画のために改めて合成処理を行う必要はなく、**表示中の合成結果をそのままキャプチャ**すればよい。

```javascript
// 方法1: webrtc-view全体をキャプチャ（video + canvasの合成済み）
const webrtcView = document.getElementById('webrtc-view');

// html2canvas等でDOM要素をキャプチャ、またはより効率的に：
// 方法2: 既存のbbox-canvasに日時も描画し、video + canvasを合成
function startOverlayRecording() {
    const recordCanvas = document.createElement('canvas');
    const ctx = recordCanvas.getContext('2d');
    recordCanvas.width = video.videoWidth;
    recordCanvas.height = video.videoHeight;

    function compositeFrame() {
        // videoフレーム + 既存のbbox-canvas（既にBBox描画済み）を重ねるだけ
        ctx.drawImage(video, 0, 0);
        ctx.drawImage(bboxCanvas, 0, 0);  // 既存の描画結果を流用
    }

    // requestAnimationFrameで既に描画ループが回っているので
    // そこに録画用のキャプチャを追加するだけ
    const stream = recordCanvas.captureStream(30);
    // ...
}
```

**ポイント:**
- BBoxOverlayクラスは既に毎フレーム描画している
- 録画時は追加の合成計算不要、既存の描画結果をコピーするだけ
- 日時表示もBBoxOverlay._drawStats()に追加すれば録画にも反映される

**トレードオフ:**
- 再エンコードは発生（VP8/VP9）
- ただしCPU負荷は最小限（合成計算の二重化を回避）

#### MJPEGモード（サーバー側録画）

> ⚠️ **重要: RDK-X5はSBCであり、カメラキャプチャへの影響を最小限にする必要がある**

| オプション | 実現性 | 方法 | 録画中の負荷 |
|-----------|--------|------|-------------|
| 素の映像 | ✅ 最適 | H.264 NALをそのまま保存 | ほぼゼロ |
| BBox付き | ⚠️ 後処理 | メタデータ保存 → 停止後に合成 | ほぼゼロ |
| 日時付き | ⚠️ 後処理 | タイムスタンプ保存 → 停止後に合成 | ほぼゼロ |

**設計原則: 録画中は追加コストゼロ**

```
録画中:
┌─────────────────────────────────────────────────────────────┐
│  Camera Daemon ──H.264 NALs──> ファイル書き込み (I/Oのみ)    │
│                                                              │
│  Detection SHM ──────────────> detections.jsonl (追記のみ)   │
│                                                              │
│  ※ デコード・エンコード・合成処理は一切行わない               │
└─────────────────────────────────────────────────────────────┘

録画停止後（バックグラウンド or オンデマンド）:
┌─────────────────────────────────────────────────────────────┐
│  video.h264 + detections.jsonl                               │
│        │                                                     │
│        v                                                     │
│  ffmpeg（低優先度で実行、nice値調整）                         │
│        │                                                     │
│        v                                                     │
│  output.mp4（オーバーレイ合成済み）                           │
└─────────────────────────────────────────────────────────────┘
```

**ffmpegオーバーレイ合成（後処理）:**

```bash
# 素の映像（muxのみ、CPU負荷最小）
ffmpeg -f h264 -i video.h264 -c copy output.mp4

# BBox付き（要再エンコード、録画停止後に実行）
# detections.jsonlからffmpeg drawbox filterを生成するスクリプトが必要
nice -n 19 ffmpeg -i video.mp4 \
    -vf "drawbox=x=100:y=100:w=50:h=50:c=green:t=2" \
    -c:v libx264 -preset fast output_with_bbox.mp4

# 日時付き
nice -n 19 ffmpeg -i video.mp4 \
    -vf "drawtext=text='%{pts\:localtime\:1705574400}':fontsize=24:fontcolor=white:x=10:y=h-30" \
    -c:v libx264 -preset fast output_with_timestamp.mp4
```

### ハードウェアエンコーダーの活用（要調査）

RDK-X5にはVPU（Video Processing Unit）が搭載されており、H.264/H.265のハードウェアエンコードが可能。

**RDK-X5 Multimedia スペック:**
- H.265 (HEVC) Main Profile @ L5.1
- H.264 (AVC) Baseline/Main/High Profiles @ L5.2
- 最大 3840x2160@60fps エンコード/デコード

**利用可能なAPI:**

| API | 説明 | ffmpeg連携 |
|-----|------|-----------|
| [hobot_codec](https://github.com/D-Robotics/hobot_codec) | ROS2向けコーデック | 直接利用不可 |
| hobot-multimedia | 低レベルマルチメディアライブラリ | 要調査 |
| V4L2 M2M | 標準Linuxインターフェース | `h264_v4l2m2m` |

**調査項目:**

1. **V4L2 M2Mデバイスの確認:**
   ```bash
   ls -la /dev/video*
   v4l2-ctl --list-devices
   ffmpeg -encoders | grep v4l2
   ```

2. **V4L2 M2Mエンコーダーが使える場合:**
   ```bash
   # CPUエンコード (libx264)
   ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4

   # HWエンコード (V4L2 M2M) ← 調査対象
   ffmpeg -i input.mp4 -c:v h264_v4l2m2m output.mp4
   ```

3. **hobot-multimediaを直接使う場合:**
   - ffmpegを使わず、Goからhobot-multimedia APIを呼び出す
   - CGOでCライブラリをラップする必要あり
   - 実装コストは高いが、最も効率的

**期待される効果:**

| エンコーダー | CPU負荷 | 速度 | 備考 |
|-------------|--------|------|------|
| libx264 (CPU) | 高 | 遅い | カメラキャプチャに影響の恐れ |
| h264_v4l2m2m (HW) | 低 | 速い | 要V4L2対応確認 |
| hobot-multimedia (HW) | 最低 | 最速 | 実装コスト高 |

**推奨アプローチ:**

1. まずV4L2 M2Mが使えるか確認（低コスト）
2. 使えない場合は `nice -n 19` + `libx264 -preset ultrafast` で妥協
3. 将来的にhobot-multimedia統合を検討

> **参考:**
> - [D-Robotics RDK Documentation](https://d-robotics.github.io/rdk_doc/en/RDK/)
> - [hobot_codec GitHub](https://github.com/D-Robotics/hobot_codec)

**妥協点:**
- オーバーレイ付き録画はダウンロードまで待ち時間が発生
- 素の映像は即座にダウンロード可能
- UIで「処理中...」表示、完了後に通知

### ストレージ管理戦略

**原則: オリジナルデータは保持、生成物は削除可能**

```
recordings/
└── 2026-01-19_00-45-00/
    ├── video.h264           # 保持（オリジナル）
    ├── detections.jsonl     # 保持（オリジナル）
    ├── video.mp4            # 削除可（mux済み、再生成可能）
    └── video_overlay.mp4    # 削除可（合成済み、再生成可能）
```

**削除ルール:**

| ファイル | 削除条件 | 理由 |
|---------|---------|------|
| `video.h264` | 手動のみ | オリジナル、復元不可 |
| `detections.jsonl` | 手動のみ | オリジナル、復元不可 |
| `video.mp4` | 自動削除可 | `ffmpeg -c copy` で即座に再生成 |
| `video_overlay.mp4` | 自動削除可 | 再生成可能（時間はかかる） |

**自動削除の実装案:**

```go
// 生成物のTTL（例: 24時間）
const GeneratedFileTTL = 24 * time.Hour

func cleanupGeneratedFiles() {
    // video.mp4, video_overlay.mp4 のみ対象
    // video.h264, detections.jsonl は削除しない
    for _, recording := range listRecordings() {
        for _, file := range []string{"video.mp4", "video_overlay.mp4"} {
            path := filepath.Join(recording, file)
            if info, err := os.Stat(path); err == nil {
                if time.Since(info.ModTime()) > GeneratedFileTTL {
                    os.Remove(path)
                    log.Info("Cleaned up", "file", path)
                }
            }
        }
    }
}
```

**オンデマンド再生成:**

```
GET /api/recordings/{name}/download?overlay=true

1. video_overlay.mp4 が存在 → 即座に返却
2. 存在しない → ffmpeg合成 → 返却（待ち時間あり）
```

**ストレージ容量の見積もり:**

| 保持期間 | H.264 + jsonl | 生成物込み（最大） |
|---------|--------------|------------------|
| 1時間分 | ~270MB | ~540MB |
| 24時間分 | ~6.5GB | ~13GB |
| 7日分 | ~45GB | ~90GB |

> 生成物を自動削除すれば、ストレージは約半分で済む

### 推奨実装方針

| モード | 素の映像 | オーバーレイ付き |
|--------|----------|-----------------|
| WebRTC | MediaRecorder (H.264パススルー) | 配信画面キャプチャ (VP8/9) |
| MJPEG  | サーバーH.264保存（即時） | 後処理ffmpeg合成（待ち時間あり） |

**UIフロー:**
```
┌─────────────────────────────────────────────────────────────┐
│  録画オプション                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ ● 素の映像       │  │ ○ 画面そのまま    │                 │
│  │   (推奨・高速)   │  │   (BBox+日時付き) │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                              │
│  ※ MJPEGモードで「画面そのまま」を選択した場合、              │
│    録画停止後に変換処理が行われます                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. マイコン端末からの録画コントロール（M5Stack Tab5）

### ユースケース

M5Stack Tab5をMJPEG表示専用端末として使用しながら、タッチUIで録画操作を行う。

```
┌─────────────────────────────────────────────────────────────┐
│                    M5Stack Tab5                              │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │                                                     │    │
│  │              MJPEG ストリーム表示                    │    │
│  │              (HTTP:8082/stream)                     │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │  ● REC  │  │  ■ STOP │  │  STATUS │  │  LIST   │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│                                                              │
│  Recording: 00:05:23  [■■■■■■░░░░] 45MB                     │
└─────────────────────────────────────────────────────────────┘
```

### HTTP API（ポート8082）

既存のAPI設計を拡張:

| エンドポイント | メソッド | 説明 | レスポンス例 |
|---------------|---------|------|-------------|
| `/api/recording/start` | POST | 録画開始 | `{"status":"recording","file":"2026-01-19_00-45-00"}` |
| `/api/recording/stop` | POST | 録画停止 | `{"status":"stopped","file":"...","size_mb":45.2}` |
| `/api/recording/status` | GET | 録画状態 | `{"recording":true,"duration_sec":323,"size_mb":45}` |
| `/api/recordings` | GET | 録画一覧 | `[{"name":"...","size_mb":45,"duration_sec":300}]` |
| `/api/recordings/{name}` | GET | 録画ダウンロード | MP4ファイル |
| `/api/recordings/{name}` | DELETE | 録画削除 | `{"deleted":true}` |

### M5Stack Tab5 実装例

```cpp
#include <HTTPClient.h>
#include <M5Unified.h>

const char* BASE_URL = "http://rdk-x5.local:8082";

// 録画開始
void startRecording() {
    HTTPClient http;
    http.begin(String(BASE_URL) + "/api/recording/start");
    int code = http.POST("");
    if (code == 200) {
        String resp = http.getString();
        // JSONパースして状態更新
        updateUI("Recording...");
    }
    http.end();
}

// 録画停止
void stopRecording() {
    HTTPClient http;
    http.begin(String(BASE_URL) + "/api/recording/stop");
    int code = http.POST("");
    if (code == 200) {
        String resp = http.getString();
        // ファイルサイズ等を表示
        updateUI("Stopped: 45.2MB");
    }
    http.end();
}

// ステータスポーリング（録画中のみ）
void pollStatus() {
    HTTPClient http;
    http.begin(String(BASE_URL) + "/api/recording/status");
    int code = http.GET();
    if (code == 200) {
        String resp = http.getString();
        // duration_sec, size_mb を表示更新
    }
    http.end();
}

// メインループ
void loop() {
    M5.update();

    // タッチイベント処理
    if (M5.Touch.getCount()) {
        auto touch = M5.Touch.getDetail();
        if (isRecButton(touch.x, touch.y)) {
            startRecording();
        } else if (isStopButton(touch.x, touch.y)) {
            stopRecording();
        }
    }

    // 録画中は1秒ごとにステータス更新
    if (isRecording && millis() - lastPoll > 1000) {
        pollStatus();
        lastPoll = millis();
    }
}
```

### 設計考慮事項

1. **シンプルなAPI**: マイコンのメモリ制約を考慮し、JSONレスポンスは最小限に
2. **ポーリング方式**: WebSocketは複雑なので、シンプルなHTTPポーリングで実装
3. **エラーハンドリング**: ネットワーク断を想定し、タイムアウト・リトライ処理
4. **ローカルストレージ不要**: 録画はサーバー側に保存、M5Stackはコントローラーのみ

### オプション: 録画一覧・再生UI

M5Stack側で録画一覧を表示し、選択した録画をストリーム再生:

```
┌─────────────────────────────────────────────────────────────┐
│  録画一覧                                          [BACK]   │
├─────────────────────────────────────────────────────────────┤
│  ▶ 2026-01-19_00-45-00.mp4    45.2MB   5:23               │
│  ▶ 2026-01-18_23-30-15.mp4    128.5MB  15:42              │
│  ▶ 2026-01-18_20-00-00.mp4    256.0MB  32:10              │
│                                                              │
│  [DELETE]  [DOWNLOAD TO PC]                                 │
└─────────────────────────────────────────────────────────────┘
```

> **注意:** M5StackでのMP4再生は負荷が高いため、プレビューはMJPEGサムネイルか静止画で代替を検討

---

## 実装TODO

### Phase 1: 基本録画（WebRTCモード）
- [x] スキューモーフィック録画ボタンUI
- [x] MediaRecorder実装（ダミー状態）
- [ ] ダミーバッジ削除、実機能有効化
- [ ] 録画中タイマー表示復活
- [ ] iOS Safari対応テスト

### Phase 2: MJPEGモード対応（サーバー側録画）
- [ ] サーバー側Recording Service（Go）
- [ ] H.264 NAL直接保存（I/Oのみ、CPU負荷ゼロ）
- [ ] ffmpeg mux処理（録画停止後）
- [ ] ダウンロードAPI実装
- [ ] フロントエンドモード判定・切り替え

### Phase 3: オーバーレイ対応
- [ ] WebRTC: 配信画面キャプチャ録画
- [ ] MJPEG: detections.jsonl保存
- [ ] MJPEG: ffmpegオーバーレイ合成（nice -n 19）
- [ ] オプション選択UI

### Phase 4: M5Stack Tab5対応
- [ ] `/api/recordings` 一覧API
- [ ] `/api/recordings/{name}` ダウンロード/削除API
- [ ] M5Stack側サンプルコード
- [ ] タッチUI実装

### Phase 5: 改善
- [ ] ストレージ管理（古い録画の自動削除）
- [ ] 録画一覧・再生UI（Web）
- [ ] 録画中のLED/通知インジケーター

---

## 参考リンク

- [MediaRecorder API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [MediaRecorder.isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)
- [captureStream() - MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream)
