# Night Assist — E2E テスト計画

## 概要

night-assist 機能の結合テスト手順書。
3デバイス (rdk-x5, ai-pyramid, 開発PC) での検証を段階的に進める。

---

## 前提条件

| 項目 | rdk-x5 | ai-pyramid |
|------|--------|------------|
| サービス | `pet-camera.target` | `pet-album.service` |
| ポート | 8080 (monitor), 8081 (streaming), **9265 (TCP relay)** | 8082 (HTTPS) |
| ネットワーク | 同一LAN、相互到達可能 | 同一LAN |
| カメラ | デュアルカメラ (DAY=0, NIGHT=1) | — |

### ホスト名解決

```bash
# ai-pyramid の /etc/hosts (または .env)
RDK_X5_HOST=<rdk-x5-ip>

# rdk-x5 の /etc/hosts (SSE購読用)
AI_PYRAMID_HOST=<ai-pyramid-ip>
```

---

## Phase 1: 単体テスト (各デバイス独立)

### 1-1. ai-pyramid: cargo test

```bash
cd src/ai-pyramid
cargo check && cargo clippy && cargo test
```

**期待結果**: 全テスト PASS (night_assist モジュールはネットワーク不要のためテスト対象外)

### 1-2. ai-pyramid: NPU/VPU 並行動作確認

ffmpeg HW decoder (VPU) と YOLO (NPU) が同時に動作できることを確認。

```bash
# Terminal 1: VPU デコードテスト (適当な H.265 ファイルで)
ffmpeg -c:v hevc_axdec -i /tmp/test.hevc -f null -

# Terminal 2: NPU 推論テスト (同時実行)
/usr/local/bin/ax_yolo26 /home/admin-user/models/yolo26/ax650/yolo26l.axmodel /tmp/test.jpg
```

**期待結果**: 両方エラーなく完了。SEGV なし。

### 1-3. rdk-x5: TCP relay ビルド確認

```bash
cd src/capture && make
```

**期待結果**: `tcp_relay.c` を含むビルド成功。`camera_daemon_drobotics` にリンク済み。

### 1-4. rdk-x5: Python detector に NightAssistMerger 追加確認

```bash
uv run python -c "from yolo_detector_daemon import NightAssistMerger; print('OK')"
```

**期待結果**: import エラーなし

---

## Phase 2: コンポーネント間接続テスト

### 2-1. TCP relay → ffmpeg 接続 (H.265 ストリーム)

#### rdk-x5 側: カメラデーモン起動 (デュアルカメラ)

```bash
sudo systemctl restart pet-camera-capture
sudo journalctl -u pet-camera-capture -f | grep -i "tcp.*relay"
```

**期待ログ**:
```
[INFO] TcpRelay: Listening on port 9265
```

#### ai-pyramid 側: ffmpeg 手動接続テスト

```bash
# キーフレーム1枚をデコードして保存
ffmpeg -c:v hevc_axdec -f hevc -i tcp://<rdk-x5>:9265 \
  -vf "select=eq(pict_type\,I)" -frames:v 1 /tmp/night_test.jpg

# 画像サイズ確認
file /tmp/night_test.jpg
identify /tmp/night_test.jpg 2>/dev/null || true
```

**期待結果**: 1280x720 の JPEG 画像が生成される

**トラブルシューティング**:
- 接続拒否 → rdk-x5 で `ss -tlnp | grep 9265` 確認
- タイムアウト → 夜間カメラが非活性。手動切替: `curl -X POST http://rdk-x5:8080/api/debug/switch-camera`
- デコードエラー → `hevc_axdec` なしの場合 `-c:v hevc` (SW) で試行

### 2-2. ai-pyramid YOLO → SSE 配信テスト

```bash
# ai-pyramid で night assist 付きで起動
sudo systemctl stop pet-album
./target/release/pet-album --rdk-x5-host <rdk-x5-ip> 2>&1 | tee /tmp/night-assist.log &

# 別ターミナル: SSE 購読テスト
curl -N -H "Accept: text/event-stream" \
  https://localhost:8082/api/night-assist/detections/stream -k
```

**期待出力** (夜間カメラ活性時):
```
event: detection
data: {"detections":[{"class_name":"cat","confidence":0.85,"bbox":{"x":340,"y":180,"w":200,"h":150}}],"source_width":1280,"source_height":720,"timestamp":1711785600.123}
```

**期待出力** (検出なし / 昼間):
```
: keepalive
```

### 2-3. rdk-x5 Python SSE 購読テスト

