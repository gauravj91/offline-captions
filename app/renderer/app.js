// Offline Captions renderer. Talks to the app only through window.captions
// (app/preload.cjs). No Node APIs here.
/* global CaptionPreview */
'use strict';

const api = window.captions;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const FILLERS = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'mm', 'ah']); // same list as src/segment.mjs
const isFiller = (w) => FILLERS.has(w.text.toLowerCase().replace(/[^a-z]/g, ''));
const STYLE_NOTES = { bold: 'All caps, yellow pop', clean: 'Sentence case, pill', punch: 'Word by word', reveal: 'Builds as spoken' };

const state = {
  presets: {}, info: {},
  lang: 'en', otherLang: 'de', quality: 'balanced',
  model: null, downloading: false,
  jobs: [], current: null, running: false,
  style: { style: 'bold', scale: 1, position: null },
  fillers: true, outDir: null, draft: false,
  lines: [], editing: null, lastExport: null,
};
let seq = 0;

// ---------------- helpers ----------------
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');
const fmtTime = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtMB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
function fileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  const enc = parts.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
  return 'file://' + (enc.startsWith('/') ? '' : '/') + enc;
}
const job = (id = state.current) => state.jobs.find((j) => j.id === id);
const langOpts = () => ({ language: state.lang === 'other' ? state.otherLang : state.lang, quality: state.quality });
function currentStyle() {
  const p = state.presets[state.style.style];
  return {
    ...p,
    size: +(p.size * state.style.scale).toFixed(4),
    position: state.style.position ?? p.position,
  };
}
const styleArgs = () => {
  const st = currentStyle();
  return { style: state.style.style, size: st.size, position: st.position };
};

// ---------------- import screen ----------------
function addFiles(paths) {
  const known = new Set(state.jobs.map((j) => j.file));
  for (const file of paths) {
    if (!file || known.has(file) || !/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file)) continue;
    state.jobs.push({ id: ++seq, file, name: baseName(file), status: 'queued', progress: 0, stage: null });
    known.add(file);
  }
  renderQueues();
  updateStart();
  if (state.running === false && $('#screen-review').hidden === false && state.jobs.some((j) => j.status === 'queued')) runQueue();
}

function renderQueues() {
  const statusPill = (j) => {
    const map = {
      queued: ['Waiting', ''], transcribing: [stageLabel(j), 'warn'], ready: [j.stats?.flagged ? `${j.stats.flagged} to check` : 'Ready', j.stats?.flagged ? 'warn' : 'ok'],
      exporting: ['Exporting', 'warn'], done: ['Exported', 'ok'], error: ['Failed', 'err'],
    };
    const [t, c] = map[j.status];
    return `<span class="pill ${c}">${t}</span>`;
  };
  const meta = (j) => {
    if (j.status === 'error') return j.error;
    if (j.project) return `${fmtTime(j.project.duration)} · ${j.project.width}×${j.project.height} · ${j.project.engine}`;
    return dirName(j.file);
  };
  const item = (j, compact) => {
    const busy = j.status === 'transcribing' || j.status === 'exporting';
    const el = document.createElement('div');
    el.className = `qi${compact && j.id === state.current ? ' sel' : ''}`;
    el.dataset.id = j.id;
    el.innerHTML = `<div class="thumb">▶</div>
      <div class="info"><div class="name"></div><div class="meta"></div>${busy ? '<div class="bar"><i></i></div>' : ''}</div>
      <div class="right">${statusPill(j)}${!compact && !state.running && j.status === 'queued' ? '<button class="x" title="Remove">×</button>' : ''}</div>`;
    el.querySelector('.name').textContent = j.name;
    el.querySelector('.meta').textContent = meta(j);
    if (busy) {
      const bar = el.querySelector('.bar');
      if (j.progress == null) bar.classList.add('indet'); else bar.querySelector('i').style.width = `${Math.round(j.progress * 100)}%`;
    }
    el.querySelector('.x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.jobs = state.jobs.filter((x) => x.id !== j.id);
      renderQueues(); updateStart();
    });
    if (compact) el.addEventListener('click', () => { if (j.project) openJob(j.id); });
    return el;
  };
  $('#queue-import').replaceChildren(...state.jobs.map((j) => item(j, false)));
  $('#queue-side').replaceChildren(...state.jobs.map((j) => item(j, true)));
}

function stageLabel(j) {
  return { probe: 'Reading video', audio: 'Extracting audio', transcribe: j.progress ? `Transcribing ${Math.round(j.progress * 100)}%` : 'Loading model', download: 'Downloading model' }[j.stage] || 'Starting';
}

