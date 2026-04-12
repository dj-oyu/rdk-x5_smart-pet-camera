#!/usr/bin/env python3
"""
ROI差分モニター

- カメラ映像上で4点クリックしてポリゴンROIを定義
- 各ROI内のフレーム差分をリアルタイム計測・表示
- 差分履歴をCSVに記録（後段の行動検知分析用）

Usage:
    sudo uv run scripts/test_roi_monitor.py [--port 8083]
"""

import argparse
import json
import sqlite3
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

import cv2
import numpy as np

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "src" / "capture"))
sys.path.insert(0, str(REPO_ROOT / "src" / "common" / "src"))

try:
    from hb_mem_bindings import import_nv12_graph_buf, init_module as hb_mem_init
    from real_shared_memory import SHM_NAME_YOLO_ZC, ZeroCopySharedMemory
    HB_MEM_AVAILABLE = hb_mem_init()
except ImportError as e:
    print(f"[WARN] {e}", file=sys.stderr)
    HB_MEM_AVAILABLE = False

DB_PATH          = REPO_ROOT / "scripts" / "roi_monitor.db"
CAPTURES_DIR     = REPO_ROOT / "scripts" / "captures"
HISTORY_LEN      = 120
CAPTURE_THRESH   = 5.0   # net値がこれを超えたらキャプチャ保存
CAPTURE_COOLDOWN = 30.0  # ROIごとの保存間隔(秒)


# ============================================================
# フレーム取得
# ============================================================

def grab_bgr() -> tuple[np.ndarray | None, str]:
    shm = ZeroCopySharedMemory(SHM_NAME_YOLO_ZC)
    if not shm.open():
        return None, "SHM open failed"
    hb_buf = None
    try:
        zc = shm.get_frame()
        if zc is None or zc.version == 0:
            return None, "フレーム未受信"
        y, uv, hb_buf = import_nv12_graph_buf(
            raw_buf_data=zc.hb_mem_buf_data,
            expected_plane_sizes=zc.plane_size,
        )
        nv12 = y if y.size == zc.width * zc.height + uv.size else np.concatenate([y, uv])
        yuv  = nv12.reshape(zc.height * 3 // 2, zc.width)
        return cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12), \
               f"{zc.width}x{zc.height} cam={zc.camera_id}"
    except Exception as e:
        return None, str(e)
    finally:
        if hb_buf:
            try: hb_buf.release()
            except: pass
        shm.close()


