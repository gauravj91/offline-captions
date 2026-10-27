// Offline Captions, web version (free trial). Everything runs in this tab:
// the video is read from the user's disk into memory, the audio is decoded and
// transcribed in a Web Worker, captions are drawn on a canvas and the MP4 is
// encoded with WebCodecs. Nothing is uploaded.
import { PRESETS, resolveStyle } from '../../src/styles.mjs';
import { segment, removeFillers } from '../../src/segment.mjs';
import { flagForReview } from '../../src/review.mjs';
import { buildSrt, buildVtt, buildTxt } from '../../src/srt.mjs';
import { drawCaption, drawSample } from './draw.js';
import { decodeAudio, toWhisperAudio, exportMp4, outputSize } from './media.js';

const CFG = window.WEB_CONFIG;
const SITE = window.SITE_CONFIG || {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const FILLERS = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'mm', 'ah']); // same list as src/segment.mjs
const isFiller = (w) => FILLERS.has(w.text.toLowerCase().replace(/[^a-z]/g, ''));
// Approximate UI areas of each app on a 9:16 video, as fractions of the frame.
// Only used for the preview guide and "Fit to safe zone"; never drawn into exports.
const PLATFORMS = {
  tiktok: { name: 'TikTok', top: 0.10, right: 0.15, bottom: 0.25 },
  reels:  { name: 'Reels',  top: 0.09, right: 0.14, bottom: 0.22 },
  shorts: { name: 'Shorts', top: 0.08, right: 0.15, bottom: 0.20 },
};
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const STYLE_NOTES = { bold: 'All caps, yellow pop', clean: 'Sentence case, pill', punch: 'Word by word', reveal: 'Builds as spoken' };

const state = {
  file: null, buf: null, meta: null, lang: 'en', model: CFG.DEFAULT_MODEL,
  device: null, gpu: false, cached: {},
  project: null, lines: [], editing: null, fillers: true,
  style: { style: 'bold', scale: 1, position: null, insetR: null },
  platform: PLATFORMS[store.get('oc.platform')] ? store.get('oc.platform') : 'tiktok',
  safeOn: store.get('oc.safe') === '1',
  busy: false, exporting: false, timings: {},
};
window.__timings = state.timings; // read by the headless test

