# TODO: 次のステップ

最終更新: 2025-12-26

## Phase 1: 実機検証（優先度：最高）

### 1.1 環境確認

- [ ] RDK X5ボードの起動確認
- [ ] カメラデバイスの接続確認
- [ ] libspcdevライブラリの存在確認
- [ ] Go環境の確認（`go version`）
- [ ] 必要なツールの確認（make, gcc, uv）

### 1.2 カメラデーモンテスト

- [ ] `camera_daemon_drobotics`単体での起動確認
- [ ] 共有メモリ `/dev/shm/pet_camera_active_frame` の生成確認
- [ ] 共有メモリ `/dev/shm/pet_camera_stream` の生成確認
- [ ] H.264データの書き込み確認（`scripts/profile_shm.py`使用）

### 1.3 統合起動テスト

- [ ] `scripts/run_camera_switcher_yolo_streaming.sh`の実行
- [ ] 全コンポーネントの起動確認
  - [ ] camera_switcher_daemon
  - [ ] yolo_detector_daemon
  - [ ] web_monitor (Flask)
  - [ ] streaming-server (Go)
- [ ] 各コンポーネントのログ確認
- [ ] プロセス起動順序の確認

### 1.4 WebRTC接続テスト

- [ ] Flask UI（http://localhost:8080/）へのアクセス確認
- [ ] Go server health check（`curl http://localhost:8081/health`）
- [ ] WebRTC offer送信テスト（curl使用）
- [ ] ブラウザからのWebRTC接続（手動SDP交換）
- [ ] 映像受信確認
- [ ] 複数クライアント接続テスト（2-3クライアント）

### 1.5 録画機能テスト

- [ ] 録画開始API（`curl -X POST http://localhost:8081/start`）
- [ ] 録画中のステータス確認（`curl http://localhost:8081/status`）
- [ ] 録画ファイル生成確認（`ls recordings/`）
- [ ] 録画停止API（`curl -X POST http://localhost:8081/stop`）
- [ ] 録画ファイルの再生テスト（`ffplay recordings/recording_*.h264`）
- [ ] ffprobeでのヘッダー確認（SPS/PPS存在確認）

### 1.6 エラーケーステスト

- [ ] カメラデーモン未起動時の挙動確認
- [ ] 共有メモリ削除時のリカバリ確認
- [ ] 最大クライアント数到達時の挙動（制限10クライアント）
- [ ] 録画中の再開始リクエスト処理
- [ ] 異常終了時のクリーンアップ確認

### 1.7 GPU最適化 (OpenCL)

- [ ] OpenCL環境セットアップ (`docs/gpu_capability_report.md`参照)
- [ ] `libopencl_wrapper.so` 実装 (NV12->RGB変換, Zero-Copy)
- [ ] Pythonバインディング実装
- [ ] `web_monitor.py` への統合とCPU負荷測定
- [ ] `yolo_detector_daemon.py` への統合と推論レイテンシ測定

---

## Phase 2: Flask UI統合（優先度：高）

### 2.1 プロキシエンドポイント実装

**ファイル:** `src/monitor/web_monitor.py`

- [ ] プロキシヘルパー関数実装
  ```python
  def proxy_to_go(path, method="GET", data=None, timeout=5):
      # Flask → Go proxy
  ```
- [ ] `/api/recording/start` エンドポイント追加
- [ ] `/api/recording/stop` エンドポイント追加
- [ ] `/api/recording/status` エンドポイント追加
- [ ] エラーハンドリング（Go server未起動時）
- [ ] タイムアウト設定

### 2.2 フロントエンドWebRTC実装

**ファイル:** `src/monitor/static/js/webrtc.js`（新規作成）

- [ ] WebRTC接続クラス実装
  ```javascript
  class WebRTCClient {
      async connect() { /* SDP offer/answer交換 */ }
      disconnect() { /* 切断処理 */ }
  }
  ```
- [ ] SDP offer生成
- [ ] Go serverへのoffer送信（fetch API使用）
- [ ] Answer受信とsetRemoteDescription
- [ ] ICE candidate処理
- [ ] video要素への映像表示

### 2.3 録画UI実装

**ファイル:** `src/monitor/templates/index.html`（更新）

- [ ] 録画開始ボタン追加
- [ ] 録画停止ボタン追加
- [ ] 録画状態表示（録画中/停止中）
- [ ] 録画情報表示
  - [ ] ファイル名
  - [ ] フレーム数
  - [ ] 録画時間
  - [ ] ファイルサイズ
- [ ] ステータスポーリング実装（1秒間隔）

### 2.4 WebRTC UI実装

**ファイル:** `src/monitor/templates/index.html`（更新）

