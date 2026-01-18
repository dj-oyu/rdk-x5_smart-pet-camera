# セマフォを使ったIPC開発ガイド

## 概要

このドキュメントは、POSIX共有メモリとセマフォを組み合わせたイベント駆動型IPC（プロセス間通信）の実装で得られた知見をまとめたものです。

本プロジェクトでは、C言語で書かれたカメラデーモン、Python製のYOLO検出デーモン、Go言語のストリーミングサーバー間で、共有メモリとセマフォを使った効率的な通信を実現しています。

---

## セマフォとは

### 基本概念

**セマフォ（Semaphore）**は、複数のプロセス/スレッド間で同期を取るための仕組みです。内部に整数カウンタを持ち、以下の操作を提供します：

- **`sem_post()`**: カウンタを1増やす（シグナル送信）
- **`sem_wait()`**: カウンタが0より大きくなるまで待機し、1減らす（シグナル受信）
- **`sem_timedwait()`**: タイムアウト付きの`sem_wait()`

### 共有メモリとの組み合わせ

従来のポーリングベースのIPC:
```c
// ポーリング方式（非効率）
while (1) {
    read_shared_memory(&data);
    if (data.version != last_version) {
        process_data(&data);
        last_version = data.version;
    }
    usleep(10000);  // 10ms待機（CPUを無駄に消費）
}
```

セマフォベースのイベント駆動IPC:
```c
// イベント駆動方式（効率的）
while (1) {
    sem_wait(&shm->update_sem);  // 新しいデータが来るまでブロック（CPU使用率ほぼ0）
    read_shared_memory(&data);
    process_data(&data);
}
```

**利点**:
- CPU使用率が大幅に削減（ポーリングループなし）
- レイテンシが低い（データが来たら即座に処理）
- 電力効率が良い（CPUがスリープ可能）

---

## 実装の基本パターン

### 1. 共有メモリ構造体の定義

```c
// shared_memory.h
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;      // アトミック更新用
    sem_t detection_update_sem;     // イベント通知用セマフォ
} LatestDetectionResult;
```

**重要なポイント**:
- セマフォフィールド `sem_t` は構造体の**最後**に配置（パディングの影響を避ける）
- `volatile uint32_t version` でバージョン管理（スプリアスウェイクアップ対策）

### 2. 書き込み側（Producer）

```c
// camera_switcher_daemon.c (書き込み側)

// 1. 共有メモリ作成時にセマフォを初期化
LatestDetectionResult* shm = shm_detection_create();

// shm_detection_create() 内部
shm_fd = shm_open("/pet_camera_detections", O_CREAT | O_RDWR, 0666);
ftruncate(shm_fd, sizeof(LatestDetectionResult));
shm = mmap(..., PROT_READ | PROT_WRITE, ...);  // 読み書き可能でマップ

// セマフォ初期化（pshared=1: プロセス間共有, 初期値=0）
sem_init(&shm->detection_update_sem, 1, 0);

// 2. データ書き込み時にセマフォをポスト
void write_detection(LatestDetectionResult* shm, Detection* detections, int count) {
    // データ更新
    shm->num_detections = count;
    memcpy(shm->detections, detections, sizeof(Detection) * count);
    clock_gettime(CLOCK_REALTIME, &shm->timestamp);

    // バージョン更新（アトミック）
    __atomic_fetch_add(&shm->version, 1, __ATOMIC_SEQ_CST);

    // セマフォをポスト（待機中のプロセスに通知）
    sem_post(&shm->detection_update_sem);
}

// 3. クリーンアップ時にセマフォを破棄
sem_destroy(&shm->detection_update_sem);
shm_unlink("/pet_camera_detections");
```

### 3. 読み取り側（Consumer）