function updateStart() {
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  const btn = $('#btn-start');
  btn.disabled = !queued || state.running || state.downloading;
  const needs = state.model && !state.model.ready;
  btn.textContent = !queued ? 'Transcribe' : needs ? `Download model & transcribe ${queued > 1 ? `${queued} videos` : ''}`.trim()
    : `Transcribe ${queued > 1 ? `${queued} videos` : 'video'}`;
  $('#start-hint').textContent = !state.jobs.length ? 'Add a video to begin.'
    : state.running ? 'Working… you can review finished videos while the rest run.'
    : `${state.jobs.length} video${state.jobs.length > 1 ? 's' : ''} in the queue.`;
}

const LANG_HINT = {
  en: 'English uses NVIDIA Parakeet, our most accurate model.',
  hinglish: 'Roman-script Hinglish ("kya scene hai, bro"). Unsure words are flagged for review.',
  other: 'Uses Whisper. Pick the language spoken in the video.',
};
function qualityHint() {
  if (state.lang === 'en') return 'Parakeet runs the same model at every setting: fast and accurate.';
  if (state.lang === 'hinglish') return state.quality === 'accurate' ? 'Apex: best Hinglish, ~1.2 GB, slower.' : 'Swift: quick and light, ~350 MB.';
  return { fast: 'Whisper base: quickest, ~80 MB.', balanced: 'Whisper small: good balance, ~250 MB.', accurate: 'Whisper large-v3-turbo: best, ~800 MB.' }[state.quality];
}

async function refreshModel() {
  $('#lang-hint').textContent = LANG_HINT[state.lang];
  $('#quality-hint').textContent = qualityHint();
  $('#seg-quality').classList.toggle('disabled', state.lang === 'en');
  $('#sel-other').hidden = state.lang !== 'other';
  try {
    state.model = await api.modelStatus(langOpts());
  } catch (e) { state.model = null; }
  const m = state.model;
  $('#model-name').textContent = m ? m.label : 'Speech model';
  $('#model-sub').textContent = !m ? 'Could not check the model folder.'
    : m.ready ? 'Ready. Transcription runs fully offline.'
    : `One-time download, about ${sizeLabel(m.approxMB)}.${m.managed ? ' Downloaded before the first transcription.' : ''}`;
  const pill = $('#model-pill');
  pill.className = `pill ${m?.ready ? 'ok' : 'warn'}`;
  pill.textContent = m?.ready ? '✓ Downloaded' : m ? sizeLabel(m.approxMB) : '?';
  updateStart();
}

async function ensureModel() {
  if (state.model?.ready) return true;
  state.downloading = true; updateStart();
  $('#dl').hidden = false;
  $('#dl-text').textContent = 'Connecting…';
  const pill = $('#model-pill');
  pill.className = 'pill warn'; pill.textContent = 'Downloading';
  try {
    await api.downloadModels(langOpts());
    await refreshModel();
    $('#dl-text').textContent = 'Download complete. From now on this runs offline.';
    return true;
  } catch (e) {
    $('#dl-text').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    pill.className = 'pill err'; pill.textContent = 'Failed';
    return false;
  } finally {
    state.downloading = false; updateStart();
  }
}

api.onModelProgress((p) => {
  const pct = p.total ? Math.min(1, p.received / p.total) : 0;
  $('#dl-bar').style.width = `${(pct * 100).toFixed(1)}%`;
  $('#dl-text').textContent = p.file ? `${fmtMB(p.received)} of ${fmtMB(p.total)} · ${p.file}` : 'Finishing…';
  $('#dl-pct').textContent = `${Math.round(pct * 100)}%`;
});

async function start() {
  if (!(await ensureModel())) return;
  runQueue();
}

async function runQueue() {
  if (state.running) return;
  state.running = true; updateStart();
  const opts = langOpts();
  for (let j; (j = state.jobs.find((x) => x.status === 'queued'));) {
    j.status = 'transcribing'; j.stage = 'probe'; j.progress = null;
    renderQueues(); updateBusy();
    try {
      const { project, stats } = await api.transcribe(j.id, j.file, opts);
      Object.assign(j, { project, stats, status: 'ready', progress: 1 });
      if (!state.current) openJob(j.id);
    } catch (e) {
      Object.assign(j, { status: 'error', error: cleanErr(e) });
    }
    renderQueues(); updateBusy();
  }
  state.running = false; updateStart(); renderQueues();
  if (!state.current) {
    const failed = state.jobs.find((x) => x.status === 'error');
    if (failed) $('#start-hint').textContent = failed.error;
  }
}
const cleanErr = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