// ---------------- helpers ----------------
const fmtTime = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtMB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e7 ? `${Math.round(b / 1e6)} MB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
const realLink = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && !/YOUR-DOMAIN\.example/.test(u) ? u : '');
const track = (n, p) => { try { window.ocTrack?.(n, p); } catch {} };
const bucket = (sec) => (sec <= 15 ? '0-15s' : sec <= 30 ? '15-30s' : sec <= 60 ? '30-60s' : sec <= 180 ? '1-3m' : '3m+');
const upsellUrl = () => realLink(CFG.UPSELL_URL) || realLink(SITE.CHECKOUT_URL) || realLink(SITE.SITE_URL);
const limLabel = (long) => { const s = CFG.MAX_SECONDS; return s >= 60 && s % 60 === 0 ? `${s / 60} ${long ? (s === 60 ? 'minute' : 'minutes') : 'min'}` : `${s} ${long ? 'seconds' : 's'}`; };
const endSec = () => Math.min(state.meta?.duration || 0, CFG.MAX_SECONDS);
const touchFirst = () => matchMedia('(pointer: coarse)').matches;
const baseName = (n) => n.replace(/\.[^.]+$/, '');

function currentStyle() {
  const p = resolveStyle(state.style.style);
  return { ...p, size: +(p.size * state.style.scale).toFixed(4), position: state.style.position ?? p.position, ...(state.style.insetR ? { insetR: state.style.insetR } : {}) };
}

// ---------------- desktop upsell (one dialog, no tricks) ----------------
function setupUpsell() {
  $('#desk-list').replaceChildren(...CFG.DESKTOP_ONLY.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  $('#desk-price').textContent = CFG.PRICE;
  $('#desk-price-note').textContent = CFG.PRICE_NOTE;
  const url = upsellUrl();
  const cta = $('#desk-cta');
  if (url && !SITE.SALES_OPEN && realLink(SITE.SITE_URL)) {
    // Before sales open: send people to the launch list on the main site.
    cta.href = SITE.SITE_URL.replace(/\/$/, '') + '/#checkout';
    cta.textContent = `Get the launch price · ${CFG.PRICE}`;
    $('#desk-price-note').textContent = 'founding price, one-time · launching soon';
  } else if (url) { cta.href = url; cta.textContent = `Get the desktop app · ${CFG.PRICE}`; }
  else { cta.removeAttribute('href'); cta.classList.add('disabled'); cta.textContent = 'Pre-orders open soon'; }
}
function showDesktop(reason) {
  track('desktop_upsell_view', { reason: reason ? (reason.includes('4K') && !reason.includes('length') ? '4k' : 'length') : 'menu' });
  $('#desk-why').textContent = reason || 'See the value here, get more on your computer. Same captions, no limits.';
  $('#desktop').showModal();
}
$('#btn-desktop').addEventListener('click', () => showDesktop());
// Any click on a link to the main site's checkout/waitlist from the app = upsell click.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (a && /offlinecaptions\.com\/?(#|$)/.test(a.href) && !/^https:\/\/app\./.test(a.href)) track('desktop_upsell_click', { from: a.closest('#upsell-after') ? 'after_export' : a.closest('#desktop') ? 'dialog' : 'other' });
}, true);

// ---------------- device / model ----------------
async function detectDevice() {
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      if (a) { state.gpu = true; state.device = 'webgpu'; return; }
    }
  } catch { /* no WebGPU */ }
  state.device = 'wasm';
}
const modelInfo = () => CFG.MODELS[state.model];

async function isCached(id) {
  // transformers.js stores files in the Cache API under "transformers-cache".
  try {
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    return keys.some((r) => r.url.includes(id) && /encoder_model/.test(r.url)) && keys.some((r) => r.url.includes(id) && /decoder_model_merged/.test(r.url));
  } catch { return false; }
}

async function refreshModel() {
  const m = modelInfo();
  const mb = m.mb[state.device] || m.mb.wasm;
  state.cached[state.model] = await isCached(m.id);
  const cached = state.cached[state.model];
  const threads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  $('#model-name').textContent = m.label;
  $('#model-sub').textContent = cached ? 'In this browser\'s cache. Transcription runs on this device.' : `One-time download, about ${sizeLabel(mb)}.`;
  const pill = $('#model-pill');
  pill.className = `pill ${cached ? 'ok' : 'warn'}`;
  pill.textContent = cached ? '✓ Cached' : sizeLabel(mb);
  updateStart();
}

$('#sel-lang').addEventListener('change', (e) => {
  if (e.target.value === 'hinglish') {
    e.target.value = state.lang;
    showDesktop('Hinglish mode (Roman-script captions for Hindi-English speech) needs two speech models working together, so it lives in the desktop app.');
    return;
  }
  state.lang = e.target.value;
  $('#lang-hint').textContent = state.lang === 'en'
    ? 'Whisper, running in this tab. The desktop app uses NVIDIA Parakeet for English: more accurate and faster.'
    : 'Whisper, running in this tab. Pick the language spoken in the video for the best result.';
});

// ---------------- import ----------------
async function setFile(file) {
  if (!file || state.busy) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) return showErr('That does not look like a video file. Try an MP4 or MOV.');
  hideErr();
  state.file = file; state.project = null; state.buf = null;
  const url = URL.createObjectURL(file);
  const v = $('#thumb');
  v.src = url;
  const meta = await new Promise((resolve) => {
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => resolve(null);
  });
  if (meta) v.currentTime = Math.min(0.5, meta.duration / 2);
  state.meta = meta || { duration: 0, width: 0, height: 0, unknown: true };
  state.url = url;
  $('#clip').hidden = false;
  $('#dropzone').hidden = true;
  $('#clip-name').textContent = file.name;
  $('#clip-meta').textContent = meta
    ? `${fmtTime(meta.duration)} · ${meta.width}×${meta.height} · ${fmtMB(file.size)}`
    : `${fmtMB(file.size)} · this browser cannot preview it`;
  const note = $('#limit-note');
  const long = meta && meta.duration > CFG.MAX_SECONDS + 0.5;
  const big = meta && Math.min(meta.width, meta.height) > CFG.MAX_EXPORT_SHORT_SIDE;
  if (!meta) {
    showErr('This browser can\'t open this video, so it can\'t caption it. iPhone videos in "High Efficiency" (HEVC) only play in some browsers: try Safari or Chrome, or set Camera > Formats > Most Compatible and record again. MP4 (H.264) works everywhere.');
    track('video_unreadable', { ext: (file.name.split('.').pop() || '').toLowerCase().slice(0, 5) });
  }
  note.hidden = !(long || big);
  if (long || big) {
    const parts = [];
    if (long) parts.push(`This clip is ${fmtTime(meta.duration)}. The web version captions the first ${limLabel(true)}.`);
    if (big) { const o = outputSize(meta.width, meta.height, CFG.MAX_EXPORT_SHORT_SIDE); parts.push(`It will export at ${o.width}×${o.height} (1080p).`); }
    note.innerHTML = `<span></span> <button class="link" id="lim-more">Full length${big ? ' and 4K' : ''} in the desktop app</button>`;
    note.querySelector('span').textContent = parts.join(' ');
    note.querySelector('#lim-more').addEventListener('click', () => showDesktop(long ? `The desktop app captions videos of any length (and whole batches) on your computer. ${CFG.PRICE} once.` : `The desktop app exports in 4K. ${CFG.PRICE} once.`));
  }
  track('video_selected', { duration: meta ? bucket(meta.duration) : 'unknown', short_side: meta ? Math.min(meta.width, meta.height) : 0, over_limit: !!long, over_1080: !!big, ext: (file.name.split('.').pop() || '').toLowerCase().slice(0, 5) });
  if (long || big) track('limit_hit', { reason: long && big ? 'length_and_4k' : long ? 'length' : '4k' });
  updateStart();
}
// A video dropped on the landing page (offlinecaptions.com) waits in IndexedDB; see handoff.html.
function takeHandoff() {
  history.replaceState(null, '', location.pathname);
  const r = indexedDB.open('oc-handoff', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('f');
  r.onsuccess = () => {
    try {
      const st = r.result.transaction('f', 'readwrite').objectStore('f');
      const g = st.get('pending');
      g.onsuccess = () => {
        const v = g.result;
        st.delete('pending');
        if (v && v.file && Date.now() - v.t < 10 * 60 * 1000) {
          const f = v.file instanceof File ? v.file : new File([v.file], v.name || 'video.mp4', { type: v.file.type });
          track('handoff_used', {});
          setFile(f);
        } else track('handoff_missing', {});
      };
    } catch { track('handoff_missing', {}); }
  };
}
function clearFile() {
  if (state.busy) return;
  state.file = null; state.meta = null; state.project = null;
  hideErr();
  $('#clip').hidden = true; $('#dropzone').hidden = false; $('#limit-note').hidden = true;
  updateStart();
}
$('#clip-x').addEventListener('click', clearFile);
$('#btn-pick').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => setFile(e.target.files[0]));
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length > 1) toastErr('The web version takes one video at a time. Batches are in the desktop app.');
  if (files[0]) setFile(files[0]);
});
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });

function updateStart() {
  const btn = $('#btn-start');
  btn.disabled = !state.file || state.busy || !!state.meta?.unknown;
  const cached = state.cached[state.model];
  btn.textContent = !state.file ? 'Transcribe' : cached ? 'Transcribe' : 'Download model & transcribe';
  $('#start-hint').textContent = !state.file ? 'Add a video to begin.' : state.meta?.unknown ? 'This video can\'t be opened here.' : state.busy ? 'Working in this tab…' : 'Ready. Your video stays on this device.';
}
function showErr(msg) { const e = $('#err'); e.textContent = msg; e.hidden = false; }
function hideErr() { $('#err').hidden = true; }
function toastErr(msg) { showErr(msg); setTimeout(hideErr, 5000); }

// ---------------- transcription ----------------
let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}
function call(msg, onProgress) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data);
      else if (data.type === 'error') reject(Object.assign(new Error(data.message), { during: data.during }));
      else resolve(data);
    };
    w.postMessage(msg, msg.audio ? [msg.audio.buffer] : []);
  });
}

function setBusy(text, frac) {
  $('#frame-busy').hidden = false;
  $('#frame-busy-text').textContent = text;
  const bar = $('#busy-bar').parentElement;
  bar.classList.toggle('indet', frac == null);
  if (frac != null) $('#busy-bar').style.width = `${Math.round(frac * 100)}%`;
}

async function start() {
  if (!state.file || state.busy) return;
  state.busy = true; updateStart(); hideErr();
  const T = state.timings;
  T.clipSeconds = +endSec().toFixed(2);
  track('transcribe_start', { model: state.model, device: state.device, language: state.lang || 'auto', duration: bucket(T.clipSeconds) });
  try {
    // 1. read + decode audio (in memory, this tab)
    const t0 = performance.now();
    $('#dl').hidden = false;
    $('#dl-text').textContent = 'Reading the audio from your video…'; $('#dl-pct').textContent = '';
    state.ab = await state.file.arrayBuffer();
    state.buf = await decodeAudio(state.ab);
    if (!state.buf) throw new Error('No audio could be read from this video. Is it silent, or in a format this browser cannot decode (some iPhone HEVC/.mov clips)? Try an MP4 (H.264/AAC).');
    const audio = await toWhisperAudio(state.buf, endSec() || state.buf.duration);
    T.audioMs = Math.round(performance.now() - t0);

    // 2. model (download once, then cached)
    const m = modelInfo();
    const t1 = performance.now();
    const onDl = (p) => {
      if (p.stage === 'download' && p.total) {
        const f = Math.min(1, p.loaded / p.total);
        $('#dl-bar').style.width = `${(f * 100).toFixed(1)}%`;
        $('#dl-text').textContent = `Downloading ${m.label}: ${fmtMB(p.loaded)} of ${fmtMB(p.total)}`;
        $('#dl-pct').textContent = `${Math.round(f * 100)}%`;
        $('#model-pill').textContent = 'Downloading';
      } else if (p.stage === 'init') {
        $('#dl-text').textContent = 'Loading the model into memory…'; $('#dl-pct').textContent = '';
      }
    };
    $('#dl-text').textContent = state.cached[state.model] ? 'Loading the model from this browser\'s cache…' : 'Connecting to the model download…';
    let ready;
    try {
      ready = await call({ type: 'load', model: m.id, device: state.device }, onDl);
    } catch (e) {
      if (state.device !== 'webgpu') throw e;
      // WebGPU failed on this GPU/driver: fall back to WASM, no user action needed.
      console.warn('WebGPU failed, using WASM', e);
      worker.terminate(); worker = null; state.device = 'wasm';
      ready = await call({ type: 'load', model: m.id, device: 'wasm' }, onDl);
    }
    T.modelLoadMs = Math.round(performance.now() - t1);
    T.device = ready.device; T.threads = ready.threads; T.model = m.id;
    T.modelFromCache = !!state.cached[state.model];
    $('#dl-bar').style.width = '100%';
    await refreshModel();

    // 3. transcribe (switch to the review screen with a busy overlay)
    openReview();
    setBusy('Transcribing on this device… 0%', 0);
    const t2 = performance.now();
    const res = await call({ type: 'transcribe', audio, language: state.lang }, (p) => {
      if (p.stage === 'transcribe') setBusy(`Transcribing on this device… ${Math.round(p.fraction * 100)}%`, p.fraction);
    });
    T.transcribeMs = Math.round(performance.now() - t2);
    T.realtimeFactor = +(T.clipSeconds / (T.transcribeMs / 1000)).toFixed(2);
    const words = flagForReview(res.words.filter((w) => w.start < endSec() + 0.5), CFG.REVIEW_THRESHOLD);
    state.project = { words, duration: endSec(), width: state.meta.width, height: state.meta.height, engine: `whisper-${state.model}` };
    $('#frame-busy').hidden = true;
    $('#dl').hidden = true;
    renderWords(); rebuildLines();
    track('transcribe_complete', { model: state.model, device: T.device, words: words.length, flagged: words.filter((w) => w.review).length, transcribe_ms: T.transcribeMs, model_load_ms: T.modelLoadMs, from_cache: T.modelFromCache, realtime: T.realtimeFactor });
  } catch (e) {
    console.error(e);
    track('transcribe_error', { model: state.model, device: state.device, message: String(e.message || e).slice(0, 90) });
    showScreen('import');
    showErr(String(e.message || e));
    $('#dl').hidden = true;
  } finally {
    state.busy = false; updateStart();
  }
}
$('#btn-start').addEventListener('click', start);

// ---------------- review screen ----------------
const video = $('#video');
const overlay = $('#overlay');

function showScreen(name) {
  $('#screen-import').hidden = name !== 'import';
  $('#screen-review').hidden = name !== 'review';
  $('#btn-new').hidden = name !== 'review';
  document.body.classList.toggle('in-review', name === 'review');
  if (name === 'review') fitFrame();
}
function openReview() {
  showScreen('review');
  video.src = state.url;
  const r = state.meta.width / state.meta.height;
  $('#ratio').textContent = Math.abs(r - 9 / 16) < 0.02 ? '9:16' : Math.abs(r - 1) < 0.02 ? '1:1' : Math.abs(r - 16 / 9) < 0.02 ? '16:9' : `${state.meta.width}×${state.meta.height}`;
  const o = outputSize(state.meta.width, state.meta.height, CFG.MAX_EXPORT_SHORT_SIDE);
  $('#ex-res').textContent = `MP4 ${o.width}×${o.height}${o.scaled ? ' (1080p)' : ''}${state.meta.duration > CFG.MAX_SECONDS + 0.5 ? ` · first ${limLabel(false)}` : ''}`;
  $('#ex-done').hidden = true; $('#upsell-after').hidden = true;
  $('#words').replaceChildren(); $('#review-note').textContent = '';
  state.lastMp4 = null;
  fitFrame();
}
$('#btn-new').addEventListener('click', () => { if (state.busy || state.exporting) return; video.pause(); clearFile(); showScreen('import'); });

function fitFrame() {
  const stage = $('#stage'), frame = $('#frame');
  const w = state.meta?.width || 9, h = state.meta?.height || 16;
  const pad = window.innerWidth < 760 ? 16 : 44;
  const cw = stage.clientWidth - pad, ch = stage.clientHeight - pad;
  if (cw <= 0 || ch <= 0) return;
  const s = Math.min(cw / w, ch / h);
  frame.style.width = `${Math.floor(w * s)}px`;
  frame.style.height = `${Math.floor(h * s)}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width = Math.round(Math.floor(w * s) * dpr);
  overlay.height = Math.round(Math.floor(h * s) * dpr);
  paint();
  renderSafe();
}
new ResizeObserver(fitFrame).observe($('#stage'));