```c
// shm.go (Go言語での読み取り側)

// 1. 既存の共有メモリを開く（読み書き可能）
int fd = shm_open("/pet_camera_detections", O_RDWR, 0666);  // O_RDWR重要！
LatestDetectionResult* shm = mmap(
    NULL, sizeof(LatestDetectionResult),
    PROT_READ | PROT_WRITE,  // 書き込み権限必須（sem_wait()が内部状態を更新）
    MAP_SHARED, fd, 0
);

// 2. セマフォで待機
int wait_new_detection(LatestDetectionResult* shm) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 1;  // 1秒タイムアウト

    int ret = sem_timedwait(&shm->detection_update_sem, &ts);
    if (ret == -1) {
        if (errno == ETIMEDOUT) {
            return -2;  // タイムアウト（正常）
        } else if (errno == EINTR) {
            return -3;  // シグナル割り込み（正常、リトライ）
        } else {
            // 実際のエラー
            fprintf(stderr, "sem_timedwait error: errno=%d (%s)\n",
                    errno, strerror(errno));
            return -1;
        }
    }
    return 0;  // 成功
}

// 3. イベント駆動ループ
while (!stopped) {
    // セマフォで待機（ブロッキング）
    ret = wait_new_detection(shm);
    if (ret == -2 || ret == -3) continue;  // タイムアウト/割り込み
    if (ret != 0) break;  // エラー

    // データ読み取り
    uint32_t current_version = __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
    if (current_version != last_version) {
        process_detection(shm);
        last_version = current_version;
    }
}
```

---

## よくある落とし穴と対策

### 1. メモリアクセス権限エラー

**症状**: `sem_wait()` 実行時に SIGSEGV（Segmentation Fault）

**原因**: 共有メモリを読み取り専用でマップ

```c
// ❌ 間違い：読み取り専用
int fd = shm_open(name, O_RDONLY, 0666);
void* shm = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);

// ✅ 正解：読み書き可能
int fd = shm_open(name, O_RDWR, 0666);
void* shm = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
```

**理由**: `sem_wait()`/`sem_post()`はセマフォの内部カウンタを更新するため、**書き込み権限**が必須です。

**実際のエラーログ**:
```
SIGSEGV: segmentation violation
PC=0xffffb1b35b10 m=7 sigcode=2 addr=0xffffb1c11228
                               ↑ SEGV_ACCERR (アクセス拒否)
signal arrived during cgo execution
```

### 2. 構造体サイズの不一致

**症状**: 古いバージョンの共有メモリファイルが残っている状態で新しいコードを起動すると SIGSEGV

**原因**: 構造体にセマフォフィールドを追加したが、古い共有メモリファイルが残っている

```c
// 古いバージョン（520バイト）
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[10];
    volatile uint32_t version;
    // セマフォなし
} LatestDetectionResult;

// 新しいバージョン（584バイト）
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[10];
    volatile uint32_t version;
    sem_t detection_update_sem;  // +64バイト
} LatestDetectionResult;
```

新しいコードが古い520バイトのファイルを開くと：
```c
// 構造体サイズ計算
offsetof(LatestDetectionResult, detection_update_sem) = 520バイト

// セマフォアクセス
sem_wait(&shm->detection_update_sem);
// → base_address + 520バイトにアクセス
// → しかしファイルサイズは520バイトなので範囲外 → SIGSEGV
```

**対策**:
```c
// main() の最初で古い共有メモリを削除
shm_unlink(SHM_NAME_DETECTIONS);  // 古いファイルを削除
LatestDetectionResult* shm = shm_detection_create();  // 新規作成
```

**注意**: `shm_unlink()` を呼ぶには `<sys/mman.h>` が必要です。

### 3. 暗黙の関数宣言（Implicit Declaration）

**症状**: `shm_unlink()` を呼んでいるのに共有メモリが削除されない

**原因**: ヘッダーファイルのインクルード忘れ

```c
// ❌ 間違い
#include <errno.h>
#include <signal.h>
#include <unistd.h>
// <sys/mman.h> がない！

int main(void) {
    shm_unlink(SHM_NAME_DETECTIONS);  // 暗黙の宣言として扱われる
    // ...
}
```

**コンパイラ警告**:
```
warning: implicit declaration of function 'shm_unlink'; did you mean 'sem_unlink'?
  245 |   shm_unlink(SHM_NAME_DETECTIONS);
      |   ^~~~~~~~~~
      |   sem_unlink
```

**何が起きるか**:
1. コンパイラが `int shm_unlink()` と推測（間違った関数シグネチャ）
2. リンク時に正しい `shm_unlink()` が呼ばれない
3. 古い共有メモリが削除されない
4. 起動時に古いサイズのファイルを開く → SIGSEGV

**対策**:
```c
// ✅ 正解
#include <sys/mman.h>  // shm_open(), shm_unlink(), mmap()

int main(void) {
    shm_unlink(SHM_NAME_DETECTIONS);  // 正しく呼ばれる
    // ...
}
```

