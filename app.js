/*
  Dawiyat Maps PDF – ODB Search PWA
  - Simple login (client-side)
  - Supabase Storage listing (public)
  - Pre-indexed search (index.json) with 5s SLA
  - PDF.js canvas rendering with fixed canvas, zoom/pan, wheel & pinch
  - Green circle highlight around matched query
  - Copy current view (with overlay) to clipboard
*/

const cfg = window.APP_CONFIG || {};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Register SW
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

$('#year').textContent = new Date().getFullYear();

// UI refs
const authPanel = $('#authPanel');
const searchPanel = $('#searchPanel');
const loginForm = $('#loginForm');
const loginError = $('#loginError');
const queryInput = $('#queryInput');
const queryError = $('#queryError');
const queryHint = $('#queryHint');
const searchForm = $('#searchForm');
const searchBtn = $('#searchBtn');
const summaryBox = $('#summaryBox');
const summaryContent = $('#summaryContent');
const zoomInBtn = $('#zoomInBtn');
const zoomOutBtn = $('#zoomOutBtn');
const resetBtn = $('#resetBtn');
const copyBtn = $('#copyBtn');
const canvasWrap = $('#canvasWrap');
const pdfCanvas = $('#pdfCanvas');
const overlayCanvas = $('#overlayCanvas');
const loadingEl = $('#loading');

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function notifyError(el, msg) { el.textContent = msg || ''; }
function clearError(el) { el.textContent = ''; }

function setLoading(on) {
  if (on) show(loadingEl); else hide(loadingEl);
}

// Simple Auth
const Auth = {
  isLoggedIn() {
    return !!localStorage.getItem('sessionUser');
  },
  login(username, password) {
    const users = (cfg.auth && cfg.auth.users) || [];
    const ok = users.some(u => u.username === username && u.password === password);
    if (ok) {
      localStorage.setItem('sessionUser', username);
      return true;
    }
    return false;
  },
  logout() {
    localStorage.removeItem('sessionUser');
  }
};

function applyAuthUI() {
  if (Auth.isLoggedIn()) {
    hide(authPanel);
    show(searchPanel);
  } else {
    show(authPanel);
    hide(searchPanel);
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (Auth.login(username, password)) {
    loginError.textContent = '';
    applyAuthUI();
  } else {
    loginError.textContent = 'Invalid credentials. Please try again.';
  }
});

applyAuthUI();

// Supabase Storage helper
class SupabaseStorage {
  constructor({ url, anonKey, bucket }) {
    this.url = (url || '').replace(/\/$/, '');
    this.anonKey = anonKey || '';
    this.bucket = bucket || '';
  }
  async listPDFs() {
    if (!this.url || !this.bucket) return [];
    if (!this.anonKey) {
      // Attempt fallback manifest file in public path
      const manifestUrl = `${this.url}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${cfg.listFile || 'pdfs.json'}`;
      try {
        const res = await fetch(manifestUrl, { cache: 'no-store' });
        if (!res.ok) return [];
        const list = await res.json();
        return list.filter(n => n.toLowerCase().endsWith('.pdf')).map(name => ({ name, url: this.publicUrl(name) }));
      } catch {
        return [];
      }
    }
    const listEndpoint = `${this.url}/storage/v1/object/list/${encodeURIComponent(this.bucket)}`;
    const body = { prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } };
    const res = await fetch(listEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.anonKey}`,
        'Apikey': this.anonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return [];
    }
    const items = await res.json();
    return items.filter(it => it.name && it.name.toLowerCase().endsWith('.pdf')).map(it => ({ name: it.name, url: this.publicUrl(it.name) }));
  }
  publicUrl(path) {
    return `${this.url}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${encodeURI(path)}`;
  }
  async fetchIndex() {
    if (!this.url || !this.bucket) return null;
    const indexPath = cfg.indexFile || 'index.json';
    const url = `${this.url}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${indexPath}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}

// Index Manager
class IndexManager {
  constructor(storage) {
    this.storage = storage;
    this.map = {}; // id -> [ { file, page, rect? } ]
    this.ready = false;
  }
  async init() {
    // Load from local cache first
    try {
      const local = localStorage.getItem('odbIndex');
      if (local) this.map = JSON.parse(local);
    } catch {}
    // Try load from bucket
    const idx = await this.storage.fetchIndex();
    if (idx && typeof idx === 'object') {
      this.map = idx;
      try { localStorage.setItem('odbIndex', JSON.stringify(this.map)); } catch {}
    }
    this.ready = true;
  }
  find(id) {
    return this.map[id] || null;
  }
  add(id, entry) {
    if (!this.map[id]) this.map[id] = [];
    // De-dup simple
    const exists = this.map[id].some(e => e.file === entry.file && e.page === entry.page);
    if (!exists) this.map[id].push(entry);
    try { localStorage.setItem('odbIndex', JSON.stringify(this.map)); } catch {}
  }
}

