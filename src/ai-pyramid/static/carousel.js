// ── Constants ──
const MARGIN = 12, BORDER = 2, GAP = 8, PW = 404, PH = 228;
const CELL_W = PW + 2 * BORDER, CELL_H = PH + 2 * BORDER;
const PANELS = [0,1,2,3].map(i => {
  const col = i % 2, row = Math.floor(i / 2);
  return { x: MARGIN + BORDER + col * (CELL_W + GAP), y: MARGIN + BORDER + row * (CELL_H + GAP), w: PW, h: PH };
});

const CLASS_COLORS = {
  cat: "#6EFF9E", dog: "#FFC878", bird: "#A0DCFF",
  food_bowl: "#78C8FF", water_bowl: "#FF8C8C",
  person: "#FFF08C", cup: "#FFBED2"
};

// ── Mock detections (comic-space coordinates) ──
const MOCK_DETECTIONS = [
  { id:1, bbox_x:60,  bbox_y:40,  bbox_w:130, bbox_h:170, yolo_class:"cat",       pet_id:"chatora", confidence:0.95 },
  { id:2, bbox_x:300, bbox_y:120, bbox_w:90,  bbox_h:70,  yolo_class:"food_bowl", pet_id:null,      confidence:0.88 },
  { id:3, bbox_x:480, bbox_y:50,  bbox_w:140, bbox_h:160, yolo_class:"cat",       pet_id:"mike",    confidence:0.92 },
  { id:4, bbox_x:720, bbox_y:80,  bbox_w:80,  bbox_h:60,  yolo_class:"cup",       pet_id:null,      confidence:0.76 },
  { id:5, bbox_x:50,  bbox_y:290, bbox_w:150, bbox_h:160, yolo_class:"cat",       pet_id:"chatora", confidence:0.97 },
  { id:6, bbox_x:280, bbox_y:330, bbox_w:100, bbox_h:70,  yolo_class:"water_bowl",pet_id:null,      confidence:0.85 },
  { id:7, bbox_x:470, bbox_y:280, bbox_w:130, bbox_h:170, yolo_class:"cat",       pet_id:"mike",    confidence:0.91 },
  { id:8, bbox_x:650, bbox_y:310, bbox_w:120, bbox_h:140, yolo_class:"cat",       pet_id:"chatora", confidence:0.89 },
];

function panelOf(det) {
  const cx = det.bbox_x + det.bbox_w / 2;
  const cy = det.bbox_y + det.bbox_h / 2;
  return PANELS.findIndex(p => cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h);
}

function detsForPanel(idx) {
  return MOCK_DETECTIONS.filter(d => panelOf(d) === idx);
}

// ── DOM refs ──
const statusBar = document.getElementById("statusBar");
const breadcrumb = document.getElementById("breadcrumb");
const comicView = document.getElementById("comicView");
const carouselView = document.getElementById("carouselView");
const comicImg = document.getElementById("comicImg");
const carousel = document.getElementById("carousel");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const hdBtn = document.getElementById("hdBtn");
const hdProgress = document.getElementById("hdProgress");
const upscaleBadge = document.getElementById("upscaleBadge");
const dots = document.querySelectorAll(".panel-dot");
const detTitle = document.getElementById("detTitle");
const detList = document.getElementById("detList");
const photoSelect = document.getElementById("photoSelect");
let dlBtn = document.getElementById("dlBtn");
const canvases = [0,1,2,3].map(i => document.getElementById("pc" + i));

let activePanel = 0;
let viewMode = "comic"; // "comic" | "panel"
let upscaleState = {}; // panelIdx -> "raw"|"fast"|"hd"
let currentFilename = "";

function updateDownloadLink() {
  const fn = encodeURIComponent(currentFilename);
  if (viewMode === "panel") {
    dlBtn.href = "/api/photos/" + fn + "/panel/" + activePanel;
    dlBtn.download = currentFilename.replace(".jpg", "_p" + activePanel + ".jpg");
    dlBtn.textContent = "JPEG P" + activePanel;
  } else {
    dlBtn.href = "/api/photos/" + fn;
    dlBtn.download = currentFilename;
    dlBtn.textContent = "JPEG";
  }
}