### 4. セマフォの型キャスト

**症状**: セマフォ操作が不安定、時々クラッシュ

**原因**: `sem_t` を `uint8_t` 配列でエミュレート

```c
// ❌ 間違い：バイト配列でエミュレート
typedef struct {
    // ...
    uint8_t detection_update_sem[32];  // sem_tのサイズを推測
} LatestDetectionResult;

// キャストして使用
sem_wait((sem_t*)&shm->detection_update_sem);  // 危険！
```

**問題点**:
- `sem_t` のサイズはプラットフォーム依存（32バイトとは限らない）
- 内部構造が壊れる可能性
- アライメント要求を満たさない可能性

**対策**:
```c
// ✅ 正解：sem_t型を直接使用
typedef struct {
    // ...
    sem_t detection_update_sem;  // 正しい型
} LatestDetectionResult;

// 型キャスト不要
sem_wait(&shm->detection_update_sem);
```

**C/Go/Python間の共有**:

Go (cgo):
```go
/*
#include <semaphore.h>

typedef struct {
    // ...
    sem_t detection_update_sem;  // C側と完全に一致
} LatestDetectionResult;
*/
import "C"
```

Python (ctypes):
```python
from ctypes import c_uint8

class CLatestDetectionResult(Structure):
    _fields_ = [
        # ...
        ("detection_update_sem", c_uint8 * 32),  # sem_tのバイナリ表現
    ]

# アドレスを取得してlibrt.sem_post()に渡す
sem_addr = addressof(shm_struct.detection_update_sem)
librt.sem_post(c_void_p(sem_addr))
```

### 5. バージョン管理の欠如

**症状**: セマフォがポストされても古いデータを処理してしまう

**原因**: スプリアスウェイクアップ（セマフォが複数回ポストされた場合など）への対策不足

```c
// ❌ 間違い：バージョンチェックなし
while (1) {
    sem_wait(&shm->update_sem);
    process_data(shm);  // 同じデータを2回処理する可能性
}
```

**対策**:
```c
// ✅ 正解：バージョンで重複検出
uint32_t last_version = 0;

while (1) {
    sem_wait(&shm->update_sem);

    uint32_t current_version = __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
    if (current_version != last_version) {
        process_data(shm);
        last_version = current_version;
    }
    // else: スプリアスウェイクアップ、スキップ
}
```

### 6. エラーハンドリングの不足

**症状**: `sem_wait()` がタイムアウトやシグナル割り込みで失敗するとプログラムが停止

**原因**: `ETIMEDOUT` と `EINTR` を正常ケースとして扱っていない

```c
// ❌ 間違い：すべてのエラーを同じように扱う
if (sem_timedwait(&sem, &ts) == -1) {
    fprintf(stderr, "Error!\n");
    return -1;  // タイムアウトも異常終了
}
```

**対策**:
```c
// ✅ 正解：エラーの種類で分岐
int ret = sem_timedwait(&sem, &ts);
if (ret == -1) {
    if (errno == ETIMEDOUT) {
        // タイムアウト：正常、新しいデータがなかっただけ
        return -2;
    } else if (errno == EINTR) {
        // シグナル割り込み：正常、リトライすれば良い
        return -3;
    } else {
        // 実際のエラー
        fprintf(stderr, "sem_timedwait error: %s\n", strerror(errno));
        return -1;
    }
}
return 0;  // 成功
```

---

## デバッグ手法

### 1. 共有メモリの状態確認

```bash
# 共有メモリファイルの存在確認
ls -la /dev/shm/pet_camera_*

# サイズ確認（構造体サイズと一致するか）
ls -la /dev/shm/pet_camera_detections
# -rw-rw-r-- 1 sunrise sunrise 584 ... /dev/shm/pet_camera_detections
#                              ↑ 期待値: sizeof(LatestDetectionResult)

# 権限確認（rw- rw- r--）
# 読み書き可能であることを確認
```

### 2. セマフォの状態確認

```bash
# セマフォの値を確認（ipcs コマンド）
ipcs -s

# プロセスが使用中のセマフォ一覧
lsof /dev/shm/pet_camera_detections
```

### 3. C側のデバッグログ

