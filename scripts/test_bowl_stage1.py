#!/usr/bin/env python3
"""
Stage 1 検証: エッジ化でお皿が見えるか？

http://device:8083/ をブラウザで開く。
複数のパラメータセットのSobelエッジ画像を横並びで表示し、
お皿のリムが視認できるか人間が判断する。

Usage:
    sudo uv run scripts/test_bowl_stage1.py [--port 8083]
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

# デフォルトのパラメータセット（横並び比較用）
DEFAULT_PRESETS = [
    {"label": "ベース",              "blur": 5, "ksize": 3, "clahe": 0, "clip": 20, "boost": 10},
    {"label": "CLAHE弱",            "blur": 5, "ksize": 3, "clahe": 1, "clip": 20, "boost": 10},
    {"label": "CLAHE強",            "blur": 5, "ksize": 3, "clahe": 1, "clip": 40, "boost": 10},
    {"label": "CLAHE強+エッジ強調", "blur": 5, "ksize": 3, "clahe": 1, "clip": 40, "boost": 30},
]


# ============================================================
# フレーム取得
# ============================================================

def grab_bgr() -> tuple[np.ndarray | None, str]:
    shm = ZeroCopySharedMemory(SHM_NAME_YOLO_ZC)
    if not shm.open():
        return None, "SHM open 失敗 (sudo で実行してください)"
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
        bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12)
        return bgr, f"camera_id={zc.camera_id} {zc.width}x{zc.height}"
    except Exception as e:
        return None, str(e)
    finally:
        if hb_buf:
            hb_buf.release()
        shm.close()


# ============================================================
# エッジ処理
# ============================================================

def sobel_edge(
    gray: np.ndarray,
    blur: int,
    ksize: int,
    clahe: bool = False,
    clip_limit: float = 2.0,
    boost: float = 1.0,
    roi_left_half: bool = True,
) -> tuple[np.ndarray, float]:
    """
    Sobelエッジマップと処理時間(ms)を返す。

    Args:
        clahe:         True で局所コントラスト強調（白っぽい物体に有効）
        clip_limit:    CLAHE のクリッピング閾値（大きいほど強調強い）
        boost:         エッジ強度の倍率（弱いエッジを可視化したいとき > 1.0）
        roi_left_half: True で左半分のみ処理（お皿は左半分にしか現れないヒューリスティック）
    """
    blur = blur if blur % 2 == 1 else blur + 1
    ksize = ksize if ksize % 2 == 1 else ksize + 1
    h, w = gray.shape[:2]
    mid_x = w // 2

    t0 = time.perf_counter()

    # 処理対象を左半分ROIに絞る
    src = gray[:, :mid_x] if roi_left_half else gray

    if clahe:
        eq = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
        src = eq.apply(src)

    blurred = cv2.GaussianBlur(src, (blur, blur), 0)
    sx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=ksize)
    sy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=ksize)
    mag = cv2.magnitude(sx, sy)

    scale = boost * 255.0 / (mag.max() + 1e-6)
    edge_left = cv2.convertScaleAbs(mag, alpha=scale)

    elapsed_ms = (time.perf_counter() - t0) * 1000

    # フルサイズに戻して右半分はグレーアウト、境界線を描画
    if roi_left_half:
        edge_full = np.zeros((h, w), dtype=np.uint8)
        edge_full[:, :mid_x] = edge_left
        edge_full[:, mid_x:] = (gray[:, mid_x:] // 3)  # 右半分は暗く表示
        # 境界線（黄色は使えないのでBGR変換後に引く → ここでは白線）
        edge_rgb = cv2.cvtColor(edge_full, cv2.COLOR_GRAY2BGR)
        cv2.line(edge_rgb, (mid_x, 0), (mid_x, h - 1), (0, 200, 255), 2)
        cv2.putText(edge_rgb, "bowl ROI", (4, 16),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 200, 255), 1)
        return edge_rgb, elapsed_ms

    return edge_left, elapsed_ms


def to_jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("encode failed")
    return bytes(buf)


def error_img(msg: str, w: int = 640, h: int = 360) -> bytes:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    cv2.putText(img, msg[:60], (10, h // 2),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 200), 2)
    return to_jpeg(img)


# ============================================================
# HTML
# ============================================================

PAGE = """\
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Stage 1: エッジでお皿が見えるか</title>
<style>
* {{ box-sizing: border-box; }}
body {{ font-family: monospace; background: #111; color: #eee;
       margin: 0; padding: 12px; }}