// ── Photo list ──
const resp = await fetch("/api/photos?limit=30");
const data = await resp.json();
data.events.forEach(e => {
  const opt = document.createElement("option");
  opt.value = e.source_filename;
  opt.textContent = e.source_filename.replace("comic_","").replace(".jpg","");
  photoSelect.appendChild(opt);
});
const latestPhoto = document.documentElement.dataset.latestPhoto || "";
if (latestPhoto) photoSelect.value = latestPhoto;

// ── TF.js loading ──
let tf = null;
let backend = "";
let modelCache = {};
let currentModel = null;
let resultCache = {};

async function ensureTF() {
  if (tf) return true;
  statusBar.textContent = "Loading TF.js...";
  statusBar.className = "status-bar loading";
  try {
    await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
    tf = window.tf;
    await tf.ready();
    // Try WebGPU
    try {
      await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js");
      await tf.setBackend("webgpu");
      await tf.ready();
    } catch {}
    backend = tf.getBackend();
    statusBar.textContent = "Ready (" + backend + ")";
    statusBar.className = "status-bar ok";
    return true;
  } catch (e) {
    statusBar.textContent = "TF.js failed: " + e.message;
    statusBar.className = "status-bar err";
    return false;
  }
}

async function loadModel(name) {
  if (modelCache[name]) { currentModel = modelCache[name]; return; }
  statusBar.textContent = "Loading " + name + "...";
  statusBar.className = "status-bar loading";
  const model = await tf.loadGraphModel("/api/models/tfjs/" + name + "/model.json");
  modelCache[name] = model;
  currentModel = model;
}

// ── Upscale ──
const TILE = 128, SCALE = 4;

function cropPanelCanvas(img, idx) {
  const p = PANELS[idx];
  const c = document.createElement("canvas");
  c.width = p.w; c.height = p.h;
  c.getContext("2d").drawImage(img, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
  return c;
}

// Cancellation token for upscale operations
let cancelToken = 0;

async function upscaleToCanvas(srcCanvas, outCanvas, onProgress, token) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const outW = sw * SCALE, outH = sh * SCALE;
  outCanvas.width = outW; outCanvas.height = outH;
  const dCtx = outCanvas.getContext("2d");
  const tilesX = Math.ceil(sw / TILE), tilesY = Math.ceil(sh / TILE);
  const total = tilesX * tilesY;
  let done = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (token !== cancelToken) return false; // cancelled
      const sx = tx * TILE, sy = ty * TILE;
      const tw = Math.min(TILE, sw - sx), th = Math.min(TILE, sh - sy);
      const tileCanvas = document.createElement("canvas");
      tileCanvas.width = TILE; tileCanvas.height = TILE;
      const tCtx = tileCanvas.getContext("2d");
      tCtx.drawImage(srcCanvas, sx, sy, tw, th, 0, 0, tw, th);
      if (tw < TILE) tCtx.drawImage(tileCanvas, tw-1, 0, 1, th, tw, 0, TILE-tw, th);
      if (th < TILE) tCtx.drawImage(tileCanvas, 0, th-1, TILE, 1, 0, th, TILE, TILE-th);
      const outputTensor = tf.tidy(() => {
        const input = tf.browser.fromPixels(tileCanvas).toFloat().div(255.0).expandDims(0);
        return currentModel.predict(input);
      });
      const clamped = outputTensor.squeeze().clipByValue(0, 1);
      const pixels = await tf.browser.toPixels(clamped);
      clamped.dispose(); outputTensor.dispose();
      const cropW = tw * SCALE, cropH = th * SCALE;
      const imgData = new ImageData(new Uint8ClampedArray(pixels.buffer), TILE * SCALE, TILE * SCALE);
      const tmp = document.createElement("canvas");
      tmp.width = TILE * SCALE; tmp.height = TILE * SCALE;
      tmp.getContext("2d").putImageData(imgData, 0, 0);
      dCtx.drawImage(tmp, 0, 0, cropW, cropH, sx * SCALE, sy * SCALE, cropW, cropH);
      done++;
      onProgress?.(done, total);
    }
  }
  return true; // completed
}