// PDF Renderer and viewer controls
class PDFViewer {
  constructor({ canvas, overlay, wrap }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d');
    this.octx = overlay.getContext('2d');

    this.pdf = null;
    this.page = null;
    this.pageNumber = 1;

    this.baseScale = 1; // computed to fit
    this.zoom = 1; // extra zoom multiplier
    this.minZoom = 0.2;
    this.maxZoom = 10;

    this.panX = 0; // screen pixel offsets
    this.panY = 0;

    this.target = null; // { page, x, y, w, h } in viewport pixels

    this._setupEvents();
    this._resizeToContainer();
  }

  _resizeToContainer() {
    const rect = this.wrap.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.overlay.width = this.canvas.width;
    this.overlay.height = this.canvas.height;
    // Scale contexts for crisp drawing on HiDPI
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async loadDocument(url) {
    if (!url) return;
    this.resetView();
    this.pdf = await pdfjsLib.getDocument({ url, useSystemFonts: true }).promise;
    this.pageNumber = 1;
  }

  async renderPage(pageNumber = this.pageNumber) {
    if (!this.pdf) return;
    this.pageNumber = pageNumber;
    this.page = await this.pdf.getPage(this.pageNumber);

    // Compute base scale to fit page into canvas (contain)
    const viewportAt1 = this.page.getViewport({ scale: 1 });
    const cw = this.canvas.width; // in css px scaled by dpr transform above
    const ch = this.canvas.height;
    const scaleX = cw / viewportAt1.width;
    const scaleY = ch / viewportAt1.height;
    this.baseScale = Math.min(scaleX, scaleY);

    const viewport = this.page.getViewport({ scale: this.baseScale * this.zoom });

    // Determine target center in viewport pixels
    let targetX = viewport.width / 2;
    let targetY = viewport.height / 2;
    if (this.target && this.target.page === this.pageNumber) {
      const cx = this.target.x + this.target.w / 2;
      const cy = this.target.y + this.target.h / 2;
      targetX = cx * (this.zoom);
      targetY = cy * (this.zoom);
    }

    // Clear canvas
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    // Translate so that target center appears at canvas center (plus pan)
    const dx = this.canvas.width / 2 - targetX + this.panX;
    const dy = this.canvas.height / 2 - targetY + this.panY;

    const renderContext = {
      canvasContext: this.ctx,
      viewport,
      transform: [1, 0, 0, 1, dx, dy]
    };

    await this.page.render(renderContext).promise;

    this._drawOverlay();
  }

  _drawOverlay() {
    // Clear
    this.octx.save();
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.octx.restore();

    if (!this.target || this.target.page !== this.pageNumber) return;

    // Compute on-screen center of target after current transform
    const cx = (this.target.x + this.target.w / 2) * this.zoom + (this.canvas.width / 2 - (this.target ? (this.target.x + this.target.w / 2) * this.zoom : 0)) + this.panX;
    const cy = (this.target.y + this.target.h / 2) * this.zoom + (this.canvas.height / 2 - (this.target ? (this.target.y + this.target.h / 2) * this.zoom : 0)) + this.panY;

    // But above formula duplicates; simpler: use same dx,dy as render
    let targetX = this.canvas.width / 2;
    let targetY = this.canvas.height / 2;
    if (this.target && this.target.page === this.pageNumber) {
      const cxv = (this.target.x + this.target.w / 2) * this.zoom;
      const cyv = (this.target.y + this.target.h / 2) * this.zoom;
      const dx = this.canvas.width / 2 - cxv + this.panX;
      const dy = this.canvas.height / 2 - cyv + this.panY;
      targetX = cxv + dx;
      targetY = cyv + dy;
    }

    const radius = Math.max(this.target.w, this.target.h) * this.zoom * 0.75;
    this.octx.save();
    this.octx.beginPath();
    this.octx.arc(targetX, targetY, Math.max(10, radius), 0, Math.PI * 2);
    this.octx.lineWidth = 4;
    this.octx.strokeStyle = '#22c55e';
    this.octx.shadowColor = 'rgba(34,197,94,0.6)';
    this.octx.shadowBlur = 10;
    this.octx.stroke();
    this.octx.restore();
  }

  focusOn(rect, pageNumber) {
    if (!rect) return;
    this.target = { ...rect, page: pageNumber };
    this.panX = 0; this.panY = 0;
    // Auto-zoom to make it visible
    // Fit the target rect to 30% of canvas width
    const cw = this.canvas.width, ch = this.canvas.height;
    const scaleToWidth = (cw * 0.3) / rect.w;
    const scaleToHeight = (ch * 0.3) / rect.h;
    const factor = Math.min(scaleToWidth, scaleToHeight);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, factor));
  }

  resetView() {
    this.zoom = 1; this.panX = 0; this.panY = 0; this.target = null;
    this._resizeToContainer();
  }

  zoomIn(step = 1.2) { this.zoom = Math.min(this.maxZoom, this.zoom * step); this.renderPage(); }
  zoomOut(step = 1.2) { this.zoom = Math.max(this.minZoom, this.zoom / step); this.renderPage(); }

  async copyCurrentView() {
    // Combine pdfCanvas and overlay into a single image and copy
    const tmp = document.createElement('canvas');
    tmp.width = this.canvas.width;
    tmp.height = this.canvas.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(this.canvas, 0, 0);
    tctx.drawImage(this.overlay, 0, 0);
    if (navigator.clipboard && window.ClipboardItem) {
      const blob = await new Promise(resolve => tmp.toBlob(resolve, 'image/png'));
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      } catch {
        // fallback download
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: 'odb-result.png' });
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        return false;
      }
    } else {
      // fallback download
      const url = tmp.toDataURL('image/png');
      const a = Object.assign(document.createElement('a'), { href: url, download: 'odb-result.png' });
      document.body.appendChild(a); a.click(); a.remove();
      return false;
    }
  }

  _setupEvents() {
    // Resize observer
    const ro = new ResizeObserver(() => {
      this._resizeToContainer();
      this.renderPage().catch(() => {});
    });
    ro.observe(this.wrap);

    // Mouse drag pan
    let dragging = false; let last = { x: 0, y: 0 };
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - last.x; const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this.panX += dx; this.panY += dy;
      this.renderPage();
    });
    window.addEventListener('mouseup', () => dragging = false);

    // Wheel zoom
    this.overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1; // up = zoom in
      const factor = direction > 0 ? 1.15 : 1/1.15;
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
      this.renderPage();
    }, { passive: false });

    // Pinch zoom (touch)
    let touchState = null;
    const getDist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    this.overlay.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        touchState = { dist: getDist(e.touches[0], e.touches[1]), zoom: this.zoom };
      } else if (e.touches.length === 1) {
        touchState = { p: { x: e.touches[0].clientX, y: e.touches[0].clientY } };
      }
    }, { passive: true });
    this.overlay.addEventListener('touchmove', (e) => {
      if (!touchState) return;
      if (e.touches.length === 2 && touchState.dist) {
        const nd = getDist(e.touches[0], e.touches[1]);
        const ratio = nd / touchState.dist;
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, touchState.zoom * ratio));
        this.renderPage();
      } else if (e.touches.length === 1 && touchState.p) {
        const p = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.panX += (p.x - touchState.p.x);
        this.panY += (p.y - touchState.p.y);
        touchState.p = p;
        this.renderPage();
      }
    }, { passive: true });
    this.overlay.addEventListener('touchend', () => { touchState = null; }, { passive: true });
  }
}

