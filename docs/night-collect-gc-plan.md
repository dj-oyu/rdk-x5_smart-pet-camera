# rdk-x5 night_collect GC — 計画

## 背景

rdk-x5 上の収集ディレクトリが暴走している:

```
sunrise@ubuntu:/mnt/petcam-data/night_collect$ ls -l feeding | wc -l
409379
```

NV12 + 付属 JSON の対で生成されるため 約 20 万フレーム ≒ 1280×720×1.5B ≒ **270 GB クラス** がローカル `/mnt/petcam-data` に溜まっている。ai-pyramid 側ストレージは別途逼迫しており、ai-pyramid から SCP で全件取り込むのも不可能。

生成元: `src/detector/yolo_detector_daemon.py:1501-1528`
- `feeding_collect_dir = NIGHT_COLLECT_DIR / "feeding"`
- ファイル名: `feeding_{frame:08d}_1280x720.nv12` + `.json`
- JSON: `{frame, timestamp, width, height, nz_ratio, motion_bboxes}`

`night_collect_max = 500` (yolo_detector_daemon.py:469) はセッション当たりの上限であってディスク全体には効かない。デーモンが長時間稼働する設計のため、生成側だけでは増加を止められない。

## ゴール

- rdk-x5 側で `night_collect/feeding` (将来的に他サブディレクトリも) のサイズと件数を機械的に上限内に保つ。
- ai-pyramid 側のアノテーション運用 (PUT 済 approved / `is_bg_ref` / 取得済 JPEG キャッシュ) を壊さない。
- 既存の `yolo_detector_daemon.py` の責務は増やさない (収集と GC は分離)。

## 非ゴール

- ai-pyramid 側のキャッシュ GC (これは別タスク、ai-pyramid 内に LRU を入れる別案件)。
- night_collect の保存ルール (`FEEDING_SAVE_INTERVAL` 等) の見直し。
- 「approved/bg_ref フレームの永続退避」(rdk-x5 → ai-pyramid 強制 pull) — 後段で別途検討。

## 削除方針

### 採用: ハイブリッド (age + 件数上限)

1. **age cutoff (一次フィルタ)**: `mtime` が `MAX_AGE_DAYS` を超える `.nv12` を最古から削除する。同名の `.json` も対で削除。デフォルト 7 日。
2. **件数 / 容量上限 (二次フィルタ)**: 上記でまだ件数が `MAX_FILES` または合計サイズ `MAX_BYTES` を超えていれば、`mtime` 昇順でさらに削除する。
3. **常に対で削除**: NV12 単体や JSON 単体の孤児を残さない。GC pass 後に孤児 (`.nv12` ↔ `.json` の対が崩れているもの) をスキャンして掃除する。

### 不採用案と理由

- **size only**: 件数が多いと sync 時の `ssh ls` がそもそも遅いので、件数も明示的に絞る必要がある。
- **`find -mtime +N -delete` 一発**: 件数暴走時 (起動直後の累積分) に時間掛かりすぎる + 孤児 JSON の片付けが書きづらい。Python スクリプトで集約する。
- **デーモン内蔵**: 収集と削除を同じイベントループに混ぜると I/O ピークでデーモンが詰まる懸念。systemd timer の別プロセスにする。

## ai-pyramid との協調

**初期方針: 協調しない (rdk-x5 単独で削除を判断する)。**

理由:
- ai-pyramid → rdk-x5 の REST 往復を入れると、ai-pyramid 停止時に GC が止まる結合が生じる。
- ai-pyramid は閲覧 (`GET /api/training/frames/{id}/image`) と `bg/build` で SCP した時点でローカル JPEG キャッシュに残るので、リモートが消えても閲覧は継続できる (api.rs:235-277, training/ssh.rs:96-184)。
- ただし「approved だが一度も表示していない」フレームは JPEG キャッシュが無く、リモートが消えると失われる。これを許容する。

将来オプション (今は実装しない):
- ai-pyramid から `is_bg_ref=true` のファイル名一覧を JSON で吐き、rdk-x5 側 GC が「allow-list 」として読む。

## 実装内訳

### 追加するもの

| パス | 役割 |
|---|---|
| `scripts/night_collect_gc.py` | GC 本体。引数で dir/age/files/bytes を指定。dry-run 対応。 |
| `deploy/rdk-x5/pet-camera-night-gc.service` | oneshot systemd unit。 |
| `deploy/rdk-x5/pet-camera-night-gc.timer` | 1 時間ごとに `.service` を発火。 |
| `tests/test_night_collect_gc.py` | path/age/対削除 のユニットテスト (tmp_path)。 |