// Serialized upscale queue — only one operation at a time, new requests cancel the current one
let upscaleQueue = Promise.resolve();
let upscaleBusy = false;

function upscalePanel(idx, modelName) {
  const token = ++cancelToken; // cancel any in-flight operation
  const job = async () => {
    upscaleBusy = true;
    try {
      if (token !== cancelToken) return; // already superseded
      if (!await ensureTF()) return;
      if (token !== cancelToken) return;
      await loadModel(modelName);
      if (token !== cancelToken) return;
      const src = cropPanelCanvas(comicImg, idx);
      const canvas = canvases[idx];
      const t0 = performance.now();
      const label = modelName === "general_plus" ? "HD" : "fast";
      statusBar.textContent = "Upscaling P" + idx + " (" + label + ")...";
      statusBar.className = "status-bar loading";
      const completed = await upscaleToCanvas(src, canvas, (done, total) => {
        if (modelName === "general_plus") {
          hdProgress.style.width = (done / total * 100) + "%";
        }
      }, token);
      if (!completed || token !== cancelToken) return; // was cancelled
      const ms = (performance.now() - t0).toFixed(0);
      upscaleState[idx] = modelName === "general_plus" ? "hd" : "fast";
      statusBar.textContent = "P" + idx + " " + label + " " + ms + "ms (" + backend + ")";
      statusBar.className = "status-bar ok";
      hdProgress.style.width = "0";
      hdBtn.classList.remove("loading");
      if (idx === activePanel) updateUpscaleBadge(idx);
      // Re-render bboxes (canvas size changed after upscale)
      renderBboxes(idx);
      resultCache[idx + ":" + modelName] = true;
      // Prefetch next panel with fast
      const next = (idx + 1) % 4;
      if (!resultCache[next + ":general_fast"] && token === cancelToken) {
        upscalePanel(next, "general_fast");
      }
    } catch (e) {
      console.error("upscale error:", e);
      statusBar.textContent = "Error: " + e.message;
      statusBar.className = "status-bar err";
      hdBtn.classList.remove("loading");
      hdProgress.style.width = "0";
    } finally {
      upscaleBusy = false;
    }
  };
  // Chain onto queue so operations never overlap
  upscaleQueue = upscaleQueue.then(job);
}

// ── View switching ──
function showComic() {
  viewMode = "comic";
  resetZoom();
  comicView.style.display = "";
  carouselView.style.display = "none";
  updateBreadcrumb();
  renderDetections(null);
  updateDownloadLink();
}