function paint() {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.project) drawCaption(ctx, state.lines, currentStyle(), video.currentTime, overlay.width, overlay.height);
}

function rebuildLines() {
  if (!state.project) return;
  const st = currentStyle();
  const words = state.fillers ? removeFillers(state.project.words) : state.project.words;
  state.lines = segment(words, st.mode === 'single' ? { maxWords: 1 } : undefined);
  paint();
}

function renderWords() {
  const box = $('#words');
  if (!state.project) { box.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  state.project.words.forEach((w, i) => {
    const s = document.createElement('span');
    s.className = 'tw';
    if (w.review) s.classList.add('flag');
    if (w.fixed && w.edited) s.classList.add('fixed');
    if (state.fillers && isFiller(w)) s.classList.add('filler');
    s.dataset.i = i;
    s.textContent = w.text;
    frag.append(s, ' ');
  });
  box.replaceChildren(frag);
  updateReviewNote();
  highlightNow(true);
}

function updateReviewNote() {
  const ws = state.project?.words || [];
  const flagged = ws.filter((w) => w.review).length;
  $('#flag-count').textContent = flagged;
  $('.sheet-title').textContent = flagged ? `Edit words & style · ${flagged} to check` : 'Edit words & style';
  $('#btn-next-flag').disabled = !flagged;
  const deeper = flagged && state.model === 'base' && !state.busy && !ws.some((w) => w.edited)
    && flagged / ws.length > CFG.DEEPER_PASS_RATIO;
  $('#review-note').innerHTML = (flagged
    ? `<b>${flagged}</b> of ${ws.length} words are highlighted: unsure words. ${touchFirst() ? 'Tap' : 'Click'} a word to hear it and fix it; press Enter to keep it.`
    : `All ${ws.length} words look good. ${touchFirst() ? 'Tap' : 'Click'} any word to jump there or edit it.`)
    + (deeper ? ' <button class="link" id="btn-deeper">Hard audio? Run a deeper pass</button>' : '');
  if (deeper) $('#btn-deeper').addEventListener('click', () => { track('deeper_pass_click', {}); state.model = 'small'; refreshModel().then(start); });
}

let nowIdx = -1;
function highlightNow(force) {
  if (!state.project) return;
  const t = video.currentTime;
  const ws = state.project.words;
  let idx = -1;
  for (let i = 0; i < ws.length; i++) { if (ws[i].start <= t + 0.01) idx = i; else break; }
  if (idx === nowIdx && !force) return;
  $('#words .tw.now')?.classList.remove('now');
  nowIdx = idx;
  const el = $(`#words .tw[data-i="${idx}"]`);
  if (el) { el.classList.add('now'); if (!video.paused) el.scrollIntoView({ block: 'nearest' }); }
}

function seek(t) { video.currentTime = Math.max(0, t); paint(); highlightNow(true); }

function editWord(i) {
  const w = state.project.words[i];
  const el = $(`#words .tw[data-i="${i}"]`);
  if (!w || !el) return;
  if (state.editing) commitEdit(false);
  video.pause();
  seek(w.start);
  state.editing = { i, before: w.text, el };
  el.classList.add('editing');
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function commitEdit(apply = true) {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  const after = ed.el.textContent.replace(/\s+/g, ' ').trim();
  ed.el.contentEditable = 'false';
  ed.el.classList.remove('editing');
  if (!apply) { ed.el.textContent = ed.before; return; }
  const ws = state.project.words;
  const w = ws[ed.i];
  let more = 0;
  const changed = after && after !== ed.before;
  if (!after) ws.splice(ed.i, 1); // empty = delete the word
  else if (changed) {
    Object.assign(w, { text: after, review: false, fixed: true, edited: true });
    const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
    if (key(ed.before) !== key(after)) {
      ws.forEach((x, k) => { if (k !== ed.i && !x.edited && key(x.text) === key(ed.before)) { Object.assign(x, { text: after, review: false, fixed: true, edited: true }); more++; } });
    }
  } else w.review = false; // confirmed as correct
  renderWords(); rebuildLines();
  if (changed) toast(`Fixed “${ed.before}” → “${after}”${more ? ` and ${more} more in this video` : ''}. The desktop app remembers fixes for every future video.`);
}

let toastTimer;
function toast(msg) {
  const t = $('#learn-toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function nextFlag() {
  const ws = state.project?.words || [];
  const from = state.editing?.i ?? nowIdx;
  if (state.editing) commitEdit(true);
  for (let k = 1; k <= ws.length; k++) {
    const i = (from + k + ws.length) % ws.length;
    if (ws[i]?.review) { setTimeout(() => editWord(i), 0); return; }
  }
}

$('#words').addEventListener('click', (e) => {
  const el = e.target.closest('.tw');
  if (!el || el.classList.contains('editing')) return;
  editWord(+el.dataset.i);
});
$('#words').addEventListener('keydown', (e) => {
  if (!state.editing) return;
  if (e.key === 'Enter') { e.preventDefault(); commitEdit(true); }
  if (e.key === 'Escape') { e.preventDefault(); commitEdit(false); }
  if (e.key === 'Tab') { e.preventDefault(); nextFlag(); }
});
$('#words').addEventListener('focusout', (e) => { if (state.editing && e.target === state.editing.el) commitEdit(true); });

// transport
function tick() {
  paint();
  $('#time-cur').textContent = fmtTime(video.currentTime);
  if (video.duration) $('#scrub').value = Math.round((video.currentTime / video.duration) * 1000);
  highlightNow();
  if (!video.paused) requestAnimationFrame(tick);
}
video.addEventListener('play', () => { $('#btn-play').textContent = '❚❚'; requestAnimationFrame(tick); });
video.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; tick(); });
video.addEventListener('seeked', tick);
video.addEventListener('loadedmetadata', () => { $('#time-dur').textContent = fmtTime(video.duration); tick(); });
video.addEventListener('timeupdate', () => { if (video.currentTime > CFG.MAX_SECONDS && state.meta?.duration > CFG.MAX_SECONDS + 0.5 && !video.paused) { video.pause(); } });
$('#btn-play').addEventListener('click', () => (video.paused ? video.play() : video.pause()));
$('#scrub').addEventListener('input', (e) => { if (video.duration) seek((e.target.value / 1000) * video.duration); });
document.addEventListener('keydown', (e) => {
  if (state.editing || $('#screen-review').hidden || e.target.matches('input, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.key === 'n' || e.key === 'N') nextFlag();
});
$('#chk-fillers').addEventListener('change', (e) => { state.fillers = e.target.checked; renderWords(); rebuildLines(); });
$('#btn-next-flag').addEventListener('click', nextFlag);

// tabs
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#tab-transcript').hidden = b.dataset.tab !== 'transcript';
  $('#tab-style').hidden = b.dataset.tab !== 'style';
}));