### スクリプト仕様 (`scripts/night_collect_gc.py`)

CLI:
```
night_collect_gc.py
  --dir PATH                 削除対象ディレクトリ (必須, 例: /mnt/petcam-data/night_collect/feeding)
  --max-age-days N           この日数より古い .nv12 を削除 (デフォルト 7)
  --max-files N              GC 後に残す最大件数 (.nv12 単位、デフォルト 5000)
  --max-bytes BYTES          GC 後の最大合計サイズ (.nv12 のみで計算、デフォルト 30GiB)
  --dry-run                  削除せずに削除予定をログ出力
  --log-json                 systemd-journal 向けに 1 行 JSON で要約を吐く
```

動作:
1. `dir` 配下を `.nv12` だけ走査し、`(path, mtime, size)` を集める。
2. age cutoff 適用 → 削除対象セット A。
3. 残ったうち `max-files` 超過分 を mtime 昇順で削除対象セット B に。
4. 残ったうち累積サイズが `max-bytes` を超える分 を mtime 昇順で C に。
5. A ∪ B ∪ C を一度に削除。各 `.nv12` に対して同名 `.json` も存在すれば削除。
6. 最後に「対の崩れ」(NV12 無しの JSON / その逆) を 1 周してクリーンアップ。
7. 結果 (`scanned, deleted_nv12, deleted_json, freed_bytes, elapsed_ms`) を ログに出す。

実装ノート:
- `pathlib` のみ。外部依存なし (rdk-x5 上の Python 3 で素直に動く)。
- 削除は `unlink(missing_ok=True)` で冪等に。
- `--dry-run` 中は ファイル変更を行わず、削除予定だけログに出して `exit 0`。
- `feeding_events.jsonl` (yolo_detector_daemon.py:474) は触らない。

### systemd 構成

`pet-camera-night-gc.service` (oneshot):
```
[Unit]
Description=GC night_collect feeding frames

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/smart-pet-camera/scripts/night_collect_gc.py \
  --dir /mnt/petcam-data/night_collect/feeding \
  --max-age-days 7 \
  --max-files 5000 \
  --max-bytes 32212254720 \
  --log-json
Nice=10
IOSchedulingClass=idle
```

`pet-camera-night-gc.timer`:
```
[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

`scripts/install-services.sh` への追記も忘れない (現在の他サービスと同じ手順)。

### テスト方針

1. **ユニット (tmp_path)**:
   - 古いファイル + 新しいファイル混在 → age cutoff のみで適切に削除されるか。
   - 件数超過時に mtime 昇順で削除されるか。
   - サイズ超過時の同上。
   - 孤児 JSON / 孤児 NV12 の片付け。
   - `--dry-run` でファイルが残ること。
2. **実機 (rdk-x5)**:
   - `--dry-run` でログを取り、削除対象数 ≒ 現状件数 − 5000 となることを確認。
   - 本実行で件数が `MAX_FILES` 以内になり、systemd-journal に JSON 1 行が出ることを確認。
   - ai-pyramid 側で `POST /api/training/sync` を流し、件数が減っていることを確認。
3. **回帰確認**:
   - `yolo_detector_daemon` が稼働中でも GC が走れる (open 中のファイルを誤って消さない、`mtime > X` 条件で守られる) ことを 1 周見る。

## 作業順序 (rdk-x5 側)

1. このブランチを `git fetch && git switch feat/rdk-x5-night-collect-gc`
2. `scripts/night_collect_gc.py` 実装 + `tests/test_night_collect_gc.py`
3. `uv run pytest tests/test_night_collect_gc.py` で緑
4. `deploy/rdk-x5/pet-camera-night-gc.{service,timer}` を追加
5. `scripts/install-services.sh` に追記
6. rdk-x5 上で:
   - `--dry-run` で現実件数を確認
   - 本実行
   - `systemctl enable --now pet-camera-night-gc.timer`
7. PR 作成 (main 直接 push 禁止 / branch protection)

## オープン課題

- `feeding_events.jsonl` の追記専用ログも長期的にローテートしたほうが良い (今回は対象外)。
- `night_collect` 直下 (`feeding/` 以外、`yolo_detector_daemon.py:466-468`) も同じ問題を抱える可能性。`--dir` を複数指定可能にするか、サブディレクトリ自動検出にするかは実装時に決める。
- approved/bg_ref フレームの永続退避が必要になった時点で、ai-pyramid 側に「`POST /api/training/snapshot` 的に JPEG キャッシュへ強制フェッチ」を実装する。
