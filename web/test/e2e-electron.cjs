// Headless end-to-end test of the web app, driven inside Electron's Chromium
// (Playwright's Linux/arm64 Chromium has no H.264/AAC, so it cannot read MP4s).
//   node serve.mjs &   (port 8787)
//   electron --no-sandbox --ozone-platform=headless test/e2e-electron.cjs
// Env: URL (default http://localhost:8787/), VIDEO (default ../samples/test.mp4),
//      OUT (results dir), SHOTS (screenshot dir), MODEL (base|small)
// The test forces the WASM backend (WebGPU is not available headless here).
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const URL_ = process.env.URL || 'http://localhost:8787/';
const VIDEO = path.resolve(process.env.VIDEO || path.join(__dirname, '../../samples/test.mp4'));
const OUT = path.resolve(process.env.OUT || '/workspace/work/web-test');
const SHOTS = path.resolve(process.env.SHOTS || '/workspace/work/web-shots');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sandbox reaches the internet through an HTTP proxy given in the env;
// Chromium inside Electron does not read it on its own.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
let proxyAuth = null;
if (PROXY) {
  const u = new URL(PROXY);
  app.commandLine.appendSwitch('proxy-server', `${u.protocol}//${u.host}`);
  app.commandLine.appendSwitch('proxy-bypass-list', 'localhost;127.0.0.1');
  if (u.username) proxyAuth = [decodeURIComponent(u.username), decodeURIComponent(u.password)];
  app.commandLine.appendSwitch('ignore-certificate-errors'); // test harness only: the proxy may re-sign TLS
}
app.on('login', (e, _wc, _details, authInfo, cb) => { if (authInfo.isProxy && proxyAuth) { e.preventDefault(); cb(...proxyAuth); } });