// bottom sheet (phones): the preview stays big, the editor folds away
$('#sheet-head').addEventListener('click', () => {
  const open = !document.body.classList.contains('sheet-open');
  document.body.classList.toggle('sheet-open', open);
  $('#sheet-head').setAttribute('aria-expanded', String(open));
});

// ---------------- platform safe zones ----------------
function safeCheck() {
  const z = PLATFORMS[state.platform], st = currentStyle();
  const middle = st.position >= 0.45 && st.position <= 0.55;
  return { z, low: !middle && st.position < z.bottom - 0.001, side: (st.insetR || 0) < z.right - 0.001 };
}
function renderSafe() {
  const box = $('#safe');
  const z = PLATFORMS[state.platform];
  box.style.setProperty('--t', `${z.top * 100}%`);
  box.style.setProperty('--r', `${z.right * 100}%`);
  box.style.setProperty('--b', `${z.bottom * 100}%`);
  box.hidden = !state.safeOn;
  $('#btn-safe').setAttribute('aria-pressed', String(state.safeOn));
  $('#btn-safe').textContent = state.safeOn ? `${z.name} zones` : 'Safe zones';
  $('#chk-safe').checked = state.safeOn;
  $$('#seg-platform button').forEach((b) => b.classList.toggle('on', b.dataset.p === state.platform));
  const bar = $('#safe-bar');
  bar.hidden = !state.safeOn || !state.project;
  if (bar.hidden) return;
  const c = safeCheck();
  const ok = !c.low && !c.side;
  bar.classList.toggle('ok', ok);
  $('#safe-msg').textContent = c.low ? `Captions sit under ${z.name}'s caption area.`
    : c.side ? `Long lines can run under ${z.name}'s buttons.`
    : `✓ Captions are clear of ${z.name}'s buttons.`;
  $('#btn-fit').hidden = ok;
}
function setSafe(on) { state.safeOn = on; store.set('oc.safe', on ? '1' : '0'); renderSafe(); fitFrame(); }
function fitToSafe() {
  const c = safeCheck(), st = currentStyle();
  if (c.low) state.style.position = Math.min(0.6, +(c.z.bottom + 0.02).toFixed(2));
  else if (state.style.position == null) state.style.position = st.position;
  state.style.insetR = +(c.z.right + 0.01).toFixed(2);
  track('safe_fit', { platform: state.platform, moved: c.low });
  syncStyle();
}
$('#btn-safe').addEventListener('click', () => setSafe(!state.safeOn));
$('#chk-safe').addEventListener('change', (e) => setSafe(e.target.checked));
$('#btn-fit').addEventListener('click', fitToSafe);
$$('#seg-platform button').forEach((b) => b.addEventListener('click', () => {
  state.platform = b.dataset.p; store.set('oc.platform', state.platform);
  track('platform_change', { platform: state.platform });
  if (!state.safeOn) setSafe(true); else renderSafe();
}));