function showPanel(idx) {
  viewMode = "panel";
  activePanel = idx;
  comicView.style.display = "none";
  carouselView.style.display = "";
  // Draw raw crops for all panels
  for (let i = 0; i < 4; i++) {
    if (!upscaleState[i]) {
      const src = cropPanelCanvas(comicImg, i);
      const c = canvases[i];
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      upscaleState[i] = "raw";
    }
  }
  // Scroll to target panel
  carousel.scrollTo({ left: idx * carousel.clientWidth, behavior: "instant" });
  updateDots(idx);
  updateBreadcrumb();
  updateNavBtns();
  renderDetections(idx);
  updateUpscaleBadge(idx);
  // Render bboxes on all panels (raw crop is ready)
  renderAllBboxes();
  updateDownloadLink();
  // Auto-upscale with fast
  if (!resultCache[idx + ":general_fast"]) {
    upscalePanel(idx, "general_fast");
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function updateBreadcrumb() {
  breadcrumb.replaceChildren();
  if (viewMode === "comic") {
    breadcrumb.appendChild(el("span", "crumb current", "All panels"));
  } else {
    const back = el("span", "crumb", "All panels");
    back.addEventListener("click", showComic);
    breadcrumb.appendChild(back);
    breadcrumb.appendChild(el("span", "crumb-sep", "\u2192"));
    breadcrumb.appendChild(el("span", "crumb current", "Panel " + activePanel));
  }
  dlBtn = el("a", "pill dl", "JPEG");
  dlBtn.download = "";
  breadcrumb.appendChild(dlBtn);
  updateDownloadLink();
}

function updateDots(idx) {
  dots.forEach((d, i) => d.classList.toggle("active", i === idx));
}

function updateNavBtns() {
  prevBtn.disabled = activePanel <= 0;
  nextBtn.disabled = activePanel >= 3;
}

function updateUpscaleBadge(idx) {
  const state = upscaleState[idx];
  if (state === "fast") {
    upscaleBadge.style.display = "";
    upscaleBadge.textContent = "4x fast \u00b7 " + backend;
  } else if (state === "hd") {
    upscaleBadge.style.display = "";
    upscaleBadge.textContent = "4x HD \u00b7 " + backend;
  } else {
    upscaleBadge.style.display = "none";
  }
  // Update HD button state
  hdBtn.classList.toggle("done", state === "hd");
  hdBtn.classList.remove("loading");
}

// ── Detections rendering ──
function renderDetections(panelIdx) {
  const dets = panelIdx === null ? MOCK_DETECTIONS : detsForPanel(panelIdx);
  detTitle.textContent = panelIdx === null
    ? "Detections (" + MOCK_DETECTIONS.length + ")"
    : "Panel " + panelIdx + " detections (" + dets.length + ")";
  detList.replaceChildren();
  dets.forEach(d => {
    const color = CLASS_COLORS[d.yolo_class] || "#94a3b8";
    const pct = d.confidence ? (d.confidence * 100).toFixed(0) : "0";

    const li = el("li", "det-item");
    li.dataset.detId = d.id;
    li.dataset.panel = panelOf(d);

    const dot = el("span", "det-color");
    dot.style.background = color;
    li.appendChild(dot);
    li.appendChild(el("span", "det-class", d.yolo_class));
    if (d.pet_id) li.appendChild(el("span", "det-pet", "(" + d.pet_id + ")"));

    const bar = el("span", "det-conf-bar");
    const fill = el("span", "det-conf-fill");
    fill.style.width = pct + "%";
    fill.style.background = color;
    bar.appendChild(fill);
    li.appendChild(bar);
    li.appendChild(el("span", "det-conf", pct + "%"));

    detList.appendChild(li);
  });
}

// ── Bbox overlay ──
function bboxToPanel(det, panelIdx) {
  const p = PANELS[panelIdx];
  return { x: det.bbox_x - p.x, y: det.bbox_y - p.y, w: det.bbox_w, h: det.bbox_h };
}

function renderBboxes(panelIdx) {
  const slide = document.querySelector('.panel-slide[data-panel="' + panelIdx + '"]');
  if (!slide) return;
  const wrapper = slide.querySelector(".zoom-wrapper");
  let overlay = wrapper.querySelector(".bbox-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "bbox-overlay";
    wrapper.appendChild(overlay);
  }
  overlay.innerHTML = "";
  const canvas = canvases[panelIdx];
  const dets = detsForPanel(panelIdx);
  if (!dets.length || !canvas.width) return;

  // Scale: canvas pixel size → CSS display size
  const displayW = canvas.clientWidth;
  const displayH = canvas.clientHeight;
  const scaleX = displayW / canvas.width;
  const scaleY = displayH / canvas.height;
  // If upscaled (4x), bbox coordinates need 4x multiplier
  const mult = canvas.width > PW ? SCALE : 1;

  dets.forEach(d => {
    const local = bboxToPanel(d, panelIdx);
    const div = document.createElement("div");
    div.className = "bbox";
    div.dataset.detId = d.id;
    div.style.left = (local.x * mult * scaleX) + "px";
    div.style.top = (local.y * mult * scaleY) + "px";
    div.style.width = (local.w * mult * scaleX) + "px";
    div.style.height = (local.h * mult * scaleY) + "px";

    const label = document.createElement("span");
    label.className = "bbox-label";
    label.style.background = CLASS_COLORS[d.yolo_class] || "#94a3b8";
    label.textContent = d.pet_id || d.yolo_class;
    div.appendChild(label);

    div.addEventListener("mouseenter", () => highlightDet(d.id));
    div.addEventListener("mouseleave", () => { if (zoomedDetId !== d.id) highlightDet(zoomedDetId); });
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      zoomToBbox(d.id, panelOf(d));
    });
    overlay.appendChild(div);
  });
}