```bash
# rdk-x5 で ai-pyramid の SSE を購読
python3 -c "
import urllib.request, json
req = urllib.request.Request(
    'https://<ai-pyramid>:8082/api/night-assist/detections/stream',
    headers={'Accept': 'text/event-stream'}
)
import ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
    for line in resp:
        line = line.decode().strip()
        if line.startswith('data:'):
            data = json.loads(line[5:])
            print(json.dumps(data, indent=2))
            break
print('SSE connection OK')
"
```

**期待結果**: JSON パースエラーなし、検出データ受信

---

## Phase 3: E2E 結合テスト (夜間カメラ)

### 3-0. 全サービス起動

```bash
# rdk-x5
sudo systemctl start pet-camera.target

# ai-pyramid
sudo systemctl stop pet-album
# night assist 付きで起動 (.env に RDK_X5_HOST=<ip> を追加して systemd 経由でもOK)
RDK_X5_HOST=<rdk-x5-ip> ./target/release/pet-album \
  --photos-dir data/photos --db-path data/pet-album.db
```

### 3-1. 夜間カメラ切替 → TCP relay 活性化

```bash
# rdk-x5: 手動で夜間カメラに切替
curl -X POST http://localhost:8080/api/debug/switch-camera

# ログ確認
sudo journalctl -u pet-camera-capture --since "10s ago" | grep -E "(Switch|TcpRelay|camera)"
```

**期待ログ**:
```
[INFO] CameraSwitcher: Switching to NIGHT (camera 1)
[INFO] TcpRelay: Client connected (fd=N)
```

### 3-2. ai-pyramid 検出ループ確認

```bash
# ai-pyramid ログ監視
sudo journalctl -u pet-album -f | grep -i "night"
# または手動起動時の stdout
```

**期待ログ**:
```
Night assist enabled: rdk-x5 at <ip>
Connecting to rdk-x5 H.265 relay at <ip>:9265
```

**検出発生時**:
```
# SSE 監視 (別ターミナル)
curl -N -H "Accept: text/event-stream" \
  https://localhost:8082/api/night-assist/detections/stream -k 2>/dev/null | \
  grep "^data:" | head -5
```

### 3-3. 検出結果 → DetectionSHM 書込確認

```bash
# rdk-x5: detector ログで night-assist マージを確認
sudo journalctl -u pet-camera-detector -f | grep -i "night.assist\|merge"
```

**期待ログ** (NightAssistMerger 有効時):
```
[INFO] NightAssistMerger: SSE connected to ai-pyramid
[INFO] NightAssistMerger: Merged detection: cat (0.85) via ai-pyramid + motion
```

### 3-4. Web UI での bbox 表示確認

```bash
# ブラウザで MJPEG ストリーム確認
# https://<rdk-x5>:8080/stream
# または開発PC から:
open "https://<rdk-x5>:8080"
```

**期待結果**: 夜間IR映像上にcatの bbox が表示される

### 3-5. Comic 生成確認 (5秒持続検出)

```bash
# rdk-x5: comic capture ログ監視
sudo journalctl -u pet-camera-monitor -f | grep -i "comic"
```

**期待ログ** (catが5秒以上持続検出):
```
[INFO] ComicCapture: Cat detected for 5.0s, starting capture
[INFO] ComicCapture: Panel 1/4 captured
...
[INFO] ComicCapture: Comic complete: comic_20260330_235500_chatora.jpg
```

**確認**: 生成されたcomic画像を確認
```bash
ls -la /opt/smart-pet-camera/recordings/comics/ | tail -5
```

---

## Phase 4: エッジケーステスト

### 4-1. 昼夜切替サイクル

```bash
# rdk-x5: DAY → NIGHT → DAY を高速切替
curl -X POST http://localhost:8080/api/debug/switch-camera  # → NIGHT
sleep 10
curl -X POST http://localhost:8080/api/debug/switch-camera  # → DAY
sleep 5
curl -X POST http://localhost:8080/api/debug/switch-camera  # → NIGHT
```

**確認項目**:
- ai-pyramid: ffmpeg が TCP 切断→再接続を正常にハンドル
- rdk-x5: TCP relay が client_fd を正常にクリーンアップ
- メモリリークなし (長時間稼働後)

### 4-2. ai-pyramid 停止中の rdk-x5 動作

```bash
# ai-pyramid を停止
sudo systemctl stop pet-album

# rdk-x5 のカメラデーモンが影響を受けないことを確認
sudo journalctl -u pet-camera-capture --since "10s ago"
```