def to_jpeg(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return bytes(buf) if ok else b""


# ============================================================
# 状態 (ROI / 差分 / 録画)
# ============================================================

_lock      = threading.Lock()
_rois:     list[dict]           = []   # {id, label, points:[[x,y]×4]}
_prev_gray: np.ndarray | None  = None
_history:  dict[int, deque]    = {}   # roi_id -> deque[(ts, score)]
_baseline: dict[int, float]    = {}   # roi_id -> ノイズフロア
_recording   = False
_db_conn:    sqlite3.Connection | None = None  # 起動時に open、プロセス終了まで保持
_session_id: int | None         = None  # 現在の録画セッションID
_stop_at:    float | None       = None  # 録画終了予約 (unix timestamp)
_commit_interval = 30.0                 # 秒: この間隔でまとめてcommit
_last_commit: float = 0.0
_last_capture: dict[int, float] = {}   # roi_id -> 最終キャプチャ時刻

# 照明変化検知パラメータ
LIGHTING_STD_THRESH = 1.5   # net値の全ROI標準偏差がこれ以下なら共通モード変化
BASELINE_EMA_ALPHA  = 0.05  # ベースライン追従の速さ (小さいほど遅い)


def _stop_recording():
    """録画を停止する。DBは開いたまま。"""
    global _recording, _session_id, _stop_at
    with _lock:
        if not _recording:
            return
        _recording = False
        sid        = _session_id
        _session_id = None
        _stop_at   = None
        if _db_conn and sid is not None:
            try:
                _db_conn.execute(
                    "UPDATE sessions SET stop_ts=? WHERE id=?",
                    (time.time(), sid),
                )
                _db_conn.commit()
            except Exception as e:
                print(f"[rec] stop_ts 更新失敗: {e}")
    print(f"[rec] 停止 session_id={sid}")


def _schedule_watcher():
    """終了予約を監視するバックグラウンドスレッド。"""
    while True:
        time.sleep(30)
        with _lock:
            if _recording and _stop_at and time.time() >= _stop_at:
                stop = True
            else:
                stop = False
        if stop:
            _stop_recording()
            print("[rec] 予約終了")


def open_db():
    """DB を開き、テーブルを作成する。起動時に1回だけ呼ぶ。"""
    global _db_conn
    _db_conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    _db_conn.execute("PRAGMA journal_mode=WAL")
    _db_conn.execute("PRAGMA synchronous=NORMAL")
    _db_conn.executescript("""
        CREATE TABLE IF NOT EXISTS rois (
            id     INTEGER PRIMARY KEY,
            label  TEXT NOT NULL,
            points TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS baseline (
            roi_id INTEGER PRIMARY KEY REFERENCES rois(id),
            base   REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            start_ts REAL NOT NULL,
            stop_ts  REAL,
            stop_at  REAL
        );
        CREATE TABLE IF NOT EXISTS diff_log (
            ts         REAL    NOT NULL,
            session_id INTEGER NOT NULL,
            label      TEXT    NOT NULL,
            raw        REAL    NOT NULL,
            lighting   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (ts, label)
        );
        CREATE INDEX IF NOT EXISTS idx_diff_label   ON diff_log(label);
        CREATE INDEX IF NOT EXISTS idx_diff_session ON diff_log(session_id);
        CREATE TABLE IF NOT EXISTS baseline_log (
            ts         REAL    NOT NULL,
            session_id INTEGER NOT NULL,
            label      TEXT    NOT NULL,
            base       REAL    NOT NULL,
            PRIMARY KEY (ts, label)
        );
        CREATE INDEX IF NOT EXISTS idx_base_label   ON baseline_log(label);
        CREATE INDEX IF NOT EXISTS idx_base_session ON baseline_log(session_id);
        CREATE TABLE IF NOT EXISTS captures (
            ts         REAL    NOT NULL,
            session_id INTEGER NOT NULL,
            label      TEXT    NOT NULL,
            net        REAL    NOT NULL,
            path       TEXT    NOT NULL,
            PRIMARY KEY (ts, label)
        );
        CREATE INDEX IF NOT EXISTS idx_cap_session ON captures(session_id);
    """)
    _db_conn.commit()
    CAPTURES_DIR.mkdir(exist_ok=True)
    print(f"[db] 開いた: {DB_PATH}")


def load_rois():
    """DB から ROI とベースラインを読み込む。
    rois テーブルが空で bowl_rois.json があれば一度だけ移行する。"""
    global _rois, _history, _baseline
    assert _db_conn is not None

    rows = _db_conn.execute("SELECT id, label, points FROM rois ORDER BY id").fetchall()

    # 移行: DB が空で旧 JSON が存在する場合
    json_path = REPO_ROOT / "scripts" / "bowl_rois.json"
    if not rows and json_path.exists():
        try:
            data = json.loads(json_path.read_text())
            old_rois = data.get("rois", [])
            _db_conn.executemany(
                "INSERT OR REPLACE INTO rois(id, label, points) VALUES (?,?,?)",
                [(r["id"], r["label"], json.dumps(r["points"])) for r in old_rois],
            )
            old_base = data.get("baseline", {})
            if old_base:
                _db_conn.executemany(
                    "INSERT OR REPLACE INTO baseline(roi_id, base) VALUES (?,?)",
                    [(int(k), v) for k, v in old_base.items()],
                )
            _db_conn.commit()
            rows = _db_conn.execute(
                "SELECT id, label, points FROM rois ORDER BY id"
            ).fetchall()
            print(f"[init] bowl_rois.json から {len(rows)} ROI を移行しました")
        except Exception as e:
            print(f"[init] JSON移行失敗: {e}")

    _rois    = [{"id": r[0], "label": r[1], "points": json.loads(r[2])} for r in rows]
    _history = {r["id"]: deque(maxlen=HISTORY_LEN) for r in _rois}

    base_rows = _db_conn.execute("SELECT roi_id, base FROM baseline").fetchall()
    _baseline = {r[0]: r[1] for r in base_rows}
    print(f"[init] {len(_rois)} ROI, baseline={_baseline}")


def save_baseline():
    """_baseline を DB の baseline テーブルに保存する。"""
    if _db_conn is None:
        return
    with _lock:
        rows = [(roi["id"], round(_baseline.get(roi["id"], 0.0), 3)) for roi in _rois]
    try:
        _db_conn.executemany(
            "INSERT OR REPLACE INTO baseline(roi_id, base) VALUES (?,?)", rows
        )
        _db_conn.commit()
        print(f"[baseline] DB保存: {dict(_baseline)}")
    except Exception as e:
        print(f"[baseline] DB保存失敗: {e}")


def _write_baseline_log():
    """現在のベースラインを baseline_log に追記する (セッション中のみ)。"""
    with _lock:
        if not _recording or _db_conn is None or _session_id is None:
            return
        ts  = time.time()
        sid = _session_id
        rows = [
            (ts, sid, roi["label"], round(_baseline.get(roi["id"], 0.0), 3))
            for roi in _rois
        ]
    try:
        _db_conn.executemany(
            "INSERT OR IGNORE INTO baseline_log(ts,session_id,label,base)"
            " VALUES (?,?,?,?)",
            rows,
        )
        _db_conn.commit()
    except Exception as e:
        print(f"[baseline_log] 書き込み失敗: {e}")


def _make_mask(roi: dict, h: int, w: int) -> np.ndarray:
    pts   = np.array(roi["points"], dtype=np.int32)
    mask  = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def compute_diff(gray: np.ndarray) -> dict[int, float]:
    global _prev_gray
    scores: dict[int, float] = {}
    with _lock:
        if _prev_gray is not None and _prev_gray.shape == gray.shape:
            diff = cv2.absdiff(gray, _prev_gray).astype(np.float32)
            h, w = gray.shape
            for roi in _rois:
                mask   = _make_mask(roi, h, w)
                pixels = diff[mask > 0]
                scores[roi["id"]] = float(pixels.mean()) if pixels.size > 0 else 0.0
        _prev_gray = gray.copy()
    return scores


def push_history(scores: dict[int, float], gray: np.ndarray) -> bool:
    """差分スコアを記録し、照明変化を検知したらベースラインを追従する。
    net > CAPTURE_THRESH かつクールダウン経過でグレースケールPNGを保存する。
    Returns: True if lighting change detected."""
    global _baseline, _last_capture
    ts = time.time()
    with _lock:
        # net 値を計算
        nets = {roi["id"]: max(0.0, scores.get(roi["id"], 0.0)
                               - _baseline.get(roi["id"], 0.0))
                for roi in _rois}

        # 全ROI net の標準偏差で照明変化を判定
        net_vals = list(nets.values())
        std = float(np.std(net_vals)) if len(net_vals) > 1 else 0.0
        lighting = (std < LIGHTING_STD_THRESH) and any(v > 0.5 for v in net_vals)

        if lighting:
            # 共通モード変化 → ベースラインをスローEMAで追従
            for roi in _rois:
                rid = roi["id"]
                raw = scores.get(rid, 0.0)
                old = _baseline.get(rid, raw)
                _baseline[rid] = round(old * (1 - BASELINE_EMA_ALPHA)
                                       + raw * BASELINE_EMA_ALPHA, 3)

        for roi_id, score in scores.items():
            if roi_id not in _history:
                _history[roi_id] = deque(maxlen=HISTORY_LEN)
            _history[roi_id].append((ts, round(score, 3)))

        # キャプチャ対象を収集 (ロック内で判定、保存はロック外)
        to_capture = []
        if _recording and _db_conn and _session_id is not None:
            sid = _session_id
            for roi in _rois:
                rid = roi["id"]
                net = nets.get(rid, 0.0)
                if net >= CAPTURE_THRESH:
                    last = _last_capture.get(rid, 0.0)
                    if ts - last >= CAPTURE_COOLDOWN:
                        _last_capture[rid] = ts
                        to_capture.append((roi, net))
        else:
            sid = None

        if _recording and _db_conn and sid is not None:
            global _last_commit
            lit = 1 if lighting else 0
            try:
                _db_conn.executemany(
                    "INSERT OR IGNORE INTO diff_log(ts,session_id,label,raw,lighting)"
                    " VALUES (?,?,?,?,?)",
                    [
                        (ts, sid, roi["label"],
                         round(scores.get(roi["id"], 0.0), 3),
                         lit)
                        for roi in _rois
                    ],
                )
                # ベースライン変化時のみ baseline_log に記録
                if lighting:
                    _db_conn.executemany(
                        "INSERT OR IGNORE INTO baseline_log(ts,session_id,label,base)"
                        " VALUES (?,?,?,?)",
                        [
                            (ts, sid, roi["label"],
                             round(_baseline.get(roi["id"], 0.0), 3))
                            for roi in _rois
                        ],
                    )
                # 30秒ごとにまとめてcommit (WALバッファに溜めてI/O効率化)
                if ts - _last_commit >= _commit_interval:
                    _db_conn.commit()
                    _last_commit = ts
            except Exception as e:
                print(f"[db] write error: {e}")

    # キャプチャ保存 (ロック外: I/O + DB INSERT)
    for roi, net in to_capture:
        fname = f"{roi['label']}_{ts:.3f}.png"
        fpath = CAPTURES_DIR / fname
        try:
            cv2.imwrite(str(fpath), gray)
            _db_conn.execute(
                "INSERT OR IGNORE INTO captures(ts,session_id,label,net,path)"
                " VALUES (?,?,?,?,?)",
                (ts, sid, roi["label"], round(net, 3), str(fpath)),
            )
            _db_conn.commit()
            print(f"[capture] {roi['label']} net={net:.2f} -> {fname}")
        except Exception as e:
            print(f"[capture] 保存失敗 {roi['label']}: {e}")

    return lighting


# ============================================================
# HTML
# ============================================================

PAGE = r"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>ROI差分モニター</title>
<style>
* { box-sizing: border-box; }
body { font-family: monospace; background: #111; color: #eee; margin: 0; padding: 10px; }
h1 { font-size: 1rem; margin: 0 0 4px; }
.tip { color: #666; font-size: 0.72rem; margin-bottom: 6px; }
.toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
button { background: #2a2a2a; color: #eee; border: 1px solid #555; border-radius: 3px;
         padding: 4px 10px; cursor: pointer; font-size: 0.78rem; }
button.active { background: #145; border-color: #48f; }
button.danger { background: #422; border-color: #f44; }
button.rec    { border-color: #4a4; }
button.rec.on { background: #500; border-color: #f44; color: #faa; }
#status { color: #888; font-size: 0.72rem; }
.viewer { position: relative; display: inline-block; }
.viewer img    { display: block; image-rendering: pixelated; }
.viewer canvas { position: absolute; top: 0; left: 0; }
.cards { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.card { background: #181828; border: 1px solid #444; border-radius: 4px;
        padding: 6px 10px; min-width: 170px; cursor: pointer; }
.card.sel { border-color: #88f; }
.card-label { font-size: 0.78rem; font-weight: bold; margin-bottom: 2px; }
.card-score { font-size: 1.5rem; font-weight: bold; line-height: 1; }
.bar { height: 5px; background: #333; border-radius: 3px; margin: 4px 0; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 0.25s; }
</style>
</head>
<body>
<h1>ROI差分モニター</h1>
<p class="tip">4点クリックでROI確定。選択モード: クリック選択 → Deleteで削除。ダブルクリックでラベル編集。</p>
<div class="toolbar">
  <button id="btn_draw"   class="active" onclick="setMode('draw')">描画 (4点)</button>
  <button id="btn_select" onclick="setMode('select')">選択/削除</button>
  <button class="danger"  onclick="clearSelected()">選択削除</button>
  <button class="danger"  onclick="clearAll()">全削除</button>
  <button onclick="saveRois()">ROI保存</button>
  <button onclick="captureBaseline()">ベースライン取得</button>
  <button onclick="refreshImg()">画像更新</button>
  <button id="btn_rec" class="rec" onclick="toggleRec()">● 録画開始</button>
  <label style="font-size:0.78rem;">終了予約:
    <input type="number" id="stop_hours" value="8" min="0.5" max="24" step="0.5" style="width:52px"> 時間後
  </label>
  <label style="font-size:0.78rem;"><input type="checkbox" id="auto" onchange="toggleAuto()"> 2秒自動</label>
  <span id="status"></span>
</div>

<div class="viewer">
  <img id="live" src="/img/live" onload="syncCanvas()" alt="live">
  <canvas id="cv"></canvas>
</div>
<div class="cards" id="cards"></div>

<script>
var mode = 'draw';
var rois = [];
var nextId = 0;
var selected = -1;
var pending = [];      // 描画中の点列
var autoTimer = null;
var diffHist  = {};    // id -> [score, ...]
var COLORS = ['#0f0','#0af','#fa0','#f5a','#af0','#a0f','#ff0','#0fa'];

function roiColor(i) { return COLORS[i % COLORS.length]; }
function roiIdx(id) { return rois.findIndex(function(r){ return r.id===id; }); }

function setMode(m) {
  mode = m; pending = [];
  document.getElementById('btn_draw').classList.toggle('active', m==='draw');
  document.getElementById('btn_select').classList.toggle('active', m==='select');
  document.getElementById('cv').style.cursor = m==='draw' ? 'crosshair' : 'pointer';
  redraw();
}

function syncCanvas() {
  var img = document.getElementById('live');
  var cv  = document.getElementById('cv');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.style.width  = img.clientWidth  + 'px';
  cv.style.height = img.clientHeight + 'px';
  redraw();
}

function refreshImg() {
  document.getElementById('live').src = '/img/live?t=' + Date.now();
}

function toggleAuto() {
  if (document.getElementById('auto').checked) {
    autoTimer = setInterval(function(){ fetchDiff(); }, 2000);
    setInterval(refreshImg, 10000);  // 画像は10秒ごと
  } else { clearInterval(autoTimer); autoTimer = null; }
}

function imgCoord(e) {
  var cv   = document.getElementById('cv');
  var rect = cv.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) * cv.width  / rect.width),
    y: Math.round((e.clientY - rect.top)  * cv.height / rect.height),
  };
}

document.getElementById('cv').addEventListener('click', function(e) {
  var p = imgCoord(e);
  if (mode === 'draw') {
    pending.push([p.x, p.y]);
    if (pending.length === 4) {
      var label = 'ROI' + (rois.length + 1);
      rois.push({ id: nextId++, label: label, points: pending.slice() });
      pending = [];
      uploadRois();
    }
    redraw();
  } else {
    var hit = hitTest(p.x, p.y);
    selected = (hit === selected) ? -1 : hit;
    redraw(); renderCards();
  }
});

document.getElementById('cv').addEventListener('dblclick', function(e) {
  if (mode !== 'select') return;
  var p   = imgCoord(e);
  var hit = hitTest(p.x, p.y);
  if (hit < 0) return;
  var idx = roiIdx(hit);
  var lbl = prompt('ラベル名', rois[idx].label);
  if (lbl !== null) { rois[idx].label = lbl; renderCards(); uploadRois(); }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Delete') clearSelected();
  if (e.key === 'Escape') { pending = []; redraw(); }
});

function hitTest(x, y) {
  for (var i = rois.length-1; i >= 0; i--) {
    var pts = rois[i].points;
    if (pointInPoly(x, y, pts)) return rois[i].id;
  }
  return -1;
}

function pointInPoly(x, y, pts) {
  var inside = false;
  for (var i = 0, j = pts.length-1; i < pts.length; j = i++) {
    var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi))
      inside = !inside;
  }
  return inside;
}

function redraw() {
  var cv  = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);

  // 確定済みROI
  rois.forEach(function(roi, i) {
    var col  = roiColor(i);
    var isSel = roi.id === selected;
    var pts  = roi.points;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
    ctx.closePath();
    ctx.strokeStyle = isSel ? '#fff' : col;
    ctx.lineWidth   = isSel ? 2.5 : 1.5;
    ctx.stroke();
    if (isSel) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
    }
    // 頂点
    pts.forEach(function(pt) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(pt[0], pt[1], 3, 0, Math.PI*2); ctx.fill();
    });
    // ラベル
    ctx.fillStyle = isSel ? '#fff' : col;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(roi.label, pts[0][0]+4, pts[0][1]-4);
  });

  // 描画中の点列
  if (pending.length > 0) {
    ctx.fillStyle = '#0f0';
    pending.forEach(function(pt, i) {
      ctx.beginPath(); ctx.arc(pt[0], pt[1], 4, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#aaa'; ctx.font = '11px monospace';
      ctx.fillText(i+1, pt[0]+6, pt[1]-4);
      ctx.fillStyle = '#0f0';
    });
    ctx.strokeStyle = '#0f04'; ctx.lineWidth = 1;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(pending[0][0], pending[0][1]);
    for (var k=1; k<pending.length; k++) ctx.lineTo(pending[k][0], pending[k][1]);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#0f0'; ctx.font = '11px monospace';
    ctx.fillText((4-pending.length) + '点残り', pending[0][0], pending[0][1]-16);
  }
}

function renderCards() {
  var el = document.getElementById('cards');
  el.innerHTML = '';
  rois.forEach(function(roi, i) {
    var col  = roiColor(i);
    var hist = diffHist[roi.id] || [];
    var last = hist.length ? hist[hist.length-1] : {raw:0, net:0, base:0};
    var net  = last.net !== undefined ? last.net : last;
    var raw  = last.raw !== undefined ? last.raw : last;
    var base = last.base || 0;
    var pct  = Math.min(net / 15 * 100, 100).toFixed(1);

    var card = document.createElement('div');
    card.className = 'card' + (roi.id === selected ? ' sel' : '');
    card.innerHTML =
      '<div class="card-label" style="color:' + col + '">' + roi.label + '</div>' +
      '<div class="card-score">' + net.toFixed(2) +
        '<span style="font-size:0.7rem;color:#666"> (生:' + raw.toFixed(1) + ' base:' + base.toFixed(1) + ')</span></div>' +
      '<div class="bar"><div class="bar-fill" style="width:'+pct+'%;background:'+col+'"></div></div>' +
      '<canvas id="sp_'+roi.id+'" width="160" height="28"></canvas>';
    card.onclick = function() {
      selected = (selected === roi.id) ? -1 : roi.id;
      redraw(); renderCards();
    };
    el.appendChild(card);

    // スパークライン
    (function(id, h, c) {
      setTimeout(function() {
        var sc = document.getElementById('sp_' + id);
        if (!sc || h.length < 2) return;
        var ctx = sc.getContext('2d');
        ctx.clearRect(0,0,160,28);
        var vals = h.map(function(v){ return v.net !== undefined ? v.net : v; });
        var mx = Math.max.apply(null, vals) || 1;
        ctx.strokeStyle = c; ctx.lineWidth = 1;
        ctx.beginPath();
        vals.forEach(function(v, j) {
          var x = j/(vals.length-1)*158+1;
          var y = 28 - (v/mx*24+2);
          j===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
        });
        ctx.stroke();
      }, 0);
    })(roi.id, hist, col);
  });
}

function clearSelected() {
  if (selected < 0) return;
  rois = rois.filter(function(r){ return r.id !== selected; });
  selected = -1;
  redraw(); renderCards(); uploadRois();
}

function clearAll() {
  if (!confirm('全ROIを削除しますか？')) return;
  rois = []; selected = -1; diffHist = {};
  redraw(); renderCards(); uploadRois();
}

function uploadRois() {
  fetch('/api/rois', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({rois: rois}),
  });
}

function saveRois() {
  fetch('/api/rois/save', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      document.getElementById('status').textContent = d.error
        ? '保存失敗: ' + d.error
        : 'ROI保存完了 (' + d.count + '件)';
    });
}

function fetchDiff() {
  fetch('/api/diff')
    .then(function(r){ return r.json(); })
    .then(function(d) {
      var lighting = d.lighting ? ' ⚠ 照明変化(base更新中)' : '';
      document.getElementById('status').textContent =
        new Date().toLocaleTimeString() + ' std=' + (d.std||0).toFixed(2) + lighting;
      (d.scores||[]).forEach(function(s) {
        if (!diffHist[s.id]) diffHist[s.id] = [];
        diffHist[s.id].push({raw: s.score, net: s.net, base: s.base});
        if (diffHist[s.id].length > HISTORY_LEN) diffHist[s.id].shift();
      });
      renderCards();
    })
    .catch(function(e){ document.getElementById('status').textContent='ERR:'+e; });
}

var HISTORY_LEN = 120;

function captureBaseline() {
  document.getElementById('status').textContent = 'ベースライン取得中...';
  fetch('/api/baseline', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      var s = Object.entries(d.baseline||{}).map(function(e){ return e[0]+':'+e[1].toFixed(2); }).join(' ');
      document.getElementById('status').textContent = 'ベースライン: ' + s;
    });
}