h1 {{ font-size: 1rem; margin: 0 0 4px; }}
.goal {{ color: #aaa; font-size: 0.8rem; margin-bottom: 10px; }}
.grid {{ display: flex; gap: 8px; flex-wrap: wrap; overflow-x: auto; }}
.cell {{ background: #1a1a1a; border-radius: 4px; padding: 8px;
         display: inline-block; }}
.cell h2 {{ font-size: 0.8rem; margin: 0 0 4px; color: #8af; }}
.cell img {{ display: block; image-rendering: pixelated; }}
.meta {{ font-size: 0.72rem; color: #888; margin-top: 4px; }}
.ms {{ color: {ms_color}; }}
hr {{ border-color: #333; margin: 12px 0; }}

/* カスタムセット */
.custom {{ background: #1a1a2a; border-radius: 4px; padding: 8px;
           margin-bottom: 10px; }}
.custom h2 {{ font-size: 0.85rem; margin: 0 0 6px; }}
.row {{ display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }}
label {{ font-size: 0.78rem; color: #aaa; }}
input[type=number] {{ width: 56px; background: #222; color: #eee;
                      border: 1px solid #444; border-radius: 3px;
                      padding: 2px 4px; font-family: monospace; }}
button {{ background: #2a4; color: #fff; border: none; border-radius: 3px;
          padding: 5px 12px; cursor: pointer; font-size: 0.8rem; }}
button.sec {{ background: #333; color: #ccc; }}
.ts {{ color: #555; font-size: 0.7rem; }}
</style>
</head>
<body>
<h1>Stage 1: エッジでお皿が見えるか？</h1>
<p class="goal">ゴール: Sobelエッジマップ上でお皿のリムが視認できること を確認する。<br>
カメラ映像は <a href="/" style="color:#88f" target="_blank">petcamera</a> で別タブ確認。</p>

<div class="ts">取得: {timestamp} &nbsp;
  <button class="sec" onclick="location.reload()">Refresh</button>
  &nbsp;<label><input type="checkbox" id="auto"> 5秒自動更新</label>
</div>

<hr>

<!-- カスタムパラメータ -->
<div class="custom">
  <h2>カスタム検証</h2>
  <div class="row">
    <label>blur <input type="number" id="c_blur" value="5" min="1" max="31" step="2"></label>
    <label>ksize <input type="number" id="c_ksize" value="3" min="1" max="7" step="2"></label>
    <label><input type="checkbox" id="c_clahe"> CLAHE</label>
    <label>clip×10 <input type="number" id="c_clip" value="20" min="5" max="100" step="5"></label>
    <label>boost×10 <input type="number" id="c_boost" value="10" min="10" max="100" step="5"></label>
    <button onclick="runCustom()">エッジ取得</button>
  </div>
  <img id="custom_img" src="" alt="" style="display:none;margin-top:6px;image-rendering:pixelated;">
  <div class="meta" id="custom_meta"></div>
</div>

<!-- プリセット横並び -->
<h2 style="font-size:0.85rem;margin:0 0 6px;">プリセット比較</h2>
<div class="grid">
{preset_cells}
</div>

<script>
var auto = document.getElementById('auto');
var timer;
auto.addEventListener('change', function() {{
  if (this.checked) timer = setInterval(function(){{ location.reload(); }}, 5000);
  else clearInterval(timer);
}});

function runCustom() {{
  var blur  = document.getElementById('c_blur').value;
  var ksize = document.getElementById('c_ksize').value;
  var clahe = document.getElementById('c_clahe').checked ? 1 : 0;
  var clip  = document.getElementById('c_clip').value;
  var boost = document.getElementById('c_boost').value;
  var qs = 'blur='+blur+'&ksize='+ksize+'&clahe='+clahe+'&clip='+clip+'&boost='+boost;
  var img  = document.getElementById('custom_img');
  var meta = document.getElementById('custom_meta');
  meta.textContent = '取得中...';
  img.style.display = 'block';
  img.src = '/edge.jpg?' + qs + '&t=' + Date.now();
  fetch('/edge_ms?' + qs)
    .then(r => r.json())
    .then(d => {{ meta.textContent = qs + '  処理時間: ' + d.ms.toFixed(1) + 'ms'; }})
    .catch(() => {{}});
}}
</script>
</body>
</html>
"""

CELL_TMPL = """\
<div class="cell">
  <h2>{label}</h2>
  <div class="meta" style="margin-bottom:3px;color:#666;">blur={blur} ksize={ksize} clahe={clahe} clip={clip} boost={boost}</div>
  <img src="/edge.jpg?blur={blur}&ksize={ksize}&clahe={clahe}&clip={clip}&boost={boost}&t={ts}" alt="edge">
  <div class="meta">処理時間: <span class="ms">{ms:.1f}ms</span></div>
</div>"""


# ============================================================
# HTTP ハンドラ
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _qs(self) -> dict:
        return parse_qs(urlparse(self.path).query)

    def _int(self, qs, key, default):
        try:
            return int(qs.get(key, [default])[0])
        except ValueError:
            return default

    def _send(self, body: bytes, ct: str, extra_headers: dict | None = None):
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        qs   = self._qs()

        if path == "/":
            self._serve_index()
        elif path == "/edge.jpg":
            self._serve_edge_jpg(qs)
        elif path == "/edge_ms":
            self._serve_edge_ms(qs)
        else:
            self.send_response(404)
            self.end_headers()

    def _edge_params(self, qs: dict) -> dict:
        return {
            "blur":  self._int(qs, "blur",  5),
            "ksize": self._int(qs, "ksize", 3),
            "clahe": self._int(qs, "clahe", 0) != 0,
            "clip_limit": self._int(qs, "clip", 20) / 10.0,
            "boost": self._int(qs, "boost", 10) / 10.0,
        }

    # ── /edge.jpg ──────────────────────────────────────────
    def _serve_edge_jpg(self, qs: dict):
        p = self._edge_params(qs)
        bgr, _ = grab_bgr()
        if bgr is None:
            self._send(error_img("SHM取得失敗"), "image/jpeg")
            return
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        edge, _ = sobel_edge(gray, **p)
        self._send(to_jpeg(edge), "image/jpeg")

    # ── /edge_ms (処理時間だけJSON返す) ───────────────────
    def _serve_edge_ms(self, qs: dict):
        p = self._edge_params(qs)
        bgr, _ = grab_bgr()
        if bgr is None:
            body = json.dumps({"ms": -1}).encode()
        else:
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            _, ms = sobel_edge(gray, **p)
            body = json.dumps({"ms": round(ms, 2)}).encode()
        self._send(body, "application/json")

    # ── / (インデックス) ───────────────────────────────────
    def _serve_index(self):
        bgr, _ = grab_bgr()
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr is not None else None
        ts = int(time.time())

        cells = []
        for p in DEFAULT_PRESETS:
            ms = 0.0
            if gray is not None:
                _, ms = sobel_edge(
                    gray,
                    blur=p["blur"], ksize=p["ksize"],
                    clahe=bool(p["clahe"]),
                    clip_limit=p["clip"] / 10.0,
                    boost=p["boost"] / 10.0,
                )
            ms_color = "#f80" if ms > 20 else "#4f4"
            cells.append(CELL_TMPL.format(
                label=p["label"],
                blur=p["blur"], ksize=p["ksize"],
                clahe=p["clahe"], clip=p["clip"], boost=p["boost"],
                ts=ts, ms=ms, ms_color=ms_color,
            ))

        # ms_color は全体の最大値で決める（テンプレート内で使用済みなので再適用不要）
        html = PAGE.format(
            timestamp=time.strftime("%Y-%m-%d %H:%M:%S"),
            preset_cells="\n".join(cells),
            ms_color="#4f4",  # PAGE テンプレート内の {ms_color} 用ダミー
        )
        self._send(html.encode(), "text/html; charset=utf-8")


# ============================================================
# main
# ============================================================

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8083)
    args = ap.parse_args()

    if not HB_MEM_AVAILABLE:
        print("[WARN] libhbmem 初期化失敗。実機(RDK X5)で実行してください。", file=sys.stderr)

    print(f"http://0.0.0.0:{args.port}/ で起動")
    print("Ctrl-C で終了")
    HTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
