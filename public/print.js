(() => {
'use strict';
const $ = s => document.querySelector(s);
const id = location.pathname.split('/').filter(Boolean).pop() || '';
const S = { pdf: null, bytes: null, total: 0, page: 1, mode: 'width', zoom: 1.333, token: 0, task: null, name: '' };
const CSS_PER_PT = 96 / 72; // 100% zoom
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
const RASTER_DPI = 300, RASTER_MAX_PIXELS = 36e6;

/* ---------- screens ---------- */
function showMsg(title, text) {
  $('#app').hidden = true; $('#gate').hidden = true; $('#msg').hidden = false;
  $('#msgTitle').textContent = title; $('#msgText').textContent = text;
}
function busy(text, pct) {
  $('#busy').hidden = false; $('#busyText').textContent = text; $('#busyBar').style.width = (pct || 0) + '%';
}
const unbusy = () => { $('#busy').hidden = true; };

/* ---------- start ---------- */
async function boot() {
  if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return showMsg('Link not valid', 'Please ask the sender for a new link.');
  let r;
  try { r = await fetch(`/api/public/${id}/info`, { cache: 'no-store', credentials: 'same-origin' }); }
  catch { return showMsg('Cannot reach the server', 'The sender\'s computer may be switched off or offline. Please try again later.'); }
  if (r.status === 404) return showMsg('Document not found', 'This link is wrong or the document was removed. Please ask the sender for a new link.');
  if (r.status === 403) { const e = await r.json().catch(() => ({})); return showMsg('Access not allowed', e.error || 'This link cannot be opened from here.'); }
  if (r.status === 429) return showMsg('Too many attempts', 'Please wait a few minutes and try again.');
  if (!r.ok) return showMsg('Something went wrong', 'Please try again in a moment.');
  const info = await r.json();
  if (info.locked) { $('#gate').hidden = false; $('#gatePw').focus(); return; }
  load(info);
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#gateErr').textContent = '';
  try {
    const r = await fetch(`/api/public/${id}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password: $('#gatePw').value }) });
    if (r.status === 429) { $('#gateErr').textContent = 'Too many attempts. Please wait a few minutes.'; return; }
    if (!r.ok) { $('#gateErr').textContent = 'Incorrect password.'; return; }
    $('#gate').hidden = true; boot();
  } catch { $('#gateErr').textContent = 'Cannot reach the server.'; }
});

async function load(info) {
  busy('Opening document…', 15);
  try {
    const r = await fetch(`/api/public/${id}/file`, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 403) { const e = await r.json().catch(() => ({})); unbusy(); return showMsg('Access not allowed', e.error || 'This link cannot be opened from here.'); }
    if (!r.ok) throw new Error('file');
    S.bytes = await r.arrayBuffer();
    S.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(S.bytes.slice(0)), isEvalSupported: false }).promise;
  } catch {
    unbusy(); return showMsg('Could not open the document', 'Please reload the page or ask the sender for a new link.');
  }
  S.total = S.pdf.numPages; S.name = info.name || 'Document';
  document.title = 'Print – ' + S.name;
  $('#docName').textContent = S.name;
  $('#pageTotal').textContent = S.total;
  const first = await S.pdf.getPage(1), v = first.getViewport({ scale: 1 });
  $('#docMeta').textContent = `${S.total} page${S.total === 1 ? '' : 's'} · ${paperName(v.width, v.height)}`;
  unbusy(); $('#app').hidden = false; document.body.classList.add('has-doc');
  render();
}

function paperName(wPt, hPt) {
  const w = wPt * 25.4 / 72, h = hPt * 25.4 / 72, [a, b] = w < h ? [w, h] : [h, w];
  const sizes = { A5: [148, 210], A4: [210, 297], A3: [297, 420], A2: [420, 594], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8] };
  for (const [n, [x, y]] of Object.entries(sizes)) if (Math.abs(a - x) < 2.5 && Math.abs(b - y) < 2.5) return `${n} ${w <= h ? 'portrait' : 'landscape'}`;
  return `${Math.round(w)} × ${Math.round(h)} mm`;
}

/* ---------- viewer ---------- */
function scaleFor(page) {
  const v = page.getViewport({ scale: 1 }), st = $('#stage');
  const availW = st.clientWidth - 36, availH = st.clientHeight - 36;
  if (S.mode === 'width') return Math.max(.2, availW / v.width);
  if (S.mode === 'page') return Math.max(.2, Math.min(availW / v.width, availH / v.height));
  return S.zoom;
}
async function render() {
  if (!S.pdf) return;
  const tok = ++S.token;
  if (S.task) { try { S.task.cancel(); } catch {} }
  const page = await S.pdf.getPage(S.page);
  if (tok !== S.token) return;
  const scale = scaleFor(page); S.zoom = scale;
  let dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const v1 = page.getViewport({ scale });
  while (v1.width * v1.height * dpr * dpr > 16e6 && dpr > 1) dpr -= .25;
  const vp = page.getViewport({ scale: scale * dpr }), c = $('#canvas');
  const off = document.createElement('canvas'); off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
  S.task = page.render({ canvasContext: off.getContext('2d'), viewport: vp });
  try { await S.task.promise; } catch { return; }
  if (tok !== S.token) return;
  c.width = off.width; c.height = off.height;
  c.style.width = vp.width / dpr + 'px'; c.style.height = vp.height / dpr + 'px';
  c.getContext('2d').drawImage(off, 0, 0);
  $('#pageNum').value = S.page; $('#zoomLabel').textContent = Math.round(scale / CSS_PER_PT * 100) + '%';
  $('#prev').disabled = S.page <= 1; $('#next').disabled = S.page >= S.total;
}
function go(n) {
  n = Math.min(S.total, Math.max(1, Math.round(n) || 1));
  if (n === S.page) { $('#pageNum').value = S.page; return; }
  S.page = n; $('#stage').scrollTo(0, 0); render();
}
function zoomBy(f) { S.mode = 'custom'; S.zoom = Math.min(CSS_PER_PT * 4, Math.max(CSS_PER_PT * .25, S.zoom * f)); render(); }
$('#prev').onclick = () => go(S.page - 1);
$('#next').onclick = () => go(S.page + 1);
$('#pageNum').addEventListener('change', e => go(parseInt(e.target.value, 10)));
$('#pageNum').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#zoomIn').onclick = () => zoomBy(1.2);
$('#zoomOut').onclick = () => zoomBy(1 / 1.2);
$('#fitWidth').onclick = () => { S.mode = 'width'; render(); };
$('#fitPage').onclick = () => { S.mode = 'page'; render(); };
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.mode !== 'custom') render(); }, 150); });

/* ---------- printing ---------- */
function chooseMode() {
  const sel = $('#printMode').value;
  if (sel !== 'auto') return sel;
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return mobile || safari ? 'raster' : 'native';
}
let printing = false;
async function doPrint() {
  if (!S.pdf || printing) return;
  printing = true;
  try {
    if (chooseMode() === 'native') await printNative(); else await printRaster();
  } catch (e) {
    unbusy();
    alert('Printing did not start. Please choose "High-resolution images" under Print method and try again.');
  } finally { printing = false; }
}
$('#printBtn').addEventListener('click', doPrint);

/* Method 1: the browser's own PDF engine prints the ORIGINAL PDF (vector text, real page sizes). */
function printNative() {
  return new Promise((resolve, reject) => {
    busy('Opening print dialog…', 60);
    const url = URL.createObjectURL(new Blob([S.bytes], { type: 'application/pdf' }));
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.title = 'print';
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none';
    const cleanup = () => { setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 120000); };
    f.onload = () => setTimeout(() => {
      try { f.contentWindow.focus(); f.contentWindow.print(); unbusy(); cleanup(); resolve(); }
      catch (e) { unbusy(); f.remove(); URL.revokeObjectURL(url); printRaster().then(resolve, reject); }
    }, 900);
    f.src = url;
    document.body.appendChild(f);
  });
}

/* Method 2: render every page with PDF.js at 300 DPI and print exact-size pages (all browsers). */
async function printRaster() {
  const root = $('#printRoot'); root.replaceChildren();
  const urls = [], sizes = new Map();
  try {
    for (let n = 1; n <= S.total; n++) {
      busy(`Preparing page ${n} of ${S.total}…`, Math.round((n - 1) / S.total * 100));
      const page = await S.pdf.getPage(n), v1 = page.getViewport({ scale: 1 });
      const wmm = +(v1.width * 25.4 / 72).toFixed(2), hmm = +(v1.height * 25.4 / 72).toFixed(2);
      const key = `p${Math.round(wmm * 100)}_${Math.round(hmm * 100)}`; sizes.set(key, [wmm, hmm]);
      let scale = RASTER_DPI / 72;
      if (v1.width * v1.height * scale * scale > RASTER_MAX_PIXELS) scale = Math.sqrt(RASTER_MAX_PIXELS / (v1.width * v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      c.width = c.height = 0; page.cleanup();
      if (!blob) throw new Error('render');
      const u = URL.createObjectURL(blob); urls.push(u);
      const img = new Image(); img.alt = ''; img.src = u;
      const box = document.createElement('div'); box.className = 'pp ' + key; box.append(img); root.append(box);
    }
    $('#pageStyles').textContent = [...sizes].map(([k, [w, h]]) => `@page ${k}{size:${w}mm ${h}mm;margin:0}.${k}{page:${k};width:${w}mm;height:${h}mm}`).join('\n');
    await Promise.all([...root.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
  } catch (e) { urls.forEach(URL.revokeObjectURL); root.replaceChildren(); throw e; }
  unbusy();
  const done = () => {
    document.body.classList.remove('printing-raster'); root.replaceChildren();
    $('#pageStyles').textContent = ''; urls.forEach(u => URL.revokeObjectURL(u));
  };
  window.addEventListener('afterprint', done, { once: true });
  document.body.classList.add('printing-raster');
  await new Promise(r => setTimeout(r, 100));
  window.print();
}

/* ---------- basic deterrents (cannot truly prevent saving - see README) ---------- */
document.addEventListener('contextmenu', e => { if (!/INPUT|SELECT/.test(e.target.tagName)) e.preventDefault(); });
document.addEventListener('dragstart', e => e.preventDefault());
document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, typing = /INPUT|SELECT/.test(document.activeElement.tagName);
  if (ctrl && k === 'p') { e.preventDefault(); doPrint(); return; }
  if (ctrl && (k === 's' || k === 'u')) { e.preventDefault(); return; }
  if (typing) return;
  if (k === 'arrowright' || k === 'pagedown') { go(S.page + 1); }
  else if (k === 'arrowleft' || k === 'pageup') { go(S.page - 1); }
  else if (k === '+' || k === '=') zoomBy(1.2);
  else if (k === '-') zoomBy(1 / 1.2);
});

/* ---------- screenshot deterrents (cannot stop Win+Shift+S, phone cameras, etc. - see README) ---------- */
const shield = on => { if (S.pdf) document.body.classList.toggle('shielded', on); };
window.addEventListener('blur', () => { if (!printing) shield(true); });
window.addEventListener('focus', () => shield(false));
document.addEventListener('visibilitychange', () => shield(document.hidden));
$('#shield').addEventListener('click', () => { shield(false); window.focus(); });
document.addEventListener('keydown', e => {
  if (e.key === 'PrintScreen') { shield(true); try { navigator.clipboard.writeText(' '); } catch {} setTimeout(() => shield(false), 1500); }
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 's') shield(true);
}, true);
document.addEventListener('keyup', e => { if (e.key === 'PrintScreen') { try { navigator.clipboard.writeText(' '); } catch {} } });

boot();
})();
