# AI Pyramid Closed-loop Refactoring Plan

## 1. Objective

`src/ai-pyramid` の外部契約と実機動作を維持したまま、変更頻度の高い巨大モジュールを責務単位に分割する。

作業は単一のリファクタリングブランチでまとめて行う。ただし、壊れた状態を長時間保持しないよう、characterization tests、並列リライト、統合、CI、実機検証のゲートを順に通す。各ゲートの成功前に次の変更群を main へ統合しない。

### Goals

- HTTP/SSE/MCP、SQLite、Unix socket、ファイル名、環境変数の既存契約を固定する
- `main.rs`、`server/mod.rs`、training、local detector、VLM、EventDetail の責務を分離する
- GitHub CI で format、lint、test、coverage、aarch64 build を自動評価する
- CI artifact をデバイスへ配置し、systemd と実データで回帰確認する
- 今後の変更が一つの巨大ファイルへ集中しない構造にする

### Non-goals

- API、DB schema、wire protocol、UI仕様の意図的変更
- detector/VLMモデル、閾値、推論アルゴリズムの変更
- clone削減や `Cow<str>` など、効果未計測のマイクロ最適化
- 全ファイルを機械的に300行未満へ分割すること

## 2. Contracts to Freeze

以下はリファクタリング中の互換性境界とする。

- Go側からの `POST /api/photos/ingest` request/response
- album REST API、SSE event名とpayload、MCP JSON-RPC
- comic画像名 `comic_YYYYMMDD_HHMMSS[_pet].jpg`
- 既存SQLite DBのmigrationと読み書き
- `ax_yolo_daemon` の16-byte request、12-byte response/detection protocol
- OpenAI互換VLM APIと日次summaryのモデル切替・復旧動作
- training用NV12/JSON命名、SSH/SCP/ffmpeg入出力
- CLI、環境変数、TLS、systemd unit、embedded UI URL

## 3. Current Test Coverage Audit

調査日: 2026-08-23。Rustはデバイス上でビルドせず、GitHub Actionsを正規実行環境とする。

### Rust

- リファクタリング前は合計78テスト、characterization追加後は107テスト
- 最新のRust workflow成功: 2026-06-24
- 最新のaarch64 build成功: 2026-06-26
- CIにline/branch coverage計測は未導入

| Area | Tests | Assessment | Missing characterization |
|---|---:|---|---|
| `db` album operations | 14 | 中〜高 | migration fixture、failure/transaction paths |
| `server` | 13 | 中 | panel、photo patch、event、backfill、detect-now、edit history、behaviors、daily summary、night-assist、test assets |
| `vlm` | 12 | parserは高 | model swap、systemctl failure、restore failure、readiness timeout |
| `mcp` | 10 | 高 | 現状維持でよい |
| filename ingest | 9 | 高 | 現状維持でよい |
| local detector | 6 | 低〜中 | socket errors、partial reads、two-pass orchestration、model swap |
| training helpers | 6 | 低 | API 17 handlersとtraining DB操作は未テスト |
| application | 3 | 低〜中 | command error propagation、DB thread shutdown/failure |
| remote detect client | 2 | 低 | error/status/timeout and malformed response |
| watcher | 0 | 低 | initial scan、deleted source、retry ceiling、stability wait |
| bootstrap/main | 0 | 低 | config validation and composition |

`server` は約26のroute登録に対して13テストであり、成功系と主要エラー系の双方が固定されていないendpointが残る。training APIは17 handlerに対してroute testがないため、最優先でcharacterization testsを追加する。

### Frontend

- Bun tests: 27 pass
- 対象は `cancellable`、`store`、`upscaler` の3 test files
- `bun test --coverage` は92.31% functions / 95.83% linesと表示するが、レポートに含まれたproduction fileは `cancellable.ts` のみ
- components、API client、detail store、routingの全体coverage値としては使用できない

不足しているのは EventDetailのcomic/panel遷移、zoom、編集、検出override、SSE更新、失敗時表示、training annotation操作である。

## 4. Target Boundaries

最終的な名前は実装時に調整できるが、責務境界は次を基準にする。

