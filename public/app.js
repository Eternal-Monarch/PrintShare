(() => {
'use strict';
const $ = s => document.querySelector(s);
const state = { docs: [], base: '', setup: false, maxMB: 100, tunnel: null };
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

/* ---------- tiny helpers ---------- */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
}
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'ic');
  const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name);
  s.append(u); return s;
}
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtDate = iso => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(url, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(url, o);
  let data = {}; try { data = await r.json(); } catch {}
  if (r.status === 401 && !opts.quiet) showAuth(false);
  if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: r.status });
  return data;
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close();
});

/* ---------- login / setup ---------- */
function showAuth(setup) {
  if (typeof setup === 'boolean') state.setup = setup;
  $('#shell').hidden = true; $('#auth').hidden = false;
  $('#authTitle').textContent = state.setup ? 'Create your admin password' : 'Sign in to PrintShare';
  $('#authText').textContent = state.setup ? 'This password protects your dashboard. Use at least 8 characters.' : 'Enter your admin password.';
  $('#authPw2Wrap').hidden = !state.setup; $('#authPw2').required = state.setup;
  $('#authPw').autocomplete = state.setup ? 'new-password' : 'current-password';
  $('#authBtn').textContent = state.setup ? 'Create password' : 'Sign in';
  $('#authErr').textContent = ''; $('#authPw').value = ''; $('#authPw2').value = '';
  $('#authPw').focus();
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#authPw').value;
  if (state.setup && pw !== $('#authPw2').value) { $('#authErr').textContent = 'The two passwords do not match.'; return; }
  try {
    await api(state.setup ? '/api/admin/setup' : '/api/admin/login', { method: 'POST', body: { password: pw }, quiet: true });
    enter();
  } catch (err) { $('#authErr').textContent = err.message; }
});
$('#btnLogout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', quiet: true }); } catch {}
  showAuth(false);
});

/* ---------- status pills ---------- */
function setPill(id, cls, text) {
  const p = $(id); p.className = 'pill ' + cls; p.querySelector('em').textContent = text;
}
async function refreshStatus() {
  try {
    const s = await api('/api/admin/status', { quiet: true });
    state.maxMB = s.maxFileMB;
    setPill('#pillServer', 'ok', 'Running');
    const t = s.tunnel;
    if (t.running && t.reachable) setPill('#pillTunnel', 'ok', 'Connected');
    else if (t.running) setPill('#pillTunnel', 'warn', 'Connecting…');
    else setPill('#pillTunnel', 'bad', 'Not running');
    $('#statCount').textContent = s.count; $('#statSize').textContent = fmtSize(s.storage);
    $('#dropHint').textContent = `PDF only · up to ${s.maxFileMB} MB each · several files at once are fine`;
    const changed = state.base !== (s.baseUrl || '');
    state.base = s.baseUrl || ''; state.tunnel = t;
    const n = $('#baseNotice');
    if (!t.running) { n.hidden = false; n.textContent = 'The Cloudflare Tunnel is not running, so links will not work from other computers yet. Close this and double-click START.bat again (see the README).'; }
    else if (!t.reachable) { n.hidden = false; n.textContent = 'The tunnel is starting. Links will work in a few seconds…'; }
    else n.hidden = true;
    if (changed) renderDocs();
  } catch (err) {
    if (err.status === 401) return;
    setPill('#pillServer', 'bad', 'Offline'); setPill('#pillTunnel', 'bad', 'Unknown');
  }
}