// ---------------- style ----------------
function renderPresets() {
  const box = $('#presets');
  box.replaceChildren(...CFG.STYLES.map((name) => {
    const st = PRESETS[name];
    const b = document.createElement('button');
    b.className = `preset${name === state.style.style ? ' on' : ''}`;
    b.dataset.name = name;
    b.innerHTML = '<div class="sw"><canvas width="380" height="148"></canvas></div><div class="pn"><b></b><span></span></div>';
    b.querySelector('b').textContent = name;
    b.querySelector('span').textContent = STYLE_NOTES[name] || '';
    drawSample(b.querySelector('canvas'), st);
    b.addEventListener('click', () => { track('style_change', { style: name }); state.style = { style: name, scale: state.style.scale, position: null, insetR: state.style.insetR }; syncStyle(); });
    return b;
  }));
}
function syncStyle() {
  const st = currentStyle();
  $$('.preset').forEach((b) => b.classList.toggle('on', b.dataset.name === state.style.style));
  $('#rng-pos').value = st.position;
  $('#rng-size').value = state.style.scale;
  const middle = st.position >= 0.45 && st.position <= 0.55;
  $('#pos-val').textContent = middle ? 'Centred' : `${Math.round(st.position * 100)}% from bottom`;
  $('#size-val').textContent = `${Math.round(state.style.scale * 100)}%`;
  rebuildLines();
  renderSafe();
}
$('#rng-pos').addEventListener('input', (e) => { state.style.position = +e.target.value; syncStyle(); });
$('#rng-size').addEventListener('input', (e) => { state.style.scale = +e.target.value; syncStyle(); });
$('#btn-reset-style').addEventListener('click', () => { state.style.scale = 1; state.style.position = null; state.style.insetR = null; syncStyle(); });