function applyRecState(d) {
  var btn = document.getElementById('btn_rec');
  btn.classList.toggle('on', d.recording);
  if (d.recording) {
    var sid = d.session_id != null ? ' #' + d.session_id : '';
    var eta = d.stop_at
      ? ' 〜' + new Date(d.stop_at * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
      : '';
    btn.textContent = '■ 録画中' + sid + eta;
  } else {
    btn.textContent = '● 録画開始';
  }
}

function toggleRec() {
  var recording = document.getElementById('btn_rec').classList.contains('on');
  var body = recording ? {} : {duration_hours: +document.getElementById('stop_hours').value};
  fetch('/api/record', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })
    .then(function(r){ return r.json(); })
    .then(applyRecState);
}

// ページロード時にサーバー状態を同期
function syncStatus() {
  fetch('/api/status')
    .then(function(r){ return r.json(); })
    .then(function(d) {
      applyRecState(d);
      if (d.rois && d.rois.length && !rois.length) {
        rois   = d.rois;
        nextId = rois.reduce(function(m,r){ return Math.max(m,r.id+1); }, 0);
        redraw(); renderCards();
      }
    });
}

// 起動時: サーバー状態を同期してから差分取得
syncStatus();
fetchDiff();
</script>
</body>
</html>
"""


# ============================================================
# HTTPハンドラ
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def _send(self, body: bytes, ct: str, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n)

    def do_GET(self):
        path = urlparse(self.path).path
        if   path == "/":            self._send(PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/img/live":    self._serve_live()
        elif path == "/api/diff":    self._serve_diff()
        elif path == "/api/rois":    self._serve_get_rois()
        elif path == "/api/status":  self._serve_status()
        else: self.send_response(404); self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if   path == "/api/rois":       self._serve_post_rois()
        elif path == "/api/rois/save":  self._serve_save_rois()
        elif path == "/api/record":     self._serve_toggle_record()
        elif path == "/api/baseline":   self._serve_baseline()
        else: self.send_response(404); self.end_headers()

    def _serve_live(self):
        bgr, msg = grab_bgr()
        if bgr is None:
            img = np.zeros((360, 640, 3), dtype=np.uint8)
            cv2.putText(img, msg[:50], (8, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,200), 1)
            self._send(to_jpeg(img), "image/jpeg"); return
        self._send(to_jpeg(bgr), "image/jpeg")

    def _serve_diff(self):
        bgr, frame_msg = grab_bgr()
        if bgr is None:
            self._json({"error": frame_msg, "scores": []}); return
        gray   = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        scores  = compute_diff(gray)
        lighting = push_history(scores, gray)
        with _lock:
            result = [{"id":    roi["id"],
                       "label": roi["label"],
                       "score": scores.get(roi["id"], 0.0),
                       "net":   max(0.0, scores.get(roi["id"], 0.0)
                                    - _baseline.get(roi["id"], 0.0)),
                       "base":  _baseline.get(roi["id"], 0.0),
                       } for roi in _rois]
        net_vals = [s["net"] for s in result]
        std = float(np.std(net_vals)) if len(net_vals) > 1 else 0.0
        self._json({"frame": frame_msg, "scores": result,
                    "lighting": lighting, "std": round(std, 3)})

    def _serve_get_rois(self):
        with _lock:
            self._json({"rois": list(_rois)})

    def _serve_post_rois(self):
        global _rois, _history
        try:
            data = json.loads(self._read_body())
            new_rois = data.get("rois", [])
            with _lock:
                _rois = new_rois
                for r in _rois:
                    if r["id"] not in _history:
                        _history[r["id"]] = deque(maxlen=HISTORY_LEN)
            self._json({"ok": True, "count": len(_rois)})
        except Exception as e:
            self._json({"error": str(e)})

    def _serve_save_rois(self):
        with _lock:
            rows = [(r["id"], r["label"], json.dumps(r["points"])) for r in _rois]
        try:
            with _db_conn:  # トランザクション
                _db_conn.execute("DELETE FROM rois")
                _db_conn.executemany(
                    "INSERT INTO rois(id, label, points) VALUES (?,?,?)", rows
                )
            print(f"[save] {len(rows)} ROI → DB")
            self._json({"count": len(rows)})
        except Exception as e:
            self._json({"error": str(e)})

    def _serve_baseline(self):
        """直近N回の差分平均をベースラインとして保存する。"""
        global _baseline
        N = 8
        bgr_frames = []
        for _ in range(N + 1):
            bgr, _ = grab_bgr()
            if bgr is not None:
                bgr_frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
            time.sleep(0.15)
        if len(bgr_frames) < 2:
            self._json({"error": "フレーム取得失敗"}); return
        # 連続フレーム差分の平均を計算
        acc: dict[int, list[float]] = {}
        for i in range(1, len(bgr_frames)):
            diff = cv2.absdiff(bgr_frames[i], bgr_frames[i-1]).astype(np.float32)
            h, w = diff.shape
            with _lock:
                for roi in _rois:
                    mask   = _make_mask(roi, h, w)
                    pixels = diff[mask > 0]
                    score  = float(pixels.mean()) if pixels.size > 0 else 0.0
                    acc.setdefault(roi["id"], []).append(score)
        with _lock:
            for roi_id, vals in acc.items():
                _baseline[roi_id] = round(float(np.mean(vals)), 3)
            result = {roi["label"]: _baseline.get(roi["id"], 0.0) for roi in _rois}
        print(f"[baseline] {result}")
        save_baseline()
        _write_baseline_log()
        self._json({"baseline": result})

    def _serve_status(self):
        with _lock:
            self._json({
                "recording":  _recording,
                "session_id": _session_id,
                "stop_at":    _stop_at,
                "rois":       list(_rois),
                "baseline":   dict(_baseline),
            })

    def _serve_toggle_record(self):
        global _recording, _session_id, _stop_at
        body = json.loads(self._read_body() or b"{}")
        with _lock:
            if not _recording:
                # 終了予約: stop_at (unixtime) か duration_hours を受け付ける
                if "stop_at" in body:
                    _stop_at = float(body["stop_at"])
                elif "duration_hours" in body:
                    _stop_at = time.time() + float(body["duration_hours"]) * 3600
                else:
                    _stop_at = None

                start_ts = time.time()
                cur = _db_conn.execute(
                    "INSERT INTO sessions(start_ts, stop_at) VALUES (?,?)",
                    (start_ts, _stop_at),
                )
                _session_id = cur.lastrowid
                # セッション開始時のベースラインを baseline_log に記録
                if _baseline:
                    _db_conn.executemany(
                        "INSERT OR IGNORE INTO baseline_log(ts,session_id,label,base)"
                        " VALUES (?,?,?,?)",
                        [
                            (start_ts, _session_id, roi["label"],
                             round(_baseline.get(roi["id"], 0.0), 3))
                            for roi in _rois
                        ],
                    )
                _db_conn.commit()
                _recording = True
                print(f"[rec] 開始 session_id={_session_id}"
                      + (f" 終了予約: {time.strftime('%H:%M', time.localtime(_stop_at))}"
                         if _stop_at else ""))
            else:
                _stop_recording()
            rec = _recording
            sid = _session_id
            sat = _stop_at
        self._json({"recording": rec, "session_id": sid, "stop_at": sat})


# ============================================================
# main
# ============================================================

def main():
    open_db()
    load_rois()
    t = threading.Thread(target=_schedule_watcher, daemon=True)
    t.start()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8083)
    args = ap.parse_args()
    if not HB_MEM_AVAILABLE:
        print("[WARN] libhbmem 初期化失敗。実機で実行してください。", file=sys.stderr)
    print(f"http://0.0.0.0:{args.port}/", flush=True)
    HTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