**期待結果**: TCP relay は client 未接続でも `tcp_relay_send()` が即 return。
エンコードパイプラインへの影響ゼロ。

### 4-3. NPU 競合テスト (VLM + YOLO 同時)

```bash
# ai-pyramid: night assist が YOLO を実行中に VLM リクエスト
# Terminal 1: night assist 稼働中を確認
curl -N https://localhost:8082/api/night-assist/detections/stream -k &

# Terminal 2: VLM 呼び出し (写真を ingest)
cp /tmp/test_comic.jpg data/photos/comic_20260330_120000_chatora.jpg
```

**期待結果**: `npu_semaphore` により YOLO がスキップされ、VLM が優先実行される。
VLM 完了後に YOLO が再開。

### 4-4. ネットワーク断 → 復旧

```bash
# ai-pyramid: iptables でTCP 9265をブロック
sudo iptables -A OUTPUT -d <rdk-x5> -p tcp --dport 9265 -j DROP

# 10秒後に解除
sleep 10
sudo iptables -D OUTPUT -d <rdk-x5> -p tcp --dport 9265 -j DROP
```

**期待結果**: ffmpeg がタイムアウト→プロセス終了→backoff (5s)→再接続成功

### 4-5. 高負荷テスト (長時間稼働)

```bash
# 夜間モードで1時間連続稼働
# 確認項目:
# - ai-pyramid RSS メモリ推移 (target: <50MB)
# - /tmp/night_assist_frame.jpg のディスク書込頻度 (~1/s)
# - SSE 接続のメモリリーク
# - ffmpeg プロセスの安定性

# メモリ監視 (ai-pyramid)
watch -n 10 'ps -o rss,vsz,pid,comm -p $(pgrep pet-album)'

# メモリ監視 (rdk-x5 camera daemon)
watch -n 10 'ps -o rss,vsz,pid,comm -p $(pgrep camera_daemon)'
```

---

## Phase 5: パフォーマンス計測

### 5-1. レイテンシ計測

```
エンコード完了 → TCP write → ネットワーク転送 → ffmpeg decode → YOLO → SSE送信 → SSE受信
```

```bash
# ai-pyramid: YOLO 推論時間の計測
# night_assist ログの detection イベント間隔から算出
grep "detection" /tmp/night-assist.log | \
  awk '{print $1}' | \
  awk 'NR>1{print $1-prev} {prev=$1}'
```

**期待値**:
| ステップ | 目標 |
|---------|------|
| TCP relay write | < 1ms |
| ネットワーク転送 (LAN) | < 5ms |
| ffmpeg decode (HW) | < 10ms |
| YOLO26l 推論 | ~11ms |
| SSE 送信→受信 | < 5ms |
| **合計** | **< 35ms** |

### 5-2. スループット確認

```bash
# ai-pyramid: 処理フレーム数カウント (1分間)
timeout 60 curl -N -H "Accept: text/event-stream" \
  https://localhost:8082/api/night-assist/detections/stream -k 2>/dev/null | \
  grep -c "^event: detection"
```

**期待値**: 夜間活性時 ~60イベント/分 (1fps キーフレーム)

### 5-3. 帯域使用量

```bash
# rdk-x5: TCP relay の帯域確認
# 30秒間の転送バイト数を計測
ss -i dst <ai-pyramid> dport = 9265
```

**期待値**: ~75 KB/s (600 kbps)

---

## チェックリスト

### 最小合格条件

- [ ] ai-pyramid: cargo test 全 PASS
- [ ] TCP relay: rdk-x5 port 9265 でリッスン確認
- [ ] ffmpeg: ai-pyramid から rdk-x5 へ TCP 接続、JPEG デコード成功
- [ ] YOLO: 夜間 IR フレームで cat 検出確認
- [ ] SSE: detection イベントが配信される
- [ ] DetectionSHM: マージ結果が書き込まれる
- [ ] Comic: 5秒持続検出で comic 画像が生成される

### 安定性条件

- [ ] 昼夜切替サイクル: ffmpeg 再接続が正常
- [ ] ai-pyramid 停止: rdk-x5 パイプラインに影響なし
- [ ] NPU 競合: semaphore でYOLO/VLM 排他動作
- [ ] 1時間稼働: メモリリークなし、RSS < 50MB
- [ ] ネットワーク断→復旧: 自動再接続

### パフォーマンス条件

- [ ] E2E レイテンシ < 35ms
- [ ] キーフレーム処理 ~1fps
- [ ] 帯域 ~75 KB/s (600 kbps)