// ---------------- export ----------------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  return a.href;
}
function srtBlob() { return new Blob([buildSrt(state.lines)], { type: 'application/x-subrip' }); }
$('#btn-srt').addEventListener('click', () => {
  if (!state.project) return;
  if (state.editing) commitEdit(true);
  state.lastSrt = buildSrt(state.lines);
  track('srt_download', { lines: state.lines.length, edited_words: state.project.words.filter((w) => w.edited).length });
  download(srtBlob(), `${baseName(state.file.name)}.captions.srt`);
});

for (const [id, fmt, build, mime] of [['#btn-vtt', 'vtt', buildVtt, 'text/vtt'], ['#btn-txt', 'txt', buildTxt, 'text/plain']]) {
  $(id).addEventListener('click', () => {
    if (!state.project) return;
    if (state.editing) commitEdit(true);
    track('srt_download', { format: fmt, lines: state.lines.length, edited_words: state.project.words.filter((w) => w.edited).length });
    download(new Blob([build(state.lines)], { type: mime }), `${baseName(state.file.name)}.captions.${fmt}`);
  });
}

// Spoken text as one paragraph (fillers dropped when the toggle is on), for the post caption.
function spokenText() { return state.lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim(); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older browsers / no permission */ }
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
$('#btn-copy').addEventListener('click', async () => {
  if (!state.project) return;
  if (state.editing) commitEdit(true);
  const ok = await copyText(spokenText());
  track('copy_text', { ok, words: state.lines.reduce((n, l) => n + l.words.length, 0) });
  const b = $('#btn-copy');
  b.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => { b.textContent = 'Copy text'; }, 1800);
});
const mp4File = () => (state.lastMp4 ? new File([state.lastMp4], `${baseName(state.file.name)}.captioned.mp4`, { type: 'video/mp4' }) : null);
function canShareFile(f) { try { return !!(f && navigator.canShare && navigator.share && navigator.canShare({ files: [f] })); } catch { return false; } }
$('#btn-share').addEventListener('click', async () => {
  const f = mp4File();
  if (!f) return;
  try {
    await navigator.share({ files: [f], title: 'Captioned video' });
    track('share_complete', {});
  } catch (e) {
    if (e?.name === 'AbortError') return; // user closed the share sheet
    track('share_error', { message: String(e?.message || e).slice(0, 90) });
    download(state.lastMp4, f.name); // fallback: normal download
  }
});