```c
// セマフォ操作時にログ出力
int ret = sem_timedwait(&shm->detection_update_sem, &ts);
if (ret == -1) {
    fprintf(stderr, "[DEBUG] sem_timedwait failed: errno=%d (%s)\n",
            errno, strerror(errno));
}
```

**主要なerrno値**:
- `ETIMEDOUT` (110): タイムアウト
- `EINTR` (4): シグナル割り込み
- `EINVAL` (22): 無効な引数（セマフォが初期化されていない）
- `EAGAIN` (11): リソース一時的に利用不可

### 4. Go側のデバッグ

```go
func (r *shmReader) WaitNewDetection() error {
    ret := C.wait_new_detection(r.detectionShm)

    // デバッグログ
    if ret != 0 && ret != -2 && ret != -3 {
        fmt.Printf("[DEBUG] wait_new_detection returned: %d\n", ret)
    }

    // ...
}
```

### 5. strace でシステムコール追跡

```bash
# プロセスのシステムコール追跡
strace -p <PID> -e trace=futex,mmap,shm_open

# セマフォ操作のログ
# futex(0xffffb1c11228, FUTEX_WAIT_PRIVATE, 0, ...) = -1 ETIMEDOUT
#       ↑ セマフォのアドレス
```

### 6. gdb でクラッシュ解析

```bash
# コアダンプを有効化
ulimit -c unlimited

# クラッシュ時にコアダンプ生成
# → core.xxxxx ファイル

# gdb でバックトレース確認
gdb /path/to/binary core.xxxxx
(gdb) bt
(gdb) print shm
(gdb) print &shm->detection_update_sem
```

---

## ベストプラクティス

### 1. 起動時のクリーンアップ

```c
// main() の最初で古い共有メモリを削除
int main(void) {
    // 古い共有メモリを確実に削除
    shm_unlink(SHM_NAME_DETECTIONS);

    // 新規作成
    LatestDetectionResult* shm = shm_detection_create();
    if (!shm) {
        fprintf(stderr, "Failed to create shared memory\n");
        return 1;
    }

    // ...
}
```

### 2. タイムアウトの設定

```c
// 無限待機を避ける（デッドロック防止）
struct timespec ts;
clock_gettime(CLOCK_REALTIME, &ts);
ts.tv_sec += 1;  // 1秒タイムアウト

int ret = sem_timedwait(&sem, &ts);
// タイムアウトで定期的にチェック可能
// - シャットダウンシグナル
// - 共有メモリの状態
```

### 3. アトミック操作の使用

```c
// バージョン更新はアトミックに
__atomic_fetch_add(&shm->version, 1, __ATOMIC_SEQ_CST);

// 読み取りもアトミックに
uint32_t version = __atomic_load_n(&shm->version, __ATOMIC_ACQUIRE);
```

### 4. セマフォの初期化確認

```c
// セマフォ初期化後にバージョン0にリセット
int ret = sem_init(&shm->detection_update_sem, 1, 0);
if (ret != 0) {
    fprintf(stderr, "sem_init failed: %s\n", strerror(errno));
    return NULL;
}

// 初期バージョン設定
shm->version = 0;
```

### 5. クリーンアップの確実性

```c
// シグナルハンドラでクリーンアップ
void cleanup_handler(int sig) {
    if (detection_shm) {
        sem_destroy(&detection_shm->detection_update_sem);
        shm_detection_destroy(detection_shm);
    }
    shm_unlink(SHM_NAME_DETECTIONS);
    exit(0);
}

int main(void) {
    signal(SIGINT, cleanup_handler);
    signal(SIGTERM, cleanup_handler);

    // ...
}
```

### 6. フォールバック機能の実装

```go
// セマフォが使えない場合はポーリングにフォールバック
errorCount := 0
const maxErrors = 10

for {
    err := WaitNewDetection()
    if err != nil {
        errorCount++

        if errorCount >= maxErrors {
            // ポーリングモードに切り替え
            fmt.Println("Falling back to polling mode")
            ticker := time.NewTicker(100 * time.Millisecond)

            for range ticker.C {
                // バージョンチェックのみ
                if checkNewVersion() {
                    processData()
                }
            }
        }
    } else {
        errorCount = 0  // リセット
    }
}
```

---

## パフォーマンス比較

### ポーリング方式（Before）

```c
// 30fps でポーリング
while (1) {
    read_shared_memory(&data);
    if (data.version != last_version) {
        process_data(&data);
    }
    usleep(33333);  // 33ms (30fps)
}
```