- [ ] WebRTC接続ボタン追加
- [ ] 接続状態表示（接続中/切断中/エラー）
- [ ] video要素追加（WebRTC映像表示用）
- [ ] 統計情報表示（オプション）
  - [ ] フレームレート
  - [ ] ビットレート
  - [ ] パケットロス

### 2.5 統合テスト

- [ ] Flask UIからWebRTC接続確認
- [ ] Flask UIから録画開始/停止確認
- [ ] 録画状態のリアルタイム更新確認
- [ ] 複数タブでの同時接続テスト
- [ ] エラー時のUI挙動確認

---

## Phase 3: パフォーマンス測定（優先度：中）

### 3.1 リソース使用量測定

- [ ] メモリ使用量測定
  ```bash
  # Go server
  ps aux | grep streaming-server
  # 目標: <20MB
  ```
- [ ] CPU使用率測定
  ```bash
  top -p $(pgrep streaming-server)
  # 目標: <10%
  ```
- [ ] Python実装との比較
  - [ ] メモリ: Python 110MB vs Go <20MB
  - [ ] CPU: Python 25% vs Go <10%

### 3.2 レイテンシ測定

- [ ] フレームキャプチャ→表示までのエンドツーエンドレイテンシ
- [ ] 測定方法: タイムスタンプログ解析
- [ ] 目標: <100ms
- [ ] 複数クライアント時のレイテンシ変化確認

### 3.3 スループット測定

- [ ] 30fps維持確認（単一クライアント）
- [ ] 複数クライアント時のフレームレート
  - [ ] 2クライアント
  - [ ] 5クライアント
  - [ ] 10クライアント（最大）
- [ ] フレームドロップ率の測定（Prometheusメトリクス使用）

### 3.4 プロファイリング

- [ ] CPU プロファイル取得
  ```bash
  go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
  ```
- [ ] メモリプロファイル取得
  ```bash
  go tool pprof http://localhost:6060/debug/pprof/heap
  ```
- [ ] Goroutineプロファイル取得
  ```bash
  go tool pprof http://localhost:6060/debug/pprof/goroutine
  ```
- [ ] ボトルネック特定
- [ ] 最適化実施（必要に応じて）

### 3.5 負荷テスト

- [ ] 長時間稼働テスト（24時間）
  - [ ] メモリリーク確認
  - [ ] Goroutineリーク確認
  - [ ] ファイルディスクリプタリーク確認
- [ ] 最大クライアント数テスト（10クライアント同時接続）
- [ ] 録画長時間テスト（1時間録画）
  - [ ] ファイルサイズ確認
  - [ ] 再生確認

---

## Phase 4: エラーハンドリング強化（優先度：中）

### 4.1 エラー分類実装

**ファイル:** `src/streaming_server/internal/errors/errors.go`（新規作成）

- [ ] エラー型定義
  ```go
  var (
      ErrTemporary     = errors.New("temporary error")
      ErrFatal         = errors.New("fatal error")
      ErrFrameNotReady = errors.New("frame not ready")
      ErrBufferFull    = errors.New("buffer full")
      ErrShmClosed     = errors.New("shared memory closed")
  )
  ```
- [ ] エラー分類関数
  ```go
  func IsTemporary(err error) bool
  func IsFatal(err error) bool
  ```

### 4.2 リトライロジック実装

- [ ] 共有メモリ読み取りエラー時のリトライ
- [ ] WebRTC接続エラー時のリトライ（クライアント側）
- [ ] 録画ファイル書き込みエラー時の処理
- [ ] 指数バックオフ実装

### 4.3 構造化ロギング実装

**依存:** `github.com/rs/zerolog` または `go.uber.org/zap`

- [ ] ロガー初期化
- [ ] ログレベル制御（debug/info/warn/error）
- [ ] JSON形式ログ出力
- [ ] コンテキスト情報付与（goroutine ID、component名等）

### 4.4 ヘルスチェック拡張

- [ ] 詳細なヘルスステータス
  - [ ] 共有メモリアクセス可否
  - [ ] WebRTCクライアント接続状態
  - [ ] 録画状態
  - [ ] 直近のエラー数
- [ ] `/health` レスポンス拡張
  ```json
  {
    "status": "ok|degraded|error",
    "components": {
      "shm_reader": "ok",
      "webrtc_server": "ok",
      "recorder": "ok"
    },
    "metrics": { ... }
  }
  ```

---

## Phase 5: テストコード（優先度：低）

### 5.1 ユニットテスト

- [ ] `internal/h264/processor_test.go`
  - [ ] NAL unit解析テスト
  - [ ] SPS/PPSキャッシュテスト
  - [ ] ヘッダー付与テスト
- [ ] `internal/metrics/metrics_test.go`
  - [ ] メトリクス更新テスト
  - [ ] スレッドセーフティテスト
