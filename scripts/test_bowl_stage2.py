#!/usr/bin/env python3
"""
Stage 2 検証: お皿らしいエッジからROI候補を自動判定

Stage 1 確定パラメータ固定:
  blur=5, ksize=3, CLAHE clip=4.0, boost=3.0, 左半分ROIのみ

構成:
  - /img/edge  : エッジ画像 (オーバーレイなし)
  - /api/detect: ROI候補JSON → ブラウザCanvasで描画 (BBoxOverlay方式)
  - パラメータ変更時は画像再取得不要、JSONだけ更新

Usage:
    sudo uv run scripts/test_bowl_stage2.py [--port 8083]
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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

# ============================================================
# Stage 1 確定パラメータ (固定)
# ============================================================
S1_BLUR       = 5
S1_KSIZE      = 3
S1_CLIP_LIMIT = 4.0
S1_BOOST      = 3.0

DEFAULT_HOUGH = {"min_r": 15, "max_r": 80, "dp": 12, "p1": 80, "p2": 84}
DEFAULT_CONT  = {"min_area": 300, "max_area": 5000, "ellipse_ratio": 20, "close_k": 7,
                 "canny_lo": 30, "canny_hi": 80}

# ============================================================
# Sobel 強度の時間軸 SNR マップ
# 平均が高く分散が低いピクセル = 安定した強いエッジ
# ============================================================
import threading
from collections import deque

_edge_lock  = threading.Lock()
_edge_ring  : deque = deque()   # float32 Sobel magnitude フレーム列
_edge_n     = 8

def _sobel_mag(gray: np.ndarray) -> np.ndarray:
    """CLAHE + Sobel magnitude (float32)"""
    eq  = cv2.createCLAHE(clipLimit=S1_CLIP_LIMIT, tileGridSize=(8, 8))
    src = eq.apply(gray)
    blr = cv2.GaussianBlur(src, (S1_BLUR, S1_BLUR), 0)
    sx  = cv2.Sobel(blr, cv2.CV_32F, 1, 0, ksize=S1_KSIZE)
    sy  = cv2.Sobel(blr, cv2.CV_32F, 0, 1, ksize=S1_KSIZE)
    return cv2.magnitude(sx, sy)

def push_edge(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Sobel 強度をリングバッファに積み、(mean, snr) を返す。
    snr = mean / (std + 1) : 安定した強いエッジほど高い値。
    """
    global _edge_ring
    mag = _sobel_mag(gray)
    with _edge_lock:
        _edge_ring.append(mag)
        if len(_edge_ring) > _edge_n:
            _edge_ring.popleft()
        stack = np.stack(list(_edge_ring), axis=0)   # (N, H, W)
        mean  = stack.mean(axis=0)
        std   = stack.std(axis=0)
        snr   = mean / (std + 1.0)
        return mean, snr

def set_edge_n(n: int):
    global _edge_n
    with _edge_lock:
        _edge_n = max(1, n)
        _edge_ring.clear()

CANDIDATES_PATH = REPO_ROOT / "scripts" / "bowl_roi_candidates.json"

def load_saved_defaults() -> tuple[dict, dict]:
    """bowl_roi_candidates.json が存在すれば前回確定パラメータを返す。"""
    if not CANDIDATES_PATH.exists():
        return DEFAULT_HOUGH.copy(), DEFAULT_CONT.copy()
    try:
        with open(CANDIDATES_PATH) as f:
            data = json.load(f)
        p = data.get("params", {})
        hp = {**DEFAULT_HOUGH, **{k: int(v * 10) if k == "dp" else v
                                   for k, v in p.get("hough", {}).items()}}
        # ellipse_ratio は ×10 で整数、close_k はそのまま
        cp = {**DEFAULT_CONT}
        for k, v in p.get("contour", {}).items():
            if k == "ellipse_ratio":
                cp[k] = int(v * 10)
            else:
                cp[k] = v
        print(f"[init] 前回パラメータを読み込み: hough={hp} contour={cp}", flush=True)
        return hp, cp
    except Exception as e:
        print(f"[init] bowl_roi_candidates.json 読み込み失敗: {e}", flush=True)
        return DEFAULT_HOUGH.copy(), DEFAULT_CONT.copy()

INIT_HOUGH, INIT_CONT = load_saved_defaults()


