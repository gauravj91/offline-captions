// Offline Captions, web version (free trial). Everything runs in this tab:
// the video is read from the user's disk into memory, the audio is decoded and
// transcribed in a Web Worker, captions are drawn on a canvas and the MP4 is
// encoded with WebCodecs. Nothing is uploaded.
import { PRESETS, resolveStyle } from '../../src/styles.mjs';
import { segment, removeFillers } from '../../src/segment.mjs';
import { flagForReview } from '../../src/review.mjs';
import { buildSrt } from '../../src/srt.mjs';
import { drawCaption, drawSample } from './draw.js';
import { decodeAudio, toWhisperAudio, exportMp4, outputSize } from './media.js';

const CFG = window.WEB_CONFIG;
const SITE = window.SITE_CONFIG || {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const FILLERS = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'mm', 'ah']); // same list as src/segment.mjs
const isFiller = (w) => FILLERS.has(w.text.toLowerCase().replace(/[^a-z]/g, ''));
const STYLE_NOTES = { bold: 'All caps, yellow pop', clean: 'Sentence case, pill', punch: 'Word by word', reveal: 'Builds as spoken' };

const state = {
  file: null, buf: null, meta: null, lang: 'en', model: CFG.DEFAULT_MODEL,
  device: null, gpu: false, cached: {},
  project: null, lines: [], editing: null, fillers: true,
  style: { style: 'bold', scale: 1, position: null },
  busy: false, exporting: false, timings: {},
};
window.__timings = state.timings; // read by the headless test

// ---------------- helpers ----------------
const fmtTime = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtMB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e7 ? `${Math.round(b / 1e6)} MB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
const realLink = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && !/YOUR-DOMAIN\.example/.test(u) ? u : '');
const upsellUrl = () => realLink(CFG.UPSELL_URL) || realLink(SITE.CHECKOUT_URL) || realLink(SITE.SITE_URL);
const endSec = () => Math.min(state.meta?.duration || 0, CFG.MAX_SECONDS);
const baseName = (n) => n.replace(/\.[^.]+$/, '');

function currentStyle() {
  const p = resolveStyle(state.style.style);
  return { ...p, size: +(p.size * state.style.scale).toFixed(4), position: state.style.position ?? p.position };
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
  $('#desk-why').textContent = reason || 'See the value here, get more on your computer. Same captions, no limits.';
  $('#desktop').showModal();
}
$('#btn-desktop').addEventListener('click', () => showDesktop());

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
  note.hidden = !(long || big);
  if (long || big) {
    const parts = [];
    if (long) parts.push(`This clip is ${fmtTime(meta.duration)}. The web version captions the first ${CFG.MAX_SECONDS} seconds.`);
    if (big) { const o = outputSize(meta.width, meta.height, CFG.MAX_EXPORT_SHORT_SIDE); parts.push(`It will export at ${o.width}×${o.height} (1080p).`); }
    note.innerHTML = `<span></span> <button class="link" id="lim-more">Full length${big ? ' and 4K' : ''} in the desktop app</button>`;
    note.querySelector('span').textContent = parts.join(' ');
    note.querySelector('#lim-more').addEventListener('click', () => showDesktop(long ? `The desktop app captions videos of any length (and whole batches) on your computer. ${CFG.PRICE} once.` : `The desktop app exports in 4K. ${CFG.PRICE} once.`));
  }
  updateStart();
}
function clearFile() {
  if (state.busy) return;
  state.file = null; state.meta = null; state.project = null;
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
  btn.disabled = !state.file || state.busy;
  const cached = state.cached[state.model];
  btn.textContent = !state.file ? 'Transcribe' : cached ? 'Transcribe' : 'Download model & transcribe';
  $('#start-hint').textContent = !state.file ? 'Add a video to begin.' : state.busy ? 'Working in this tab…' : 'Ready. Your video stays on this device.';
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
  try {
    // 1. read + decode audio (in memory, this tab)
    const t0 = performance.now();
    $('#dl').hidden = false;
    $('#dl-text').textContent = 'Reading the audio from your video…'; $('#dl-pct').textContent = '';
    state.ab = await state.file.arrayBuffer();
    state.buf = await decodeAudio(state.ab);
    if (!state.buf) throw new Error('No audio could be read from this video. Is it silent, or in a format this browser cannot decode? Try an MP4 (H.264/AAC).');
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
  } catch (e) {
    console.error(e);
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
  $('#ex-res').textContent = `MP4 ${o.width}×${o.height}${o.scaled ? ' (1080p)' : ''}${state.meta.duration > CFG.MAX_SECONDS + 0.5 ? ` · first ${CFG.MAX_SECONDS} s` : ''}`;
  $('#ex-done').hidden = true; $('#upsell-after').hidden = true;
  $('#words').replaceChildren(); $('#review-note').textContent = '';
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
  $('#btn-next-flag').disabled = !flagged;
  const deeper = flagged && state.model === 'base' && !state.busy && !ws.some((w) => w.edited)
    && flagged / ws.length > CFG.DEEPER_PASS_RATIO;
  $('#review-note').innerHTML = (flagged
    ? `<b>${flagged}</b> of ${ws.length} words are highlighted: unsure words. Click a word to hear it and fix it; press Enter to keep it.`
    : `All ${ws.length} words look good. Click any word to jump there or edit it.`)
    + (deeper ? ' <button class="link" id="btn-deeper">Hard audio? Run a deeper pass</button>' : '');
  if (deeper) $('#btn-deeper').addEventListener('click', () => { state.model = 'small'; refreshModel().then(start); });
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
    b.addEventListener('click', () => { state.style = { style: name, scale: state.style.scale, position: null }; syncStyle(); });
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
}
$('#rng-pos').addEventListener('input', (e) => { state.style.position = +e.target.value; syncStyle(); });
$('#rng-size').addEventListener('input', (e) => { state.style.scale = +e.target.value; syncStyle(); });
$('#btn-reset-style').addEventListener('click', () => { state.style.scale = 1; state.style.position = null; syncStyle(); });

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
  download(srtBlob(), `${baseName(state.file.name)}.captions.srt`);
});

async function exportVideo() {
  if (!state.project || state.exporting) return;
  if (state.editing) commitEdit(true);
  state.exporting = true;
  video.pause();
  $('#btn-export').disabled = true; $('#btn-srt').disabled = true;
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
    const href = download(r.blob, name);
    $('#ex').hidden = true;
    $('#ex-done').hidden = false;
    $('#ex-done-text').textContent = `Saved ${name} · ${r.width}×${r.height} · ${fmtMB(r.blob.size)} · ${(r.ms / 1000).toFixed(1)} s`;
    const again = $('#ex-again'); again.href = href; again.download = name;
    showAfterUpsell();
  } catch (e) {
    console.error(e);
    $('#ex-text').textContent = `Export failed: ${e.message || e}. The SRT still works.`;
    state.timings.exportError = String(e.message || e);
  } finally {
    state.exporting = false;
    $('#btn-export').disabled = false; $('#btn-srt').disabled = false;
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
  $('#lim-sec').textContent = `${CFG.MAX_SECONDS} s`;
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
  await refreshModel();
  window.__ui = { state, setFile, start, exportVideo, editWord, commitEdit, nextFlag, seek, showScreen, video, srt: () => buildSrt(state.lines) };
})();