/* ---------- documents ---------- */
const shareUrl = d => (state.base || location.origin) + '/print/' + d.id;
async function loadDocs() {
  const r = await api('/api/admin/docs');
  state.docs = r.documents; renderDocs();
  state.docs.filter(d => !d.pages).forEach(countPages);
}
async function countPages(d) {
  try {
    const pdf = await pdfjsLib.getDocument({ url: `/api/admin/docs/${d.id}/file`, isEvalSupported: false }).promise;
    const r = await api(`/api/admin/docs/${d.id}/pages`, { method: 'POST', body: { pages: pdf.numPages } });
    Object.assign(d, r.document); pdf.destroy(); renderDocs();
  } catch {}
}
function renderDocs(newId) {
  const list = $('#list'); list.replaceChildren();
  if (!state.docs.length) {
    list.append(h('div', { class: 'empty' }, h('strong', { text: 'No documents yet' }), h('p', { text: 'Drop a PDF above to create your first print link.' })));
    return;
  }
  for (const d of state.docs) {
    const url = shareUrl(d);
    const input = h('input', { type: 'text', readonly: '', value: url, 'aria-label': 'Sharing link' });
    input.addEventListener('focus', () => input.select());
    const copy = () => copyText(url, () => toast('Link copied'));
    list.append(h('article', { class: 'card' + (d.id === newId ? ' new' : '') },
      h('div', { class: 'file-ic' }, icon('file')),
      h('div', { class: 'c-info' },
        h('div', { class: 'c-name', title: d.name, text: d.name }),
        h('div', { class: 'c-meta' },
          h('span', { text: fmtSize(d.size) }),
          h('span', { text: d.pages ? `${d.pages} page${d.pages === 1 ? '' : 's'}` : 'counting pages…' }),
          h('span', { text: fmtDate(d.createdAt) }),
          d.protected ? h('span', { class: 'badge' }, icon('lock'), 'Password') : null,
          d.strict ? h('span', { class: 'badge' }, icon('shield'), d.locked ? 'One device · claimed' : 'One device · unclaimed') : null)),
      h('div', { class: 'c-actions' },
        h('button', { class: 'icon-btn', title: 'Preview', onclick: () => openPreview(d) }, icon('eye')),
        h('button', { class: 'icon-btn', title: 'Access rules', onclick: () => openAcc(d) }, icon('shield')),
        h('button', { class: 'icon-btn', title: 'Password', onclick: () => openPw(d) }, icon('lock')),
        h('button', { class: 'icon-btn del', title: 'Delete', onclick: () => openDel(d) }, icon('trash'))),
      h('div', { class: 'c-link' }, input, h('button', { class: 'btn primary', onclick: copy }, icon('copy'), 'Copy link'))));
  }
}
function copyText(text, ok) {
  const fallback = () => {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); ok(); } catch { toast('Select the link and press Ctrl+C', true); }
    t.remove();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
}

/* ---------- upload ---------- */
const drop = $('#drop'), fileInput = $('#fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

let chain = Promise.resolve();
function handleFiles(files) {
  for (const f of files) {
    const bar = h('div'), status = h('span', { class: 'up-status', text: 'Waiting…' });
    const row = h('div', { class: 'up-item' }, h('div', { class: 'up-name', text: f.name }), status, h('div', { class: 'up-bar' }, bar));
    $('#queue').append(row);
    const fail = msg => { status.textContent = msg; status.className = 'up-status err'; };
    if (!/\.pdf$/i.test(f.name) || (f.type && f.type !== 'application/pdf')) { fail('Not a PDF'); continue; }
    if (f.size > state.maxMB * 1048576) { fail(`Over ${state.maxMB} MB`); continue; }
    chain = chain.then(() => uploadOne(f, bar, status, row, fail));
  }
}
function uploadOne(file, bar, status, row, fail) {
  return new Promise(resolve => {
    const fd = new FormData(); fd.append('files', file, file.name);
    const x = new XMLHttpRequest();
    x.open('POST', '/api/admin/upload');
    x.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      bar.style.width = p + '%'; status.textContent = p < 100 ? p + '%' : 'Processing…';
    };
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      if (x.status === 200 && d.documents && d.documents.length) {
        bar.style.width = '100%'; status.textContent = 'Done'; status.className = 'up-status done';
        state.docs.unshift(...d.documents); renderDocs(d.documents[0].id); refreshStatus();
        d.documents.filter(z => !z.pages).forEach(z => countPages(state.docs.find(q => q.id === z.id)));
        setTimeout(() => row.remove(), 2500);
      } else { if (x.status === 401) showAuth(false); fail(d.error || 'Upload failed'); }
      resolve();
    };
    x.onerror = () => { fail('Network error'); resolve(); };
    x.send(fd);
  });
}

/* ---------- preview ---------- */
const pv = { pdf: null, n: 1, token: 0 };
async function openPreview(d) {
  $('#pvTitle').textContent = d.name; $('#pvMsg').textContent = 'Loading…';
  $('#pvCanvas').style.display = 'none'; $('#dlgPreview').showModal();
  try {
    if (pv.pdf) pv.pdf.destroy();
    pv.pdf = await pdfjsLib.getDocument({ url: `/api/admin/docs/${d.id}/file`, isEvalSupported: false }).promise;
    pv.n = 1; await pvRender();
  } catch { $('#pvMsg').textContent = 'Could not open this PDF.'; }
}
async function pvRender() {
  const tok = ++pv.token, page = await pv.pdf.getPage(pv.n);
  const stage = document.querySelector('.pv-stage');
  const w = Math.min(stage.clientWidth - 28, 900);
  const v1 = page.getViewport({ scale: 1 }), scale = w / v1.width, dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr }), c = $('#pvCanvas');
  c.width = vp.width; c.height = vp.height; c.style.width = vp.width / dpr + 'px'; c.style.height = vp.height / dpr + 'px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  if (tok !== pv.token) return;
  c.style.display = 'block'; $('#pvMsg').textContent = '';
  $('#pvPage').textContent = `${pv.n} / ${pv.pdf.numPages}`;
  $('#pvPrev').disabled = pv.n <= 1; $('#pvNext').disabled = pv.n >= pv.pdf.numPages;
}
$('#pvPrev').addEventListener('click', () => { if (pv.n > 1) { pv.n--; pvRender(); } });
$('#pvNext').addEventListener('click', () => { if (pv.pdf && pv.n < pv.pdf.numPages) { pv.n++; pvRender(); } });
$('#dlgPreview').addEventListener('close', () => { if (pv.pdf) { pv.pdf.destroy(); pv.pdf = null; } });