function renderAllBboxes() {
  for (let i = 0; i < 4; i++) renderBboxes(i);
}

// ── Highlight & zoom linkage ──
let highlightedDetId = null;
let zoomedDetId = null;

function highlightDet(detId) {
  highlightedDetId = detId;
  // Update bbox overlays
  document.querySelectorAll(".bbox").forEach(el => {
    const id = parseInt(el.dataset.detId);
    el.classList.toggle("highlighted", id === detId);
    el.classList.toggle("zoom-target", id === zoomedDetId);
    el.classList.toggle("dimmed", detId !== null && id !== detId);
  });
  // Update detection list items
  document.querySelectorAll(".det-item").forEach(el => {
    const id = parseInt(el.dataset.detId);
    el.classList.toggle("highlighted", id === detId);
  });
}

// Current zoom state
let zoomState = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, displayW: 0, displayH: 0 };

function clampTranslate(tx, ty, zoom, displayW, displayH) {
  return {
    tx: Math.max(displayW * (1 - zoom), Math.min(0, tx)),
    ty: Math.max(displayH * (1 - zoom), Math.min(0, ty)),
  };
}

function applyZoom(wrapper, tx, ty, zoom, animated) {
  wrapper.style.transition = animated ? "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)" : "none";
  wrapper.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + zoom + ")";
}

function zoomToBbox(detId, panelIdx) {
  const slide = document.querySelector('.panel-slide[data-panel="' + panelIdx + '"]');
  if (!slide) return;
  const wrapper = slide.querySelector(".zoom-wrapper");
  const canvas = canvases[panelIdx];

  if (zoomedDetId === detId) {
    // Un-zoom
    zoomedDetId = null;
    zoomState = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, displayW: 0, displayH: 0 };
    applyZoom(wrapper, 0, 0, 1, true);
    // Reset to identity after transition
    wrapper.addEventListener("transitionend", () => { wrapper.style.transform = ""; }, { once: true });
    highlightDet(null);
    return;
  }

  const det = MOCK_DETECTIONS.find(d => d.id === detId);
  if (!det) return;
  const local = bboxToPanel(det, panelIdx);

  const displayW = canvas.clientWidth;
  const displayH = canvas.clientHeight;
  const mult = canvas.width > PW ? SCALE : 1;
  const scaleX = displayW / canvas.width;
  const scaleY = displayH / canvas.height;

  const bboxCx = (local.x + local.w / 2) * mult * scaleX;
  const bboxCy = (local.y + local.h / 2) * mult * scaleY;
  const bboxDW = local.w * mult * scaleX;
  const bboxDH = local.h * mult * scaleY;

  const zoomW = displayW * 0.5 / bboxDW;
  const zoomH = displayH * 0.5 / bboxDH;
  const zoom = Math.min(3.5, Math.max(1.8, Math.min(zoomW, zoomH)));

  let tx = displayW / 2 - bboxCx * zoom;
  let ty = displayH / 2 - bboxCy * zoom;
  const clamped = clampTranslate(tx, ty, zoom, displayW, displayH);
  tx = clamped.tx;
  ty = clamped.ty;

  zoomedDetId = detId;
  zoomState = { tx, ty, zoom, panelIdx, displayW, displayH };
  applyZoom(wrapper, tx, ty, zoom, true);
  highlightDet(detId);
}

function resetZoom() {
  if (zoomedDetId === null) return;
  const slide = document.querySelector('.panel-slide[data-panel="' + zoomState.panelIdx + '"]');
  if (slide) {
    const wrapper = slide.querySelector(".zoom-wrapper");
    wrapper.style.transition = "";
    wrapper.style.transform = "";
  }
  zoomedDetId = null;
  zoomState = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, displayW: 0, displayH: 0 };
  highlightDet(null);
}