async function exportVideo() {
  if (!state.project || state.exporting) return;
  if (state.editing) commitEdit(true);
  state.exporting = true;
  video.pause();
  track('export_start', { style: state.style.style, scale: state.style.scale, moved: !!state.style.position, edited_words: state.project.words.filter((w) => w.edited).length });
  ['#btn-export', '#btn-srt', '#btn-vtt', '#btn-txt', '#btn-copy'].forEach((id) => { $(id).disabled = true; });
  $('#ex').hidden = false; $('#ex-done').hidden = true; $('#upsell-after').hidden = true;
  $('#ex-text').textContent = 'Rendering in this tab…';
  const onProgress = (f) => { const p = Math.round(f * 100); $('#ex-bar').style.width = `${p}%`; $('#ex-pct').textContent = `${p}%`; };
  onProgress(0);
  try {
    await Promise.all([document.fonts.load('40px "Anton"'), document.fonts.load('40px "Montserrat Thin ExtraBold"')]);
    const r = await exportMp4({
      file: state.file, arrayBuffer: state.ab, audioBuffer: state.buf, lines: state.lines, style: currentStyle(),
      endSec: endSec(), maxShort: CFG.MAX_EXPORT_SHORT_SIDE, onProgress,
    });
    Object.assign(state.timings, { exportMs: r.ms, exportFrames: r.frames, exportCodec: r.codec, exportAudio: r.audio, exportSize: `${r.width}x${r.height}`, exportPath: r.path, exportBytes: r.blob.size });
    state.lastMp4 = r.blob;
    const name = `${baseName(state.file.name)}.captioned.mp4`;
    // Phones that can share files: no surprise download, a Save / Share button instead
    // (share sheet -> Save Video to the gallery, or straight to TikTok/Instagram/YouTube).
    const share = canShareFile(mp4File());
    const quiet = share && touchFirst();
    const href = quiet ? URL.createObjectURL(r.blob) : download(r.blob, name);
    $('#ex').hidden = true;
    $('#ex-done').hidden = false;
    $('#ex-done-text').textContent = `${quiet ? 'Ready' : 'Saved'}: ${name} · ${r.width}×${r.height} · ${fmtMB(r.blob.size)} · ${(r.ms / 1000).toFixed(1)} s`;
    $('#btn-share').hidden = !share;
    const again = $('#ex-again'); again.href = href; again.download = name;
    again.textContent = quiet ? 'Download' : 'Download again';
    track('export_complete', { style: state.style.style, size: `${r.width}x${r.height}`, export_ms: r.ms, codec: r.codec, mb: +(r.blob.size / 1e6).toFixed(1) });
    showAfterUpsell();
  } catch (e) {
    console.error(e);
    track('export_error', { message: String(e.message || e).slice(0, 90) });
    const msg = String(e.message || e);
    $('#ex-text').textContent = /decod|codec|hevc|hvc1|hev1|not supported/i.test(msg) && !/encode/i.test(msg)
      ? `Export failed: this browser can't decode this video's format (often iPhone HEVC). SRT, VTT, TXT and Copy text still work. ${msg}`
      : `Export failed: ${msg}. The SRT still works.`;
    state.timings.exportError = String(e.message || e);
  } finally {
    state.exporting = false;
    ['#btn-export', '#btn-srt', '#btn-vtt', '#btn-txt', '#btn-copy'].forEach((id) => { $(id).disabled = false; });
  }
}
$('#btn-export').addEventListener('click', exportVideo);