app.whenReady().then(async () => {
  const results = { video: VIDEO, url: URL_, steps: [] };
  const step = (name, data) => { results.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };
  const downloads = [];
  session.defaultSession.on('will-download', (_e, item) => {
    const p = path.join(OUT, item.getFilename());
    item.setSavePath(p);
    item.once('done', (_ev, st) => downloads.push({ file: p, state: st }));
  });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ level, message: msg }) => { if (level === 'error' || level === 'warning' || /error|warn/i.test(msg)) log('console:', msg.slice(0, 300)); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => { await sleep(400); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS, name), img.toPNG()); log('shot', name); };
  const waitFor = async (code, ms = 600000, every = 500) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${code}`);
      await sleep(every);
    }
  };
  try {
    await win.loadURL(URL_);
    await waitFor('!!window.__ui');
    // Force WASM for the test (headless has no WebGPU adapter anyway).
    await js(`window.__ui.state.device = 'wasm'; window.__ui.state.model = '${process.env.MODEL || 'base'}'; true`);
    step('loaded', await js(`({ coi: crossOriginIsolated, cores: navigator.hardwareConcurrency, gpu: window.__ui.state.gpu, cached: !!window.__ui.state.cached.base })`));
    await shot('desktop-1-import.png');

    // Pick the file through the real <input type=file> (CDP), as a user would.
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [VIDEO] });
    await waitFor(`!document.querySelector('#clip').hidden && !document.querySelector('#btn-start').disabled`, 20000);
    await shot('desktop-2-file.png');

    const t0 = Date.now();
    await js(`document.querySelector('#btn-start').click(); true`);
    await sleep(1500);
    await shot('desktop-3-downloading.png');
    await waitFor(`!!window.__ui.state.project || !document.querySelector('#err').hidden`, 900000, 1000);
    const err = await js(`document.querySelector('#err').hidden ? '' : document.querySelector('#err').textContent`);
    if (err) throw new Error('UI error: ' + err);
    step('transcribed', { wallMs: Date.now() - t0, timings: await js('window.__timings') });
    const words = await js(`window.__ui.state.project.words.map(w => ({ t: w.text, s: +w.start.toFixed(2), e: +w.end.toFixed(2), c: w.confidence == null ? null : +w.confidence.toFixed(3), r: w.review }))`);
    fs.writeFileSync(path.join(OUT, 'words.json'), JSON.stringify(words, null, 1));
    step('words', { count: words.length, flagged: words.filter((w) => w.r).length, text: words.map((w) => (w.r ? `[[${w.t}]]` : w.t)).join(' ') });
    await js(`window.__ui.seek(3.2); true`);
    await shot('desktop-4-review.png');

    // Review UX: next flagged -> edit -> Enter; click a word -> change it; filler toggle.
    let flaggedBefore = await js(`window.__ui.state.project.words.filter(w => w.review).length`);
    if (!flaggedBefore) {
      // Clean clip: Whisper was sure of every word. Mark two words as unsure to exercise the review flow.
      await js(`(() => { const ws = window.__ui.state.project.words; ws[9].review = true; ws[20].review = true; document.querySelector('#chk-fillers').dispatchEvent(new Event('change')); return true; })()`);
      flaggedBefore = 2;
      step('no flagged words from the model; simulated 2 flags (words 9, 20)', {});
      await shot('desktop-4b-flagged.png');
    }
    if (flaggedBefore) {
      await js(`window.__ui.nextFlag(); true`);
      await sleep(300);
      const ed = await js(`window.__ui.state.editing ? { i: window.__ui.state.editing.i, t: window.__ui.state.editing.before, cur: +window.__ui.video.currentTime.toFixed(2) } : null`);
      await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
      const after = await js(`window.__ui.state.project.words.filter(w => w.review).length`);
      step('next-flagged + Enter keeps word', { editing: ed, flaggedBefore, flaggedAfter: after });
    }
    // Click the 3rd word and retype it.
    await js(`document.querySelector('#words .tw[data-i="2"]').click(); true`);
    await sleep(300);
    const clicked = await js(`({ editing: !!window.__ui.state.editing, t: +window.__ui.video.currentTime.toFixed(2), start: +window.__ui.state.project.words[2].start.toFixed(2) })`);
    await js(`(() => { const el = document.activeElement; el.textContent = 'TODAY'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    step('click word -> jump + edit', { ...clicked, newText: await js(`window.__ui.state.project.words[2].text`), toast: await js(`document.querySelector('#learn-toast').textContent`) });
    await js(`document.querySelector('#chk-fillers').click(); document.querySelector('#chk-fillers').click(); true`);
    await shot('desktop-5-edited.png');

    // Styles: preview each preset at the same moment.
    await js(`document.querySelector('.tabs button[data-tab="style"]').click(); true`);
    for (const s of ['clean', 'punch', 'reveal', 'bold']) {
      await js(`document.querySelector('.preset[data-name="${s}"]').click(); window.__ui.seek(3.2); true`);
      await shot(`desktop-6-style-${s}.png`);
    }
    await js(`document.querySelector('.tabs button[data-tab="transcript"]').click(); true`);

    // SRT
    const srt = await js(`window.__ui.srt()`);
    fs.writeFileSync(path.join(OUT, 'test.captions.srt'), srt);
    await js(`document.querySelector('#btn-srt').click(); true`);
    step('srt', { cues: (srt.match(/-->/g) || []).length, head: srt.split('\n').slice(0, 8).join(' | ') });

    // MP4 export
    const e0 = Date.now();
    await js(`document.querySelector('#btn-export').click(); true`);
    await sleep(800);
    await shot('desktop-7-exporting.png');
    await waitFor(`!!window.__timings.exportMs || !!window.__timings.exportError`, 600000, 500);
    step('exported', { wallMs: Date.now() - e0, timings: await js('window.__timings') });
    await sleep(1500);
    await shot('desktop-8-exported.png');
    step('downloads', { downloads });

    // Mobile 390 px
    win.setSize(390, 844);
    await sleep(800);
    await js(`window.__ui.seek(3.2); window.scrollTo(0, 0); true`);
    await shot('mobile-2-review.png');
    await js(`document.querySelector('.panel').scrollIntoView(); true`);
    await shot('mobile-3-review-panel.png');
    await js(`document.querySelector('.export').scrollIntoView(); true`);
    await shot('mobile-4-export.png');
    await js(`document.querySelector('#btn-new').click(); window.scrollTo(0, 0); true`);
    await shot('mobile-1-import.png');
    await js(`document.querySelector('#btn-desktop').click() ; true`);
    await js(`window.__ui && document.querySelector('#desktop').showModal(); true`);
    await shot('mobile-5-desktop-dialog.png');
    await js(`document.querySelector('#desktop').close(); true`);
    win.setSize(1440, 900);
    await sleep(500);
    await js(`document.querySelector('#desktop').showModal(); true`);
    await shot('desktop-9-desktop-dialog.png');
    await js(`document.querySelector('#desktop').close(); true`);

    // Second run in the same browser: model now comes from the browser cache.
    if (process.env.SECOND !== '0') {
      await win.loadURL(URL_);
      await waitFor('!!window.__ui');
      await js(`window.__ui.state.device = 'wasm'; true`);
      const cached = await js(`(async () => { await new Promise(r => setTimeout(r, 500)); return !!window.__ui.state.cached.base; })()`);
      const { root: r2 } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId: n2 } = await dbg.sendCommand('DOM.querySelector', { nodeId: r2.nodeId, selector: '#file' });
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: n2, files: [VIDEO] });
      await waitFor(`!document.querySelector('#btn-start').disabled`, 20000);
      await js(`document.querySelector('#btn-start').click(); true`);
      await waitFor(`!!window.__ui.state.project`, 600000, 500);
      step('second run (cached model)', { cachedPill: cached, timings: await js('window.__timings') });
    }
    results.ok = true;
  } catch (e) {
    results.ok = false; results.error = String(e.stack || e);
    log('FAILED', e);
    try { await shot('failure.png'); } catch {}
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.ok ? 0 : 1);
});