// ── Drag-to-pan while zoomed (mouse & touch) ──
let dragState = null; // { startX, startY, startTx, startTy, wrapper }
const RUBBER_BAND = 0.3; // how much past-edge movement is allowed (ratio)
const RUBBER_MAX = 40;   // max rubber band pixels

function rubberBand(offset, limit) {
  // Beyond the limit, apply diminishing returns
  if (offset > 0) {
    return limit > 0 ? 0 : RUBBER_MAX * (1 - Math.exp(-offset / (RUBBER_MAX * 3)));
  }
  if (offset < limit) {
    const over = limit - offset;
    return limit - RUBBER_MAX * (1 - Math.exp(-over / (RUBBER_MAX * 3)));
  }
  return offset;
}

function onDragStart(x, y) {
  if (zoomedDetId === null) return false;
  const slide = document.querySelector('.panel-slide[data-panel="' + zoomState.panelIdx + '"]');
  if (!slide) return false;
  const wrapper = slide.querySelector(".zoom-wrapper");
  dragState = { startX: x, startY: y, startTx: zoomState.tx, startTy: zoomState.ty, wrapper };
  wrapper.style.transition = "none";
  return true;
}

function onDragMove(x, y) {
  if (!dragState) return;
  const dx = x - dragState.startX;
  const dy = y - dragState.startY;
  const rawTx = dragState.startTx + dx;
  const rawTy = dragState.startTy + dy;
  const { zoom, displayW, displayH } = zoomState;
  const minTx = displayW * (1 - zoom);
  const minTy = displayH * (1 - zoom);

  // Apply rubber band beyond edges
  const tx = rubberBand(rawTx, minTx);
  const ty = rubberBand(rawTy, minTy);

  zoomState.tx = rawTx; // store raw for continued drag
  dragState.wrapper.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + zoom + ")";
}

function onDragEnd() {
  if (!dragState) return;
  const { zoom, displayW, displayH } = zoomState;
  // Snap back to clamped position
  const clamped = clampTranslate(zoomState.tx, zoomState.ty, zoom, displayW, displayH);
  zoomState.tx = clamped.tx;
  zoomState.ty = clamped.ty;
  applyZoom(dragState.wrapper, clamped.tx, clamped.ty, zoom, true);
  dragState = null;
}

// Mouse events on carousel
carousel.addEventListener("mousedown", (e) => {
  if (onDragStart(e.clientX, e.clientY)) {
    e.preventDefault();
  }
});
window.addEventListener("mousemove", (e) => {
  if (dragState) { e.preventDefault(); onDragMove(e.clientX, e.clientY); }
});
window.addEventListener("mouseup", () => onDragEnd());

// Touch events on carousel
carousel.addEventListener("touchstart", (e) => {
  if (zoomedDetId !== null && e.touches.length === 1) {
    onDragStart(e.touches[0].clientX, e.touches[0].clientY);
    // Don't preventDefault here — let scroll snap still work when not zoomed
  }
}, { passive: true });
carousel.addEventListener("touchmove", (e) => {
  if (dragState) {
    e.preventDefault(); // prevent scroll while panning zoomed image
    onDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });
carousel.addEventListener("touchend", () => onDragEnd());
carousel.addEventListener("touchcancel", () => onDragEnd());

// ── Detection list click → carousel navigation ──
detList.addEventListener("click", (e) => {
  const item = e.target.closest(".det-item");
  if (!item) return;
  const detId = parseInt(item.dataset.detId);
  const targetPanel = parseInt(item.dataset.panel);
  if (isNaN(targetPanel) || targetPanel < 0) return;

  if (viewMode === "comic") {
    showPanel(targetPanel);
  } else if (targetPanel !== activePanel) {
    resetZoom();
    carousel.scrollTo({ left: targetPanel * carousel.clientWidth, behavior: "smooth" });
  }
  // Zoom to bbox (with delay if scrolling to another panel)
  const delay = (viewMode !== "comic" && targetPanel !== activePanel) ? 400 : 0;
  setTimeout(() => zoomToBbox(detId, targetPanel), delay);
});

// ── Event handlers ──
// Panel region clicks
document.querySelectorAll(".panel-region").forEach(el => {
  el.addEventListener("click", () => showPanel(parseInt(el.dataset.panel)));
});

// Carousel scroll snap
function onPanelChanged(idx) {
  resetZoom();
  activePanel = idx;
  updateDots(idx);
  updateBreadcrumb();
  updateNavBtns();
  renderDetections(idx);
  updateUpscaleBadge(idx);
  updateDownloadLink();
  if (!resultCache[idx + ":general_fast"]) {
    upscalePanel(idx, "general_fast");
  }
}

carousel.addEventListener("scrollend", () => {
  const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
  if (idx !== activePanel) onPanelChanged(idx);
});

// Fallback for browsers without scrollend
let scrollTimer;
carousel.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
    if (idx !== activePanel) onPanelChanged(idx);
  }, 150);
});