/* ---------- password ---------- */
let pwDoc = null;
function openPw(d) {
  pwDoc = d; $('#pwDoc').textContent = d.name; $('#pwInput').value = ''; $('#pwErr').textContent = '';
  $('#dlgPw').showModal(); $('#pwInput').focus();
}
$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#pwInput').value;
  try {
    const r = await api(`/api/admin/docs/${pwDoc.id}/password`, { method: 'POST', body: { password: v === '' ? null : v } });
    Object.assign(pwDoc, r.document); renderDocs(); $('#dlgPw').close();
    toast(v === '' ? 'Password removed' : 'Password saved');
  } catch (err) { $('#pwErr').textContent = err.message; }
});

/* ---------- access rules ---------- */
let accDoc = null;
function accRefresh() {
  $('#accState').textContent = !$('#accStrict').checked ? 'Anyone with the link can open it (VPN allowed).'
    : accDoc.locked ? `Claimed by ${accDoc.lockIp} on ${fmtDate(accDoc.lockedAt)}. Other networks are refused.` : 'Not opened yet. The first visitor will claim it.';
  $('#accRelease').hidden = !(accDoc.strict && accDoc.locked);
}
function openAcc(d) {
  accDoc = d; $('#accDoc').textContent = d.name; $('#accStrict').checked = !!d.strict; $('#accErr').textContent = '';
  accRefresh(); $('#dlgAcc').showModal();
}
$('#accStrict').addEventListener('change', accRefresh);
$('#accForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api(`/api/admin/docs/${accDoc.id}/access`, { method: 'POST', body: { strict: $('#accStrict').checked } });
    Object.assign(accDoc, r.document); renderDocs(); $('#dlgAcc').close(); toast('Access rules saved');
  } catch (err) { $('#accErr').textContent = err.message; }
});
$('#accRelease').addEventListener('click', async () => {
  try {
    const r = await api(`/api/admin/docs/${accDoc.id}/access`, { method: 'POST', body: { release: true } });
    Object.assign(accDoc, r.document); renderDocs(); accRefresh(); toast('Lock released');
  } catch (err) { $('#accErr').textContent = err.message; }
});

/* ---------- delete ---------- */
let delDoc = null;
function openDel(d) {
  delDoc = d; $('#delText').textContent = `"${d.name}" will be removed from this laptop and its link will stop working.`;
  $('#dlgDel').showModal();
}
$('#delOk').addEventListener('click', async () => {
  try {
    await api(`/api/admin/docs/${delDoc.id}`, { method: 'DELETE' });
    state.docs = state.docs.filter(x => x.id !== delDoc.id); renderDocs(); refreshStatus();
    $('#dlgDel').close(); toast('Deleted');
  } catch (err) { toast(err.message, true); }
});

/* ---------- settings ---------- */
$('#btnSettings').addEventListener('click', async () => {
  $('#setErr').textContent = '';
  try { $('#setUrl').value = (await api('/api/admin/settings')).publicUrl; } catch {}
  $('#dlgSet').showModal();
});
$('#setForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/admin/settings', { method: 'POST', body: { publicUrl: $('#setUrl').value } });
    $('#dlgSet').close(); toast('Saved'); refreshStatus();
  } catch (err) { $('#setErr').textContent = err.message; }
});

/* ---------- start ---------- */
let timer;
async function enter() {
  $('#auth').hidden = true; $('#shell').hidden = false;
  try { await loadDocs(); } catch {}
  refreshStatus(); clearInterval(timer); timer = setInterval(refreshStatus, 8000);
}
(async () => {
  try {
    const s = await api('/api/admin/session', { quiet: true });
    if (s.authed) enter(); else showAuth(s.setupRequired);
  } catch { $('#shell').hidden = false; setPill('#pillServer', 'bad', 'Offline'); setPill('#pillTunnel', 'bad', 'Unknown'); }
})();
})();