**特性**:
- CPU使用率: 常時5-10%
- レイテンシ: 平均16.5ms（最悪33ms）
- 電力効率: 悪い（常にCPU稼働）
- イベント送信回数: 30回/秒（固定）

### イベント駆動方式（After）

```c
// セマフォで待機
while (1) {
    sem_wait(&shm->update_sem);  // ブロック
    read_shared_memory(&data);
    process_data(&data);
}
```

**特性**:
- CPU使用率: 0-2%（待機中はほぼ0%）
- レイテンシ: 1ms未満
- 電力効率: 非常に良い（CPUスリープ可能）
- イベント送信回数: 0-30回/秒（データ変化時のみ）

### 実測値（本プロジェクト）

| 項目 | ポーリング | イベント駆動 | 改善率 |
|------|-----------|--------------|--------|
| CPU使用率 | 8.2% | 1.1% | **86%減** |
| 平均レイテンシ | 16ms | 0.8ms | **95%改善** |
| 帯域幅（SSE） | 30 KB/s | 2.5 KB/s | **92%減** |
| イベント送信回数 | 30/s | 2.3/s | **92%減** |

---

## 言語別実装の注意点

### C言語

```c
// セマフォ初期化
sem_init(&shm->sem, 1, 0);
//                  ↑ pshared=1 必須（プロセス間共有）

// アトミック操作
__atomic_fetch_add(&shm->version, 1, __ATOMIC_SEQ_CST);

// クリーンアップ
sem_destroy(&shm->sem);
```

### Go言語（cgo）

```go
/*
#include <semaphore.h>

typedef struct {
    sem_t detection_update_sem;  // C側と型を完全一致
} LatestDetectionResult;
*/
import "C"

// セマフォ操作はC関数経由
ret := C.sem_timedwait(&shm.detection_update_sem, &ts)

// 注意: Goのgoroutineスケジューラとの相性
// - sem_wait()はブロッキング → goroutineを専有
// - 大量のgoroutineで呼ぶと非効率
```

### Python（ctypes）

```python
from ctypes import CDLL, c_void_p, c_uint8, addressof

# librt読み込み
librt = CDLL("librt.so.1")
librt.sem_post.argtypes = [c_void_p]

class CLatestDetectionResult(Structure):
    _fields_ = [
        # ...
        ("detection_update_sem", c_uint8 * 32),  # sem_tのバイナリ
    ]

# セマフォポスト
sem_addr = addressof(shm_struct.detection_update_sem)
librt.sem_post(c_void_p(sem_addr))

# 注意: sem_wait()はブロッキング → GILを保持
# - マルチスレッド時は注意が必要
```

---

## トラブルシューティングチェックリスト

起動時に SIGSEGV が発生する場合：

- [ ] `#include <sys/mman.h>` を追加したか？
- [ ] `shm_unlink()` を main() の最初で呼んでいるか？
- [ ] 共有メモリを `O_RDWR` と `PROT_READ | PROT_WRITE` で開いているか？
- [ ] C/Go/Python の構造体定義が一致しているか？
- [ ] `sem_t` 型を直接使用しているか（`uint8_t` 配列ではない）？
- [ ] セマフォを `sem_init()` で初期化したか？

`sem_wait()` がタイムアウトし続ける場合：

- [ ] 書き込み側が `sem_post()` を呼んでいるか？
- [ ] バージョン更新と `sem_post()` の順序は正しいか？
- [ ] 共有メモリファイルのサイズは正しいか（`ls -la /dev/shm/`）？
- [ ] 複数のプロセスが同じ共有メモリを開いているか？

---

## まとめ

セマフォを使ったイベント駆動IPCは、ポーリング方式と比べて：

**利点**:
- CPU使用率が劇的に削減（80-90%減）
- レイテンシが低い（1ms未満）
- 電力効率が良い
- スケーラビリティが高い（多数のプロセス間通信でも効率的）

**欠点**:
- 実装が複雑（デバッグが難しい）
- プラットフォーム依存性がある
- エラーハンドリングが重要

**適用場面**:
- リアルタイム性が求められるシステム
- 多数のプロセス間で効率的に通信したい場合
- 電力効率が重要な組み込みシステム

本ガイドで紹介した落とし穴を避けることで、安定したイベント駆動IPCシステムを構築できます。