// Text search on a page to get bounding box of query
async function findQueryRectOnPage(page, query, viewport) {
  const textContent = await page.getTextContent();
  // Iterate items and look for the query in the string of each item
  // Compute approximate rect using the item's transform
  const q = query.trim();
  for (const item of textContent.items) {
    const str = (item.str || '').toUpperCase();
    const idx = str.indexOf(q);
    if (idx >= 0) {
      // Item transform: [a, b, c, d, e, f]
      const [a, b, c, d, e, f] = item.transform;
      // The width approximation: item.width available in recent versions; fallback to measure by char spacing
      let w = item.width;
      if (typeof w !== 'number') {
        const scale = Math.hypot(a, b); // scale factor approx
        const approxCharW = (item.str.length > 0 ? (Math.abs(d) * 0.6) : 10) * scale;
        w = approxCharW * item.str.length;
      }
      const h = Math.abs(d);
      // Compute per-character width approx
      const perChar = w / Math.max(1, item.str.length);
      const x = e + perChar * idx;
      const y = f - h; // top-left
      const rect = { x, y, w: perChar * q.length, h };
      // Convert to viewport at scale (PDF.js already gives transform in viewport px at scale 1) -> scale by viewport.scale
      const scale = viewport.scale || 1;
      return { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
    }
  }
  return null;
}

// Application Controller
class App {
  constructor() {
    this.storage = new SupabaseStorage(cfg.supabase || {});
    this.index = new IndexManager(this.storage);
    this.viewer = new PDFViewer({ canvas: pdfCanvas, overlay: overlayCanvas, wrap: canvasWrap });

    this.pdfList = [];

    this._bindUI();
    this._bootstrap();
  }

  _bindUI() {
    // Query input validation
    queryInput.addEventListener('input', () => {
      let v = queryInput.value.toUpperCase();
      v = v.replace(/\s+/g, '');
      // Only uppercase letters and digits
      v = v.replace(/[^A-Z0-9]/g, '');
      if (v.length > 0 && v[0] !== 'D') {
        notifyError(queryError, "Query must start with letter 'D'. Example: D0309420201");
        queryInput.value = '';
        return;
      }
      if (v.length > 11) {
        notifyError(queryError, 'Maximum 11 characters allowed for ODB ID.');
        v = v.slice(0, 11);
      } else {
        clearError(queryError);
      }
      queryInput.value = v;
    });

    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.onSearch();
    });

    zoomInBtn.addEventListener('click', () => this.viewer.zoomIn());
    zoomOutBtn.addEventListener('click', () => this.viewer.zoomOut());
    resetBtn.addEventListener('click', () => { this.viewer.resetView(); this.viewer.renderPage(); });
    copyBtn.addEventListener('click', async () => {
      const ok = await this.viewer.copyCurrentView();
      if (!ok) alert('Image downloaded. Clipboard copy may be blocked on this browser.');
    });
  }

  async _bootstrap() {
    setLoading(true);
    await this.index.init();
    // Load PDFs list in background
    this.storage.listPDFs().then(list => { this.pdfList = list; }).catch(() => {});
    setLoading(false);
  }

  async onSearch() {
    const q = queryInput.value.trim().toUpperCase();
    if (!(q.length === 11 && q.startsWith('D'))) {
      notifyError(queryError, "Please enter a valid ODB ID like 'D0309420201' (11 characters).");
      return;
    }
    clearError(queryError);

    const startedAt = performance.now();
    setLoading(true);
    summaryContent.innerHTML = `<p class="muted">Searching for <strong>${q}</strong>…</p>`;

    // Try pre-indexed first
    let hits = this.index.find(q);

    if (hits && hits.length) {
      await this._showHit(q, hits[0]);
      this._updateSummary(q, hits);
      setLoading(false);
      return;
    }

    // Fallback: scan PDFs until found or 5 seconds elapsed
    const deadline = startedAt + 5000; // 5s SLA
    if (!this.pdfList || this.pdfList.length === 0) {
      // Try to fetch list now if not yet
      try { this.pdfList = await this.storage.listPDFs(); } catch {}
    }

    for (const file of this.pdfList) {
      if (performance.now() > deadline) break;
      try {
        const pdf = await pdfjsLib.getDocument({ url: file.url, useSystemFonts: true }).promise;
        const total = pdf.numPages;
        for (let p = 1; p <= total; p++) {
          if (performance.now() > deadline) break;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 1 });
          const rect = await findQueryRectOnPage(page, q, viewport);
          if (rect) {
            const entry = { file: file.name, page: p, rect };
            this.index.add(q, entry);
            await this._showHit(q, entry, file.url, pdf);
            this._updateSummary(q, [entry]);
            setLoading(false);
            return;
          }
        }
      } catch (err) {
        console.warn('Scan error for', file.name, err);
      }
    }

    setLoading(false);
    summaryContent.innerHTML = `<p class="error">No result found within 5 seconds. Ensure a prebuilt index.json is uploaded for instant search.</p>`;
  }

  async _showHit(q, hit, url, existingPdf) {
    // If url not provided, build from storage
    const pdfUrl = url || this.storage.publicUrl(hit.file);
    if (!this.viewer.pdf || !existingPdf) {
      await this.viewer.loadDocument(pdfUrl);
    } else {
      this.viewer.pdf = existingPdf; // reuse
      this.viewer.resetView();
    }

    // Compute accurate rect at the target zoom reference
    try {
      const page = await this.viewer.pdf.getPage(hit.page);
      const viewport = page.getViewport({ scale: 1 });
      let rect = hit.rect;
      if (!rect || typeof rect.x !== 'number') {
        const r = await findQueryRectOnPage(page, q, viewport);
        if (r) rect = r;
      }
      if (!rect) rect = { x: viewport.width/2 - 50, y: viewport.height/2 - 10, w: 100, h: 20 };
      this.viewer.focusOn(rect, hit.page);
      await this.viewer.renderPage(hit.page);
    } catch (e) {
      console.error('Render error', e);
    }
  }

  _updateSummary(q, hits) {
    const h = hits[0];
    const fileDisplay = h.file || 'Unknown.pdf';
    const listHtml = hits.map(e => `<li>${e.file} — page ${e.page}</li>`).join('');
    summaryContent.innerHTML = `
      <p><strong>Query:</strong> ${q}</p>
      <p><strong>Source:</strong> ${fileDisplay}</p>
      <p><strong>Page:</strong> ${h.page}</p>
      <details><summary>All matches</summary><ul>${listHtml}</ul></details>
      <p class="muted">Tip: Drag to pan. Use mouse wheel or pinch to zoom. Use buttons for precise control.</p>
    `;
  }
}

// Start app
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