api.onJobProgress((p) => {
  const j = job(p.jobId);
  if (!j) return;
  if (p.stage === 'export') { onExportProgress(j, p.fraction); return; }
  j.stage = p.stage;
  j.progress = p.fraction ?? null;
  renderQueues(); updateBusy();
});

// ---------------- review screen ----------------
const video = $('#video');
const preview = CaptionPreview.attach($('#overlay'));

function showScreen(name) {
  $('#screen-import').hidden = name !== 'import';
  $('#screen-review').hidden = name !== 'review';
  $('#btn-back').hidden = name !== 'review';
  if (name === 'review') fitFrame();
}

function openJob(id) {
  const j = job(id);
  if (!j?.project) return;
  state.current = id;
  state.editing = null;
  showScreen('review');
  video.src = fileUrl(j.project.video);
  const r = j.project.width / j.project.height;
  $('#ratio').textContent = Math.abs(r - 9 / 16) < 0.02 ? '9:16' : Math.abs(r - 1) < 0.02 ? '1:1' : Math.abs(r - 16 / 9) < 0.02 ? '16:9' : `${j.project.width}×${j.project.height}`;
  fitFrame();
  renderWords();
  rebuildLines();
  renderQueues(); updateBusy();
  $('#ex-done').hidden = !(j.output);
  if (j.output) $('#ex-done-text').textContent = `Saved ${baseName(j.output.video)} + .srt`;
}

function updateBusy() {
  const j = job();
  const busy = !j?.project;
  $('#frame-busy').hidden = !busy;
  if (busy && j) $('#frame-busy-text').textContent = stageLabel(j);
  const ready = state.jobs.filter((x) => x.project).length;
  $('#btn-export-all').textContent = `Export all (${ready})`;
  $('#btn-export-all').disabled = ready < 2 || state.exporting;
  $('#btn-export').disabled = !j?.project || state.exporting;
}

// Fit the frame to the stage at the video's own aspect ratio (9:16 aware).
function fitFrame() {
  const j = job();
  const stage = $('#stage');
  const frame = $('#frame');
  const w = j?.project?.width || 9, h = j?.project?.height || 16;
  const cw = stage.clientWidth - 44, ch = stage.clientHeight - 44;
  if (cw <= 0 || ch <= 0) return;
  const s = Math.min(cw / w, ch / h);
  frame.style.width = `${Math.floor(w * s)}px`;
  frame.style.height = `${Math.floor(h * s)}px`;
  preview.render(video.currentTime);
}
new ResizeObserver(fitFrame).observe($('#stage'));

let linesTimer;
function rebuildLines() {
  clearTimeout(linesTimer);
  linesTimer = setTimeout(async () => {
    const j = job();
    if (!j?.project) return;
    state.lines = await api.buildLines(j.project, styleArgs(), state.fillers);
    preview.set(state.lines, currentStyle());
    preview.render(video.currentTime);
  }, 60);
}