# ============================================================
# フレーム取得
# ============================================================

def grab_bgr() -> tuple[np.ndarray | None, str]:
    shm = ZeroCopySharedMemory(SHM_NAME_YOLO_ZC)
    if not shm.open():
        return None, "SHM open 失敗"
    hb_buf = None
    try:
        zc = shm.get_frame()
        if zc is None or zc.version == 0:
            return None, "フレーム未受信"
        if zc.plane_cnt != 2:
            return None, f"plane_cnt={zc.plane_cnt}"
        y_arr, uv_arr, hb_buf = import_nv12_graph_buf(
            raw_buf_data=zc.hb_mem_buf_data,
            expected_plane_sizes=zc.plane_size,
        )
        nv12 = y_arr if len(y_arr) == zc.width * zc.height + len(uv_arr) \
               else np.concatenate([y_arr, uv_arr])
        yuv = nv12.reshape((zc.height * 3 // 2, zc.width))
        return cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12), \
               f"camera_id={zc.camera_id} {zc.width}x{zc.height}"
    except Exception as e:
        return None, str(e)
    finally:
        if hb_buf:
            hb_buf.release()
        shm.close()


def grab_gray_left() -> tuple[np.ndarray | None, str]:
    """フレーム取得→左半分グレースケールを返す（生フレーム）。"""
    bgr, msg = grab_bgr()
    if bgr is None:
        return None, msg
    h, w = bgr.shape[:2]
    return cv2.cvtColor(bgr[:, :w//2], cv2.COLOR_BGR2GRAY), msg


# ============================================================
# エッジ処理 (Stage 1固定)
# ============================================================

def build_edge(gray: np.ndarray) -> np.ndarray:
    eq = cv2.createCLAHE(clipLimit=S1_CLIP_LIMIT, tileGridSize=(8, 8))
    src = eq.apply(gray)
    blurred = cv2.GaussianBlur(src, (S1_BLUR, S1_BLUR), 0)
    sx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=S1_KSIZE)
    sy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=S1_KSIZE)
    mag = cv2.magnitude(sx, sy)
    return cv2.convertScaleAbs(mag, alpha=S1_BOOST * 255.0 / (mag.max() + 1e-6))


# ============================================================
# 検出 (JSON返却のみ、描画はブラウザCanvas)
# ============================================================

def detect_hough(edge: np.ndarray, min_r, max_r, dp, p1, p2) -> list[dict]:
    circles = cv2.HoughCircles(
        edge, cv2.HOUGH_GRADIENT,
        dp=dp, minDist=min_r * 2,
        param1=p1, param2=p2,
        minRadius=min_r, maxRadius=max_r,
    )
    if circles is None:
        return []
    return [{"cx": int(cx), "cy": int(cy), "r": int(r), "method": "hough"}
            for cx, cy, r in np.round(circles[0]).astype(int)]


def detect_contour(gray_left: np.ndarray, min_area, max_area, ellipse_ratio,
                   close_k=7, canny_lo=30, canny_hi=80,
                   edge_thresh=3.0) -> tuple[list[dict], dict]:
    """
    Sobel SNR マップ → 閾値 → Closing → 輪郭抽出 → 楕円フィット。
    edge_thresh: SNR 閾値 (mean/std)。高いほど安定した強いエッジのみ残る。
    canny_lo/canny_hi は現在未使用 (後方互換のため残す)。
    Returns (candidates, debug_stats).
    """
    mean_map, snr_map = push_edge(gray_left)
    # SNR 閾値: 安定した強いエッジのみ残す
    binary = (snr_map >= edge_thresh).astype(np.uint8) * 255
    ksz = max(2, close_k)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    stats = {"total_cnts": len(contours), "rejected_area": 0,
             "rejected_points": 0, "rejected_ratio": 0, "rejected_solidity": 0}
    candidates = []
    areas_seen = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        areas_seen.append(int(area))
        if area < min_area or area > max_area:
            stats["rejected_area"] += 1
            continue
        if len(cnt) < 5:
            stats["rejected_points"] += 1
            continue
        (cx, cy), (minor, major), angle = cv2.fitEllipse(cnt)
        if major < 1e-3:
            continue
        ratio = major / minor
        if ratio > ellipse_ratio:
            stats["rejected_ratio"] += 1
            continue
        hull_area = cv2.contourArea(cv2.convexHull(cnt))
        solidity = area / hull_area if hull_area > 0 else 0
        if solidity < 0.4:
            stats["rejected_solidity"] += 1
            continue
        candidates.append({
            "cx": int(cx), "cy": int(cy),
            "major": round(float(major), 1),
            "minor": round(float(minor), 1),
            "angle": round(float(angle), 1),
            "ratio": round(float(ratio), 2),
            "solidity": round(float(solidity), 2),
            "area": int(area),
            "method": "contour",
        })
    candidates.sort(key=lambda c: c["major"] * c["minor"], reverse=True)
    # debug: top-10 areas sorted desc (helps tune min/max_area)
    areas_seen.sort(reverse=True)
    stats["top_areas"] = areas_seen[:10]
    return candidates[:8], stats


def to_jpeg(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return bytes(buf) if ok else b""


# ============================================================
# HTML (Canvas描画はBBoxOverlay.tsxと同じ方式)
# ============================================================

PAGE = r"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Stage 2: ROI候補自動判定</title>
<style>
* { box-sizing: border-box; }
body { font-family: monospace; background: #111; color: #eee; margin: 0; padding: 12px; }
h1 { font-size: 1rem; margin: 0 0 2px; }
.goal { color: #aaa; font-size: 0.78rem; margin-bottom: 8px; }
.viewer { position: relative; display: inline-block; }
.viewer img  { display: block; image-rendering: pixelated; }
.viewer canvas { position: absolute; top: 0; left: 0; cursor: crosshair; }
.row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.params { background: #181828; border-radius: 4px; padding: 8px; margin-bottom: 10px; }
.params h3 { font-size: 0.8rem; margin: 4px 0; color: #88f; }
.prow { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
label { font-size: 0.76rem; color: #aaa; }
input[type=number] { width: 64px; background: #222; color: #eee;
                     border: 1px solid #444; border-radius: 3px; padding: 2px 4px; }
button { background: #2a5; color: #fff; border: none; border-radius: 3px;
         padding: 5px 14px; cursor: pointer; font-size: 0.8rem; }
button.sec { background: #444; }
pre { background: #0e0e1a; padding: 8px; border-radius: 4px;
      font-size: 0.72rem; overflow-x: auto; max-height: 240px; overflow-y: auto; }
.ts { color: #555; font-size: 0.7rem; margin-bottom: 6px; }
.stat { font-size: 0.78rem; margin: 4px 0 8px; }
.found { color: #4f4; } .none { color: #f44; }
</style>
</head>
<body>
<h1>Stage 2: ROI候補自動判定</h1>
<p class="goal">
  A=HoughCircles (緑円) / B=Sobel SNR → 輪郭+楕円フィット (橙楕円)<br>
  時間平均フレーム数を溜めてから「検出更新」で安定エッジを検出
</p>
<div class="ts" id="ts">-</div>

<div class="params">
  <h3>A) HoughCircles</h3>
  <div class="prow">
    <label>min_r<br><input type="number" id="h_min_r" value="__H_MIN_R__" min="5" max="200"></label>
    <label>max_r<br><input type="number" id="h_max_r" value="__H_MAX_R__" min="10" max="400"></label>
    <label>dp×10<br><input type="number" id="h_dp"    value="__H_DP__"    min="10" max="30"></label>
    <label>p1<br><input type="number"    id="h_p1"    value="__H_P1__"    min="10" max="300"></label>
    <label>p2 感度↑で減少<br><input type="number" id="h_p2" value="__H_P2__" min="5" max="200"></label>
  </div>
  <h3>B) 輪郭+楕円フィット</h3>
  <div class="prow">
    <label>min_area<br><input type="number" id="c_min_a"   value="__C_MIN_A__"   min="50"   max="10000"></label>
    <label>max_area<br><input type="number" id="c_max_a"   value="__C_MAX_A__"   min="100"  max="100000"></label>
    <label>楕円比×10<br><input type="number" id="c_ratio"   value="__C_RATIO__"   min="10"   max="50"></label>
    <label>closing k<br><input type="number" id="c_close_k" value="__C_CLOSE_K__" min="3" max="21"></label>
    <label>SNR閾値<br><input type="number" id="edge_thresh" value="3" min="1" max="30">
      <span style="color:#888;font-size:0.7rem;"><br>mean/std ↑で安定エッジのみ残る</span></label>
    <input type="hidden" id="canny_lo" value="__CANNY_LO__">
    <input type="hidden" id="canny_hi" value="__CANNY_HI__">
  </div>
  <div class="prow" style="margin-top:6px;">
    <label>時間平均フレーム数 (3DNR)<br>
      <input type="number" id="frame_n" value="8" min="1" max="32">
      <span style="color:#888;font-size:0.72rem;">　1=オフ, 8=中, 16=強 ※変更時バッファリセット</span>
    </label>
  </div>
  <button onclick="detect()">検出更新</button>
  <button class="sec" onclick="refreshImg()">エッジ画像更新</button>
  &nbsp;<label><input type="checkbox" id="auto"> 5秒自動更新</label>
</div>

<div class="stat" id="stat">-</div>

<div class="row">
  <div>
    <div style="font-size:0.78rem;color:#aaa;margin-bottom:3px;">エッジ + ROI候補オーバーレイ</div>
    <div class="viewer">
      <img id="edge_img" src="/img/edge" alt="edge" onload="syncCanvas()">
      <canvas id="overlay"></canvas>
    </div>
  </div>
</div>

<div style="margin-bottom:8px;">
  <button id="confirm_btn" onclick="confirmSelected()" disabled
          style="background:#44a;padding:6px 16px;">候補をクリックして選択</button>
  <span id="confirm_result" style="font-size:0.76rem;color:#aaf;margin-left:10px;"></span>
</div>
<details style="margin-bottom:8px;">
  <summary style="cursor:pointer;font-size:0.78rem;color:#aaa;">中間画像: Canny / Canny+Closing（輪郭デバッグ）</summary>
  <img src="/img/canny" id="canny_img" style="display:block;margin-top:4px;image-rendering:pixelated;">
  <button class="sec" style="margin-top:4px;font-size:0.75rem;" onclick="refreshCanny()">更新 (closing kを反映)</button>
</details>
<pre id="json_out">-</pre>

<script>
var autoTimer = null;
document.getElementById('auto').addEventListener('change', function() {
  if (this.checked) autoTimer = setInterval(function(){ refreshImg(); detect(); }, 5000);
  else { clearInterval(autoTimer); autoTimer = null; }
});

function syncCanvas() {
  var img = document.getElementById('edge_img');
  var cv  = document.getElementById('overlay');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.style.width  = img.width  + 'px';
  cv.style.height = img.height + 'px';
}

function refreshImg() {
  document.getElementById('edge_img').src = '/img/edge?t=' + Date.now();
}

function refreshCanny() {
  var url = '/img/canny?' + qs() + '&t=' + Date.now();
  console.log('[canny] fetch', url);
  document.getElementById('canny_img').src = url;
}

function qs() {
  return 'h_min_r='   + document.getElementById('h_min_r').value
       + '&h_max_r='  + document.getElementById('h_max_r').value
       + '&h_dp='     + document.getElementById('h_dp').value
       + '&h_p1='     + document.getElementById('h_p1').value
       + '&h_p2='     + document.getElementById('h_p2').value
       + '&c_min_a='  + document.getElementById('c_min_a').value
       + '&c_max_a='  + document.getElementById('c_max_a').value
       + '&c_ratio='  + document.getElementById('c_ratio').value
       + '&c_close_k='+ document.getElementById('c_close_k').value
       + '&canny_lo=' + document.getElementById('canny_lo').value
       + '&canny_hi=' + document.getElementById('canny_hi').value
       + '&frame_n='     + document.getElementById('frame_n').value
       + '&edge_thresh=' + document.getElementById('edge_thresh').value;
}

function detect() {
  fetch('/api/detect?' + qs())
    .then(r => r.json())
    .then(d => {
      document.getElementById('ts').textContent = new Date().toLocaleTimeString();
      document.getElementById('json_out').textContent = JSON.stringify(d, null, 2);
      var hc = d.hough.count, cc = d.contour.count;
      var dbg = d.contour.debug || {};
      var topA = (dbg.top_areas || []).slice(0,5).join(', ');
      document.getElementById('stat').innerHTML =
        'A) HoughCircles: <span class="' + (hc>0?'found':'none') + '">' + hc + ' 個</span>'
        + '&nbsp;&nbsp;B) 輪郭+楕円: <span class="' + (cc>0?'found':'none') + '">' + cc + ' 個</span>'
        + (topA ? '&nbsp;&nbsp;<span style="color:#888;font-size:0.72rem;">輪郭top面積: [' + topA + ']</span>' : '');
      drawOverlay(d);
    })
    .catch(e => { document.getElementById('stat').textContent = 'ERROR: ' + e; });
}

// 全候補リスト (描画・クリック判定に使用)
var allCandidates = [];
var selected = new Set();

function drawOverlay(d) {
  allCandidates = [];
  (d.hough.candidates   || []).forEach(function(c) { allCandidates.push(c); });
  (d.contour.candidates || []).forEach(function(c) { allCandidates.push(c); });
  selected = new Set();
  redraw();
  updateConfirmBtn();
}

function redraw() {
  var cv  = document.getElementById('overlay');
  syncCanvas();
  var ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);

  allCandidates.forEach(function(c, i) {
    var isHough   = c.method === 'hough';
    var isSel     = selected.has(i);
    var baseColor = isHough ? '#00ff44' : '#ffb300';
    ctx.strokeStyle = isSel ? '#ffffff' : baseColor;
    ctx.lineWidth   = isSel ? 3 : 1.5;

    if (isHough) {
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      ctx.stroke();
      if (isSel) {
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = isSel ? '#fff' : baseColor;
      ctx.font = '11px monospace';
      var label = (isHough ? 'A' : 'B') + '#' + i + ' r=' + c.r;
      ctx.fillText(label, c.cx - c.r, Math.max(c.cy - c.r - 3, 12));
    } else {
      drawEllipse(ctx, c.cx, c.cy, c.major/2, c.minor/2, c.angle * Math.PI/180, isSel);
      ctx.fillStyle = isSel ? '#fff' : baseColor;
      ctx.font = '11px monospace';
      var label2 = 'B#' + i + ' ' + Math.round(c.major) + 'x' + Math.round(c.minor);
      ctx.fillText(label2, c.cx - c.major/2, Math.max(c.cy - c.major/2 - 3, 12));
    }

    // 中心点
    ctx.fillStyle = isSel ? '#fff' : '#ff4444';
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawEllipse(ctx, cx, cy, rx, ry, angle, filled) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (filled) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();
  }
  ctx.restore();
}

// Canvas クリックで候補を選択/解除
document.getElementById('overlay').addEventListener('click', function(e) {
  var cv   = document.getElementById('overlay');
  var rect = cv.getBoundingClientRect();
  var scaleX = cv.width  / rect.width;
  var scaleY = cv.height / rect.height;
  var mx = (e.clientX - rect.left) * scaleX;
  var my = (e.clientY - rect.top)  * scaleY;

  var hit = -1;
  var hitDist = Infinity;
  allCandidates.forEach(function(c, i) {
    var dx = mx - c.cx, dy = my - c.cy;
    var dist = Math.sqrt(dx*dx + dy*dy);
    var r = c.method === 'hough' ? c.r : (c.major / 2);
    if (dist <= r + 6 && dist < hitDist) { hit = i; hitDist = dist; }
  });

  if (hit >= 0) {
    if (selected.has(hit)) selected.delete(hit); else selected.add(hit);
    redraw();
    updateConfirmBtn();
  }
});

function updateConfirmBtn() {
  var btn = document.getElementById('confirm_btn');
  btn.disabled = selected.size === 0;
  btn.textContent = selected.size > 0
    ? '選択した ' + selected.size + ' 個を正解として送信'
    : '候補をクリックして選択';
}

function confirmSelected() {
  var confirmed = [];
  selected.forEach(function(i) { confirmed.push(allCandidates[i]); });
  var params = {
    hough: {
      min_r: +document.getElementById('h_min_r').value,
      max_r: +document.getElementById('h_max_r').value,
      dp:    +document.getElementById('h_dp').value / 10,
      p1:    +document.getElementById('h_p1').value,
      p2:    +document.getElementById('h_p2').value,
    },
    contour: {
      min_area:      +document.getElementById('c_min_a').value,
      max_area:      +document.getElementById('c_max_a').value,
      ellipse_ratio: +document.getElementById('c_ratio').value / 10,
      close_k:       +document.getElementById('c_close_k').value,
    },
  };
  fetch('/api/confirm', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ confirmed: confirmed, params: params }),
  })
  .then(r => r.json())
  .then(d => {
    document.getElementById('confirm_result').textContent
      = '送信完了: ' + JSON.stringify(d);
  });
}

// 起動時に一度取得
window.addEventListener('load', function() { detect(); });
</script>
</body>
</html>
"""


# ============================================================
# HTTPハンドラ
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def _qs(self): return parse_qs(urlparse(self.path).query)

    def _int(self, qs, key, default):
        try: return int(qs.get(key, [default])[0])
        except ValueError: return default

    def _send(self, body: bytes, ct: str):
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        qs   = self._qs()
        if   path == "/":            self._serve_index()
        elif path == "/img/edge":    self._serve_edge()
        elif path == "/img/canny":   self._serve_canny()
        elif path == "/api/detect":  self._serve_detect(qs)
        else: self.send_response(404); self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/confirm":
            self._serve_confirm()
        else:
            self.send_response(404); self.end_headers()

    def _serve_confirm(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        try:
            data      = json.loads(body)
            confirmed = data.get("confirmed", [])
            params    = data.get("params", {})
            # bowl_roi.json に保存 (Stage 3 以降で使用)
            out_path = REPO_ROOT / "scripts" / "bowl_roi_candidates.json"
            record = {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "stage1":    {"blur": S1_BLUR, "ksize": S1_KSIZE,
                              "clip_limit": S1_CLIP_LIMIT, "boost": S1_BOOST},
                "params":    params,
                "confirmed": confirmed,
                "count":     len(confirmed),
            }
            with open(out_path, "w") as f:
                json.dump(record, f, ensure_ascii=False, indent=2)
            print(f"[confirm] {len(confirmed)} bowls saved → {out_path}", flush=True)
            resp = json.dumps({"saved": len(confirmed), "path": str(out_path)}).encode()
        except Exception as e:
            resp = json.dumps({"error": str(e)}).encode()
        self._send(resp, "application/json")

    def _serve_index(self):
        hp, cp = INIT_HOUGH, INIT_CONT
        html = PAGE \
            .replace("__H_MIN_R__",   str(hp["min_r"])) \
            .replace("__H_MAX_R__",   str(hp["max_r"])) \
            .replace("__H_DP__",      str(hp["dp"])) \
            .replace("__H_P1__",      str(hp["p1"])) \
            .replace("__H_P2__",      str(hp["p2"])) \
            .replace("__C_MIN_A__",   str(cp["min_area"])) \
            .replace("__C_MAX_A__",   str(cp["max_area"])) \
            .replace("__C_RATIO__",   str(cp["ellipse_ratio"])) \
            .replace("__C_CLOSE_K__", str(cp.get("close_k",  DEFAULT_CONT["close_k"]))) \
            .replace("__CANNY_LO__",  str(cp.get("canny_lo", DEFAULT_CONT["canny_lo"]))) \
            .replace("__CANNY_HI__",  str(cp.get("canny_hi", DEFAULT_CONT["canny_hi"])))
        self._send(html.encode(), "text/html; charset=utf-8")

    def _serve_edge(self):
        gray_left, msg = grab_gray_left()
        if gray_left is None:
            img = np.zeros((360, 320, 3), dtype=np.uint8)
            cv2.putText(img, msg[:40], (6, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,200), 1)
            self._send(to_jpeg(img), "image/jpeg"); return
        edge = build_edge(gray_left)
        # グレースケールをBGRにしてラベルを追加
        out = cv2.cvtColor(edge, cv2.COLOR_GRAY2BGR)
        cv2.putText(out, "Stage1 edge (left half)", (4, 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 200, 255), 1)
        self._send(to_jpeg(out), "image/jpeg")

    def _serve_canny(self):
        """CLAHE→Canny→Closing の中間画像。輪郭が取れているか確認用。"""
        qs       = self._qs()
        close_k  = self._int(qs, "c_close_k", DEFAULT_CONT["close_k"])
        canny_lo = self._int(qs, "canny_lo", DEFAULT_CONT["canny_lo"])
        canny_hi = self._int(qs, "canny_hi", DEFAULT_CONT["canny_hi"])
        print(f"[canny] close_k={close_k} canny={canny_lo}/{canny_hi}", flush=True)
        gray_left, msg = grab_gray_left()
        if gray_left is None:
            img = np.zeros((360, 320, 3), dtype=np.uint8)
            cv2.putText(img, msg[:40], (6, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,200), 1)
            self._send(to_jpeg(img), "image/jpeg"); return
        edge_thresh = self._int(qs, "edge_thresh", 64)
        eq = cv2.createCLAHE(clipLimit=S1_CLIP_LIMIT, tileGridSize=(8, 8))
        src = eq.apply(gray_left)
        blurred = cv2.GaussianBlur(src, (S1_BLUR, S1_BLUR), 0)
        mean_map, snr_map = push_edge(gray_left)
        stable = (snr_map >= edge_thresh).astype(np.uint8) * 255
        ksz = max(2, close_k)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
        closed = cv2.morphologyEx(stable, cv2.MORPH_CLOSE, kernel)
        # 3列: 単フレームSobel / 時間平均Sobel / SNRマップ(閾値後)
        n_frames = len(_edge_ring) or 1
        single = _sobel_mag(gray_left)
        def to8(m): return cv2.convertScaleAbs(m, alpha=255.0 / (m.max() + 1e-6))
        snr_vis = cv2.convertScaleAbs(snr_map, alpha=255.0 / (snr_map.max() + 1e-6))
        side = np.hstack([to8(single), to8(mean_map), closed])
        out = cv2.cvtColor(side, cv2.COLOR_GRAY2BGR)
        W = single.shape[1]
        cv2.putText(out, "Single Sobel", (4, 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,200,255), 1)
        cv2.putText(out, f"Mean ({n_frames}f)", (W+4, 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,200,0), 1)
        cv2.putText(out, f"SNR>={edge_thresh} k={ksz}", (W*2+4, 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,100), 1)
        self._send(to_jpeg(out), "image/jpeg")

    def _serve_detect(self, qs: dict):
        n = self._int(qs, "frame_n", _edge_n)
        if n != _edge_n:
            set_edge_n(n)
        gray_left, msg = grab_gray_left()
        if gray_left is None:
            self._send(json.dumps({"error": msg}).encode(), "application/json"); return
        edge = build_edge(gray_left)

        hp = {
            "min_r": self._int(qs, "h_min_r", DEFAULT_HOUGH["min_r"]),
            "max_r": self._int(qs, "h_max_r", DEFAULT_HOUGH["max_r"]),
            "dp":    self._int(qs, "h_dp",    DEFAULT_HOUGH["dp"]) / 10.0,
            "p1":    self._int(qs, "h_p1",    DEFAULT_HOUGH["p1"]),
            "p2":    self._int(qs, "h_p2",    DEFAULT_HOUGH["p2"]),
        }
        cp = {
            "min_area":      self._int(qs, "c_min_a",   DEFAULT_CONT["min_area"]),
            "max_area":      self._int(qs, "c_max_a",   DEFAULT_CONT["max_area"]),
            "ellipse_ratio": self._int(qs, "c_ratio",   DEFAULT_CONT["ellipse_ratio"]) / 10.0,
            "close_k":       self._int(qs, "c_close_k", DEFAULT_CONT["close_k"]),
            "canny_lo":      self._int(qs, "canny_lo",    DEFAULT_CONT["canny_lo"]),
            "canny_hi":      self._int(qs, "canny_hi",    DEFAULT_CONT["canny_hi"]),
            "edge_thresh":   self._int(qs, "edge_thresh", 64),
        }

        hough_c = detect_hough(edge, **hp)
        cont_c, cont_stats = detect_contour(gray_left, **cp)

        result = {
            "frame":   msg,
            "hough":   {"count": len(hough_c), "candidates": hough_c},
            "contour": {"count": len(cont_c),  "candidates": cont_c,
                        "debug": cont_stats},
        }
        self._send(json.dumps(result, ensure_ascii=False, indent=2).encode(),
                   "application/json")


# ============================================================
# main
# ============================================================

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8083)
    args = ap.parse_args()
    if not HB_MEM_AVAILABLE:
        print("[WARN] libhbmem 初期化失敗。実機で実行してください。", file=sys.stderr)
    print(f"http://0.0.0.0:{args.port}/")
    HTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