```text
src/
  bootstrap/               config parsing, dependency construction, server start
  server/
    mod.rs                 state and router composition only
    photos.rs              photo/event CRUD and image serving
    detections.rs          detect-now and backfill transport
    events.rs              SSE and night-assist stream
    summary.rs             daily summary endpoint
    assets.rs              embedded SPA and test assets
  application/
    detection_backfill.rs  backfill workflow independent of HTTP
    db_thread/
      mod.rs               generic request loop
      album.rs             album commands
      training.rs          training commands
  training/
    api/
      mod.rs               router composition
      frames.rs
      annotations.rs
      background.rs
  detect/local/
    mod.rs                 public facade
    protocol.rs            packed wire types and encode/decode
    client.rs              Unix socket I/O
    pipeline.rs            panel/two-pass orchestration
    image.rs               crop, RGB/NV12 and bbox transforms
  vlm/
    mod.rs                 public facade and types
    parser.rs
    client.rs
    supervisor.rs          systemd model swap/readiness/recovery

ui/src/components/event-detail/
  index.tsx
  comic-view.tsx
  panel-carousel.tsx
  detection-list.tsx
  editor.tsx
  zoom.ts
```

`application/commands.rs`、`queries.rs`、`repository.rs` と MCP は既に責務が明確なので、必要なimport更新以外は再設計しない。

## 5. Execution Phases and Parallel Work

### Phase 0 — Baseline and branch

- [x] `refactor/ai-pyramid-closed-loop` branch作成
- [x] 現行テスト分布とCI履歴を監査
- [x] 外部契約とnon-goalsを記録
- [x] 現行artifactで `/health`、主要API、service logの実機baselineを保存

Baseline (2026-08-23):

- `pet-album.service`: active、RSS 52.1 MB
- `GET /health`: 200、`{"ok":true}`
- stats: total 6407、confirmed 3960、rejected 370、pending 2077

Gate: 現行mainのCI成功と実機baselineが確認できること。

### Phase 1 — Characterization tests

このphaseはproduction moduleを原則変更しないため、次のlaneを並列化できる。

| Lane | Work | Main files |
|---|---|---|
| A | album REST/SSE contract tests | `src/server/*_test.rs` or existing test module |
| B | training API and DB tests | `src/training/` |
| C | detector/VLM/watcher failure-path tests | `src/detect/`, `src/vlm/`, `src/ingest/` |
| D | EventDetail and training UI interaction tests | `ui/src/` |
| E | Rust and Bun coverage reporting in CI | `.github/workflows/rust.yml`, test config |

Required test additions:

- 全production endpointについて、最低1つの成功系または意図したavailability responseを固定
- mutation endpointはvalidation、not-found、成功を固定
- SQLite migrationを既存schema fixtureへ複数回適用
- packed protocolのbyte-level golden testsとtruncated/error response tests
- watcherのdeleted-file無限再queue、retry上限、stable-file判定
- VLM model swapでvision復旧を必ず試みることをfake supervisorで固定
- EventDetailのview transition、save、override、cancelをDOM testで固定

Coverage gateの導入手順:

1. 初回CIはcoverage report-onlyとしてbaselineを保存する
2. hardware/process adapterを分け、pure logicとHTTP contractの未実行箇所を埋める
3. baseline改善後、その達成値を最低値としてCIに設定する
4. 以後はline/branch coverageの低下を失敗扱いにする

Gate: format、clippy、Rust tests、Bun tests/buildが全成功し、取得可能なcoverage baselineを保存する。production behaviorに変更なし。

結果:

- [x] Rust characterization testsを追加し、107 tests成功
- [x] Bun testsを27から41へ追加、41 tests成功
- [x] `training-api.ts` line coverage 100%、function coverage 92.59%を確認
- [ ] Rust line/branch coverage CI（workflow変更はこのmoduleの書込scope外のため別作業）

### Phase 2 — Parallel structural rewrite

Phase 1のテストを固定後、以下を並列化する。各laneは所有ファイルを重ねない。

| Lane | Rewrite | Depends on |
|---|---|---|
| A | `server/mod.rs`をroute domain別に分割し、backfill workflowをapplicationへ抽出 | Phase 1A |
| B | training APIをframes/annotations/backgroundへ分割 | Phase 1B |
| C | local detectorをprotocol/client/pipeline/imageへ分割 | Phase 1C |
| D | VLMをparser/client/supervisorへ分割 | Phase 1C |
| E | EventDetailをview、zoom、editor、detection listへ分割し、兄弟`web`へのCSS依存を解消 | Phase 1D |

Rules:

- endpoint path、JSON field、status codeを変更しない
- wire struct layoutを変更しない
- SQLとmigrationの意味を変更しない
- algorithm、timeout、sleep、semaphore permit数を変更しない
- formatting-only moveとbehavior changeを同じcommitに混ぜない

Gate: 各laneを統合した状態で全自動テストが成功し、取得可能なcoverage baselineが低下しない。

結果:

- [x] serverをalbum/detection/events/summary/assets/test_pagesへ分割
- [x] training APIをframes/annotations/background/testsへ分割
- [x] local detectorをwire/client/image_conversion/pipelineへ分割
- [x] VLMをclient/parser/supervisorへ分割
- [x] EventDetailからmetadata editorとdetection listを抽出
- [x] GitHub Rust CI `32592676514` 成功

### Phase 3 — Integration rewrite

Phase 2で安定した公開constructorを使い、競合しやすいcomposition rootとDB command busを直列で整理する。

1. `DbCommand` とdispatchをalbum/training domainへ分割
2. `main.rs`からconfig解決とdependency constructionを`bootstrap`へ抽出
3. root router、event bridge、TLS起動を組み立て直す
4. staleな `docs/SPEC-refactor.md` を削除または現行計画へ誘導する
5. architecture documentを新しいmodule topologyへ更新する

Gate: `main.rs`はCLI parseとbootstrap呼出しを中心に約100行、各moduleの責務を1文で説明できること。全CI成功。

結果:

- [x] DB dispatchをalbum 22 command / training 15 commandへ分割
- [x] 全37 commandを網羅列挙し、新variant追加漏れをcompile error化
- [x] `main.rs`を332行から9行へ縮小、起動構成を`bootstrap`へ抽出
- [x] GitHub Rust CI `32593481852` 成功（fmt、Clippy、107 tests）

### Phase 4 — GitHub CI and device validation

1. branchをpushしてGitHub Actions workflowsを起動
2. Rust `fmt`、`clippy -D warnings`、tests、coverageを確認
3. aarch64 release workflow成功を確認
4. `pet-album-aarch64` artifactをデバイスへdownload
5. mainへ統合する段階で、現行binaryを退避後、`/opt/smart-pet-camera/build/pet-album`へinstall
6. mainへ統合する段階で、`pet-album.service`をrestartし、journalにpanic/errorがないことを確認
7. `/health`、album list/detail、ingest、SSE、MCP、training APIをsmoke test
8. local YOLO、VLM caption、daily summary/model restoreを実データで確認
9. capture/detector/streamingやSHM契約を変更した場合のみ `uv run scripts/profile_shm.py` を実行する

失敗時は退避したbinaryへ戻し、ログとfailure fixtureを保存してから修正する。

実施結果 (2026-08-23):

- [x] aarch64 workflow `32593541576` 成功（tests、release build、artifact upload）
- [x] `pet-album-aarch64`をデバイスの`/tmp`へdownload
- [x] AArch64 ELF64、7.1 MiB、SHA-256 `fee0bca50b1777fc677876f8b62e3df8529a1c611de42799e50dcf337c012afa`
- [x] 一時SQLite・一時photos・別port `127.0.0.1:18082`で起動
- [x] health、album list、stats、training stats、embedded SPAをsmoke test
- [x] ingest成功、invalid timestamp 400、登録event/detections readbackを確認
- [x] 稼働中`pet-album.service`とproduction DB/binaryは未変更
- [x] SHM profilerは対象外（ai-pyramidはSHMを直接読み書きせず、SHM module変更なし）
- [ ] productionへのinstall、service restart、実データ連携確認（main統合前には実施しない）

## 6. Acceptance Criteria

- 全既存外部契約がcharacterization testsで維持される
- GitHub CIのformat、clippy、Rust testsと、ローカルのBun tests/buildが成功
- aarch64 artifact buildと隔離環境でのdevice smoke testが成功
- main統合前に、既存SQLite DBをコピーしたfixtureでmigrationが成功し、件数と主要値が不変
- main統合前に、systemd restart後にserviceがactive、panicなし
- main統合前に、local detector、VLM、daily summary、MCPを実データで確認する
- pure logicとHTTP contractsのcoverage baselineを記録する（Rust coverage CIは別作業）
- UI coverageが一部ファイルだけでなく対象source一覧を正しく含む
- 意図的なfeature、schema、protocol、UI変更が含まれない

## 7. Commit Strategy

mainへ統合する場合は一つのrefactoring PRとするが、現段階ではPRを作成しない。branch内では次のcheckpoint commitを維持する。

1. `test: characterize ai-pyramid external contracts`
2. `ci: add backend and frontend coverage reporting`
3. `refactor: split server and training route domains`
4. `refactor: split detector and vlm infrastructure`
5. `refactor(ui): split event detail responsibilities`
6. `refactor: simplify database dispatch and bootstrap`
7. `docs: update ai-pyramid architecture after refactor`

これにより、CI失敗時にどの境界が壊れたかを特定でき、必要ならcheckpoint単位で安全に修正できる。