function renderWords() {
  const j = job();
  const box = $('#words');
  if (!j?.project) { box.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  j.project.words.forEach((w, i) => {
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
  const j = job();
  const ws = j?.project?.words || [];
  const flagged = ws.filter((w) => w.review).length;
  j.stats = { flagged, total: ws.length };
  $('#flag-count').textContent = flagged;
  $('#btn-next-flag').disabled = !flagged;
  $('#review-note').innerHTML = flagged
    ? `<b>${flagged}</b> of ${ws.length} words are highlighted: the model was unsure. Click a word to hear it and fix it; press Enter to keep it.`
    : `All ${ws.length} words look good. Click any word to jump there or edit it.`;
}

let nowIdx = -1;
function highlightNow(force) {
  const j = job();
  if (!j?.project) return;
  const t = video.currentTime;
  const ws = j.project.words;
  let idx = -1;
  for (let i = 0; i < ws.length; i++) { if (ws[i].start <= t + 0.01) idx = i; else break; }
  if (idx === nowIdx && !force) return;
  $(`#words .tw.now`)?.classList.remove('now');
  nowIdx = idx;
  const el = $(`#words .tw[data-i="${idx}"]`);
  if (el) {
    el.classList.add('now');
    if (!video.paused) el.scrollIntoView({ block: 'nearest' });
  }
}

function seek(t) {
  video.currentTime = Math.max(0, t);
  preview.render(video.currentTime);
  highlightNow(true);
}

function editWord(i) {
  const j = job();
  const w = j.project.words[i];
  const el = $(`#words .tw[data-i="${i}"]`);
  if (!w || !el) return;
  if (state.editing != null) commitEdit(false);
  video.pause();
  seek(w.start);
  state.editing = { i, before: w.text, el };
  el.classList.add('editing');
  el.contentEditable = 'plaintext-only';
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function commitEdit(apply = true) {
  const ed = state.editing;
  if (!ed) return;
  state.editing = null;
  const j = job();
  const after = ed.el.textContent.replace(/\s+/g, ' ').trim();
  ed.el.contentEditable = 'false';
  ed.el.classList.remove('editing');
  if (!apply) { ed.el.textContent = ed.before; return; }
  const ws = j.project.words;
  const w = ws[ed.i];
  let more = 0;
  const changed = after && after !== ed.before;
  if (!after) {
    ws.splice(ed.i, 1); // empty = delete the word
  } else if (changed) {
    Object.assign(w, { text: after, review: false, fixed: true, edited: true });
    // Apply the same fix to identical words in this video (later videos get it from the dictionary).
    const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
    if (key(ed.before) !== key(after)) {
      ws.forEach((x, k) => { if (k !== ed.i && !x.edited && key(x.text) === key(ed.before)) { x.text = after; x.review = false; x.fixed = true; x.edited = true; more++; } });
    }
  } else {
    w.review = false; // confirmed as correct
  }
  renderWords();
  rebuildLines();
  renderQueues();
  if (changed) {
    api.learn(ed.before, after).then((size) => toast(`Learned “${ed.before}” → “${after}”${more ? `, fixed ${more} more here` : ''}. Your dictionary has ${size} entr${size === 1 ? 'y' : 'ies'}.`));
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#learn-toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function nextFlag() {
  const j = job();
  const ws = j?.project?.words || [];
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
  preview.render(video.currentTime);
  $('#time-cur').textContent = fmtTime(video.currentTime);
  if (video.duration) $('#scrub').value = Math.round((video.currentTime / video.duration) * 1000);
  highlightNow();
  if (!video.paused) requestAnimationFrame(tick);
}
video.addEventListener('play', () => { $('#btn-play').textContent = '❚❚'; requestAnimationFrame(tick); });
video.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; tick(); });
video.addEventListener('seeked', tick);
video.addEventListener('loadedmetadata', () => { $('#time-dur').textContent = fmtTime(video.duration); tick(); });
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
  box.replaceChildren(...Object.entries(state.presets).map(([name, st]) => {
    const b = document.createElement('button');
    b.className = `preset${name === state.style.style ? ' on' : ''}`;
    b.innerHTML = '<div class="sw"></div><div class="pn"><b></b><span></span></div>';
    b.querySelector('b').textContent = name;
    b.querySelector('span').textContent = STYLE_NOTES[name] || '';
    CaptionPreview.sample(b.querySelector('.sw'), st);
    b.addEventListener('click', () => { state.style = { style: name, scale: state.style.scale, position: null }; syncStyle(); });
    return b;
  }));
}
function syncStyle() {
  const st = currentStyle();
  $$('.preset').forEach((b) => b.classList.toggle('on', b.querySelector('b').textContent === state.style.style));
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
function onExportProgress(j, f) {
  if (j.id !== state.exportingId) return;
  const pct = Math.round((f || 0) * 100);
  $('#ex-bar').style.width = `${pct}%`;
  $('#ex-pct').textContent = `${pct}%`;
}

async function exportJobs(ids) {
  if (state.exporting) return;
  if (state.editing) commitEdit(true);
  state.exporting = true; updateBusy();
  $('#ex').hidden = false; $('#ex-done').hidden = true;
  let last = null, ok = 0;
  for (const [n, id] of ids.entries()) {
    const j = job(id);
    state.exportingId = id;
    j.status = 'exporting'; renderQueues();
    $('#ex-text').textContent = ids.length > 1 ? `Rendering ${n + 1} of ${ids.length} · ${j.name}` : `Rendering ${j.name}`;
    onExportProgress(j, 0);
    if (state.license?.required && !state.license.licensed) {
      j.status = 'ready'; renderQueues(); $('#ex').hidden = true;
      openLicense('Exporting is part of the paid desktop app. Paste your license key to export this video.');
      break;
    }
    try {
      j.output = await api.exportVideo({ jobId: id, project: j.project, outDir: state.outDir, style: styleArgs(), fillers: state.fillers, draft: state.draft });
      j.status = 'done'; last = j.output; ok++;
    } catch (e) {
      j.status = 'error'; j.error = cleanErr(e);
      $('#ex-text').textContent = j.error;
    }
    renderQueues();
  }
  state.exporting = false; state.exportingId = null; updateBusy();
  if (last) {
    $('#ex').hidden = true;
    state.lastExport = last;
    $('#ex-done').hidden = false;
    $('#ex-done-text').textContent = ok > 1 ? `Saved ${ok} videos + .srt files` : `Saved ${baseName(last.video)} + .srt`;
  }
}
$('#btn-export').addEventListener('click', () => exportJobs([state.current]));
$('#btn-export-all').addEventListener('click', () => exportJobs(state.jobs.filter((j) => j.project).map((j) => j.id)));
$('#btn-open').addEventListener('click', () => { const p = state.lastExport?.video || job()?.output?.video; if (p) api.showInFolder(p); });
$('#btn-out').addEventListener('click', async () => {
  const d = await api.pickFolder();
  if (d) { state.outDir = d; $('#out-dir').textContent = d; $('#out-dir').title = d; }
});
$('#chk-draft').addEventListener('change', (e) => { state.draft = e.target.checked; });

// ---------------- import wiring ----------------
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addFiles(paths);
});
$('#btn-pick').addEventListener('click', async () => addFiles(await api.pickVideos()));
$('#btn-start').addEventListener('click', start);
$('#btn-back').addEventListener('click', () => { video.pause(); showScreen('import'); refreshModel(); });

function segWire(id, key) {
  $$(`${id} button`).forEach((b) => b.addEventListener('click', () => {
    if (state.running || state.downloading) return;
    $$(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    state[key] = b.dataset.v;
    refreshModel();
  }));
}
segWire('#seg-lang', 'lang');
segWire('#seg-quality', 'quality');
$('#sel-other').addEventListener('change', (e) => { state.otherLang = e.target.value; refreshModel(); });

// about
$('#btn-about').addEventListener('click', () => $('#about').showModal());
$$('#about a[data-href]').forEach((a) => a.addEventListener('click', () => api.openLink(a.dataset.href)));

// license
function renderLicense() {
  const l = state.license || {};
  const b = $('#btn-license');
  b.textContent = l.licensed ? 'Licensed' : 'Activate';
  b.classList.toggle('on', !!l.licensed);
  b.hidden = !l.required && !l.licensed;
  $('#lic-off').hidden = !!l.licensed; $('#lic-on').hidden = !l.licensed;
  $('#lic-activate').hidden = !!l.licensed; $('#lic-deactivate').hidden = !l.licensed;
  $('#lic-title').textContent = l.licensed ? 'Offline Captions is activated' : 'Activate Offline Captions';
  $('#lic-email').textContent = l.email || 'you';
}
function openLicense(why) {
  if (why) $('#lic-why').textContent = why;
  $('#lic-err').hidden = true;
  renderLicense();
  $('#license').showModal();
}
$('#btn-license').addEventListener('click', () => openLicense());
$('#lic-buy').addEventListener('click', () => api.openLink(state.license?.buyUrl));
$$('#license a[data-href]').forEach((a) => a.addEventListener('click', () => api.openLink(a.dataset.href)));
$('#lic-activate').addEventListener('click', async () => {
  const btn = $('#lic-activate'); btn.disabled = true; btn.textContent = 'Activating…';
  const r = await api.activateLicense($('#lic-key').value);
  btn.disabled = false; btn.textContent = 'Activate';
  if (!r.ok) { $('#lic-err').textContent = r.error; $('#lic-err').hidden = false; return; }
  state.license = { ...state.license, ...r }; renderLicense();
});
$('#lic-deactivate').addEventListener('click', async () => {
  state.license = { ...state.license, ...(await api.deactivateLicense()) }; renderLicense();
});

// ---------------- boot ----------------
(async () => {
  if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('mac');
  state.presets = await api.presets();
  state.info = await api.info();
  $('#models-dir').textContent = state.info.modelsDir;
  $('#about-models').textContent = state.info.modelsDir;
  $('#about-version').textContent = `v${state.info.version}`;
  state.license = await api.licenseStatus();
  renderLicense();
  api.onLicenseChanged((l) => { state.license = { ...state.license, ...l }; renderLicense(); });
  renderPresets();
  syncStyle();
  renderQueues();
  await refreshModel();
  window.__ui = { state, addFiles, openJob, editWord, commitEdit, nextFlag, seek, exportJobs, start, showScreen, video };
})();