// Nav buttons
prevBtn.addEventListener("click", () => {
  if (activePanel > 0) {
    carousel.scrollTo({ left: (activePanel - 1) * carousel.clientWidth, behavior: "smooth" });
  }
});
nextBtn.addEventListener("click", () => {
  if (activePanel < 3) {
    carousel.scrollTo({ left: (activePanel + 1) * carousel.clientWidth, behavior: "smooth" });
  }
});

// Dots
dots.forEach(d => {
  d.addEventListener("click", () => {
    const idx = parseInt(d.dataset.panel);
    carousel.scrollTo({ left: idx * carousel.clientWidth, behavior: "smooth" });
  });
});

// HD button
hdBtn.addEventListener("click", () => {
  if (hdBtn.classList.contains("loading")) return;
  hdBtn.classList.add("loading");
  if (upscaleState[activePanel] === "hd") {
    // Toggle back to fast
    hdBtn.classList.remove("done");
    upscalePanel(activePanel, "general_fast");
  } else {
    // Upgrade to HD
    hdBtn.classList.remove("done");
    upscalePanel(activePanel, "general_plus");
  }
});

// Keyboard nav
document.addEventListener("keydown", (e) => {
  if (viewMode !== "panel") return;
  if (e.key === "ArrowLeft" && activePanel > 0) {
    carousel.scrollTo({ left: (activePanel - 1) * carousel.clientWidth, behavior: "smooth" });
  } else if (e.key === "ArrowRight" && activePanel < 3) {
    carousel.scrollTo({ left: (activePanel + 1) * carousel.clientWidth, behavior: "smooth" });
  } else if (e.key === "Escape") {
    if (zoomedDetId !== null) { resetZoom(); } else { showComic(); }
  }
});

// Photo selector
photoSelect.addEventListener("change", () => {
  loadPhoto(photoSelect.value);
});

async function loadPhoto(filename) {
  if (!filename) return;
  currentFilename = filename;
  upscaleState = {};
  resultCache = {};
  zoomedDetId = null;
  comicImg.src = "/api/photos/" + encodeURIComponent(filename);
  await new Promise((resolve, reject) => {
    comicImg.onload = resolve;
    comicImg.onerror = reject;
  });
  // Update info
  const evt = data.events.find(e => e.source_filename === filename);
  if (evt) {
    document.getElementById("caption").textContent = evt.summary || "No summary";
    document.getElementById("petPill").textContent = evt.pet_id || "unknown";
    document.getElementById("statusPill").textContent = evt.status || "pending";
    document.getElementById("timePill").textContent = evt.observed_at
      ? new Date(evt.observed_at).toLocaleString() : "";
  }
  // Always return to comic view on photo change
  showComic();
  statusBar.textContent = "Loaded";
  statusBar.className = "status-bar ok";
}

// Initial load
loadPhoto(photoSelect.value);
statusBar.textContent = "Ready";
statusBar.className = "status-bar ok";