function showAfterUpsell() {
  const box = $('#upsell-after');
  const url = upsellUrl();
  box.innerHTML = `<div class="up-t">Captioning more than one short clip?</div>
    <div class="up-s">The desktop app does long videos, batches, 4K, more accurate English (Parakeet), Hinglish, and remembers your fixes. <b></b> <span class="muted"></span></div>
    <div class="up-a"><button class="btn sm ghost" data-more>What's in it</button>${url ? '<a class="btn sm primary" target="_blank" rel="noopener">Get the desktop app</a>' : ''}<button class="x" title="Dismiss" data-x>×</button></div>`;
  box.querySelector('b').textContent = CFG.PRICE;
  box.querySelector('.muted').textContent = CFG.PRICE_NOTE;
  if (url) box.querySelector('a').href = url;
  box.querySelector('[data-more]').addEventListener('click', () => showDesktop());
  box.querySelector('[data-x]').addEventListener('click', () => { box.hidden = true; });
  box.hidden = false;
}

// ---------------- boot ----------------
(async () => {
  setupUpsell();
  $('#lim-sec').textContent = limLabel(true);
  const unsupported = [];
  if (!('VideoEncoder' in window)) unsupported.push('video export (WebCodecs)');
  if (!window.Worker || !window.WebAssembly) unsupported.push('transcription');
  if (unsupported.length) showErr(`This browser is missing ${unsupported.join(' and ')}. Use a recent Chrome, Edge or Safari for the full experience.`);
  await detectDevice();
  // Pick the pack for the user: the accurate one when the GPU can run it fast, else the quick one.
  state.model = state.device === 'webgpu' ? 'small' : 'base';
  await Promise.all([document.fonts.load('40px "Anton"'), document.fonts.load('40px "Montserrat Thin ExtraBold"')]).catch(() => {});
  renderPresets();
  syncStyle();
  renderSafe();
  await refreshModel();
  if (new URLSearchParams(location.search).has('handoff')) takeHandoff();
  window.__ui = {
    state, setFile, start, exportVideo, editWord, commitEdit, nextFlag, seek, showScreen, video, srt: () => buildSrt(state.lines),
    fitToSafe, setSafe, spokenText,
    // Test hook (screenshots): open the review screen with a ready-made transcript, skipping the model.
    loadProject: async (words) => {
      state.ab = await state.file.arrayBuffer();
      state.buf = await decodeAudio(state.ab);
      openReview();
      state.project = { words: flagForReview(words, CFG.REVIEW_THRESHOLD), duration: endSec(), width: state.meta.width, height: state.meta.height, engine: 'test' };
      renderWords(); rebuildLines(); renderSafe();
    },
  };
})();