- [ ] `internal/recorder/recorder_test.go`
  - [ ] 録画開始/停止テスト
  - [ ] ステータス取得テスト

### 5.2 統合テスト

- [ ] 共有メモリモック作成
  ```go
  type MockShmReader struct {
      frames []*types.H264Frame
  }
  ```
- [ ] エンドツーエンドテスト
  - [ ] モックフレーム生成
  - [ ] WebRTC接続テスト
  - [ ] 録画テスト

### 5.3 ベンチマーク

- [ ] `internal/h264/processor_bench_test.go`
  ```go
  func BenchmarkNALParsing(b *testing.B) { ... }
  ```
- [ ] フレーム処理スループット測定
- [ ] メモリアロケーション測定

---

## Phase 6: 本番デプロイ（優先度：低）

### 6.1 systemdサービス化

**ファイル:** `/etc/systemd/system/streaming-server.service`

- [ ] サービスファイル作成
  ```ini
  [Unit]
  Description=Go Streaming Server
  After=network.target

  [Service]
  Type=simple
  User=camera
  ExecStart=/usr/local/bin/streaming-server -shm /pet_camera_stream
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```
- [ ] サービス有効化
  ```bash
  sudo systemctl enable streaming-server
  sudo systemctl start streaming-server
  ```

### 6.2 自動起動設定

- [ ] 依存関係定義（camera_daemon起動後）
- [ ] 起動順序制御
- [ ] 失敗時の再起動ポリシー

### 6.3 ログ管理

- [ ] systemd journalログ設定
- [ ] ログローテーション設定
  ```bash
  /var/log/streaming-server/*.log {
      daily
      rotate 7
      compress
      missingok
  }
  ```
- [ ] ログ保存先設定

### 6.4 監視設定

- [ ] Prometheusスクレイプ設定
  ```yaml
  scrape_configs:
    - job_name: 'streaming-server'
      static_configs:
        - targets: ['localhost:9090']
  ```
- [ ] Grafanaダッシュボード作成
  - [ ] フレームレート
  - [ ] クライアント数
  - [ ] 録画状態
  - [ ] エラー率
- [ ] アラート設定
  - [ ] メモリ使用量閾値
  - [ ] エラー率閾値
  - [ ] クライアント数閾値

### 6.5 バックアップ設定

- [ ] 録画ファイル自動バックアップ
- [ ] 設定ファイルバックアップ
- [ ] ログバックアップ

---

## Phase 7: 機能追加（優先度：低、将来的）

### 7.1 カメラ切替連携

- [ ] camera_switcher_daemonとの連携
- [ ] カメラ切替時のWebRTC再接続処理
- [ ] カメラ切替通知API

### 7.2 録画機能拡張

- [ ] 録画ファイル一覧API
- [ ] 録画ファイル削除API
- [ ] 録画ファイルダウンロードAPI
- [ ] 自動録画開始（イベント検出時）
- [ ] 録画スケジューリング

### 7.3 WebRTC機能拡張

- [ ] データチャネル対応（メタデータ送信）
- [ ] 音声ストリーミング対応
- [ ] 解像度切替対応
- [ ] ビットレート制御

### 7.4 認証・認可

- [ ] JWT認証実装
- [ ] APIキー認証
- [ ] ユーザー管理
- [ ] 権限管理

---

## ドキュメント更新

### 既存ドキュメント更新

- [ ] `README.md` - クイックスタートセクション更新
- [ ] `docs/development_roadmap.md` - Phase 3完了としてマーク
- [ ] `docs/go_streaming_server_design.md` - 実機テスト結果反映
- [ ] `docs/go_poc_implementation_log.md` - 実機テスト結果追記

### 新規ドキュメント作成

- [ ] `docs/go_streaming_production_guide.md` - 本番運用ガイド
- [ ] `docs/go_streaming_performance_report.md` - パフォーマンス測定結果
- [ ] `docs/go_streaming_troubleshooting.md` - トラブルシューティングガイド
- [ ] `docs/api_reference.md` - 完全なAPI仕様書

---

## 優先順位サマリ

### 今週中（最優先）

1. ✅ Phase 1.1-1.6: 実機検証
2. ✅ Phase 2.1-2.3: Flask UI統合（基本機能）

### 今月中（高優先度）

3. Phase 3.1-3.3: パフォーマンス測定
4. Phase 2.4-2.5: WebRTC UI完成

### 来月以降（中優先度）

5. Phase 3.4-3.5: プロファイリング＆負荷テスト
6. Phase 4: エラーハンドリング強化
7. Phase 6: 本番デプロイ

### 将来的（低優先度）

8. Phase 5: テストコード
9. Phase 7: 機能追加

---

**最終更新:** 2025-12-26
**次回更新予定:** 実機テスト完了後
