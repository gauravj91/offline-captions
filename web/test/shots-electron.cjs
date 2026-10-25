// Layout screenshots of the web app at phone and desktop sizes, inside Electron's Chromium.
// No model download: the transcript comes from WORDS (a words.json written by e2e-electron.cjs),
// loaded through window.__ui.loadProject. The MP4 export at the end is real (WebCodecs).
//   node serve.mjs &   (port 8787)
//   electron --no-sandbox --ozone-platform=headless test/shots-electron.cjs
// Env: URL, VIDEO, WORDS, SHOTS (screenshot dir), OUT (export dir)
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const URL_ = process.env.URL || 'http://localhost:8787/';
const VIDEO = path.resolve(process.env.VIDEO || path.join(__dirname, '../../samples/test.mp4'));
const WORDS = path.resolve(process.env.WORDS || '/workspace/work/web-test/words.json');
const SHOTS = path.resolve(process.env.SHOTS || '/workspace/work/web-shots-mobile');
const OUT = path.resolve(process.env.OUT || '/workspace/work/web-shots-mobile/out');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[shots]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const report = { checks: [] };
  session.defaultSession.on('will-download', (_e, item) => item.setSavePath(path.join(OUT, item.getFilename())));
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error' || level === 'warning') log('console:', message.slice(0, 300)); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const size = async (w, h) => { win.setContentSize(w, h); await sleep(700); };
  const shot = async (name) => { await sleep(450); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS, name), img.toPNG()); log('shot', name, img.getSize()); };
  // Horizontal overflow + small tap targets among visible controls.
  const check = async (label) => {
    const r = await js(`(() => {
      const de = document.documentElement;
      const small = [...document.querySelectorAll('button, a.btn, select, .toggle, input[type=range]')]
        .filter((e) => e.offsetParent && getComputedStyle(e).visibility !== 'hidden')
        .map((e) => { const b = e.getBoundingClientRect(); return { id: e.id || e.className || e.tagName, w: Math.round(b.width), h: Math.round(b.height) }; })
        .filter((b) => b.w > 0 && (b.h < 44 || b.w < 44) && !/^tw/.test(b.id));
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.id || e.className || e.tagName).slice(0, 8);
      return { w: innerWidth, h: innerHeight, scrollW: de.scrollWidth, hOverflow: de.scrollWidth > innerWidth, wide, small };
    })()`);
    report.checks.push({ label, ...r });
    log(label, JSON.stringify(r));
  };
  const waitFor = async (code, ms = 120000) => { const t0 = Date.now(); for (;;) { if (await js(code)) return; if (Date.now() - t0 > ms) throw new Error('timeout ' + code); await sleep(300); } };
  try {
    await win.loadURL(URL_);
    await waitFor('!!window.__ui');
    await sleep(800);
    // Dismiss the analytics consent banner (shared with the landing site) so it doesn't cover the UI.
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Decline')?.click(); true`);
    await shot('desktop-1-import.png');
    await size(390, 844);
    await shot('mobile-1-import.png'); await check('mobile import');

    const dbg = win.webContents.debugger; dbg.attach('1.3');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [VIDEO] });
    await waitFor(`!document.querySelector('#clip').hidden && !document.querySelector('#btn-start').disabled`, 20000);
    await shot('mobile-2-file.png'); await check('mobile file chosen');

    const words = JSON.parse(fs.readFileSync(WORDS, 'utf8')).map((w) => ({ text: w.t, start: w.s, end: w.e, confidence: w.c }));
    words[9].confidence = 0.3; words[20].confidence = 0.4; // two unsure words to show the review UI
    await js(`window.__ui.loadProject(${JSON.stringify(words)}).then(() => true)`);
    await waitFor(`window.__ui.video.readyState >= 2`, 20000);
    await js(`window.__ui.seek(3.2); true`);
    await shot('mobile-3-review.png'); await check('mobile review (sheet closed)');

    await js(`window.__ui.setSafe(true); true`);
    await shot('mobile-4-safe-zones.png');
    report.beforeFit = await js(`document.querySelector('#safe-msg').textContent`);
    await js(`document.querySelector('#btn-fit').click(); window.__ui.seek(3.2); true`);
    report.afterFit = { msg: await js(`document.querySelector('#safe-msg').textContent`), style: await js(`JSON.stringify(window.__ui.state.style)`) };
    await shot('mobile-5-fitted.png'); await check('mobile safe zones fitted');

    await js(`document.querySelector('#sheet-head').click(); true`);
    await shot('mobile-6-sheet-transcript.png'); await check('mobile sheet transcript');
    await js(`document.querySelector('.tabs button[data-tab="style"]').click(); true`);
    await shot('mobile-7-sheet-style.png'); await check('mobile sheet style');
    await js(`document.querySelector('#tab-style').scrollTop = 9999; true`);
    await shot('mobile-7b-sheet-style-bottom.png');
    await js(`document.querySelector('#sheet-head').click(); true`);

    await size(360, 740);
    await js(`window.__ui.seek(3.2); true`);
    await shot('mobile360-review.png'); await check('360 review');
    await size(390, 844);

    // Copy text (clipboard may be blocked headless; the fallback path runs then)
    report.spoken = await js(`window.__ui.spokenText().slice(0, 120)`);

    // Real export with safe zones on: the overlay must not be in the file.
    await js(`window.__ui.state.timings.exportMs = 0; document.querySelector('#btn-export').click(); true`);
    await sleep(700);
    await shot('mobile-8-exporting.png');
    await waitFor(`!!window.__timings.exportMs || !!window.__timings.exportError`, 300000);
    report.export = await js(`({ ms: window.__timings.exportMs, err: window.__timings.exportError || null, size: window.__timings.exportSize, path: window.__timings.exportPath, audio: window.__timings.exportAudio, share: !document.querySelector('#btn-share').hidden, done: document.querySelector('#ex-done-text').textContent })`);
    await sleep(1200);
    await shot('mobile-9-exported.png'); await check('mobile exported');
    // Web Share path (Electron has no file sharing): stub canShare/share, re-show the button, tap it.
    await js(`navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = d.files.map((f) => f.name + ' ' + f.type + ' ' + f.size).join(','); }; document.querySelector('#btn-share').hidden = false; true`);
    await shot('mobile-9b-share-button.png');
    await js(`document.querySelector('#btn-share').click(); true`);
    await sleep(300);
    report.shared = await js(`window.__shared || null`);
    await js(`document.querySelector('#btn-copy').click(); true`);
    await sleep(200);
    report.copyButton = await js(`document.querySelector('#btn-copy').textContent`);

    await size(1280, 800);
    await js(`window.__ui.seek(3.2); true`);
    await shot('desktop-2-review-safe.png'); await check('desktop review');
    await js(`document.querySelector('.tabs button[data-tab="style"]').click(); true`);
    await shot('desktop-3-style.png');
    await js(`document.querySelector('.tabs button[data-tab="transcript"]').click(); window.__ui.setSafe(false); true`);
    await shot('desktop-4-safe-off.png');
    report.ok = true;
  } catch (e) {
    report.ok = false; report.error = String(e.stack || e); log('FAILED', e);
    try { await shot('failure.png'); } catch {}
  }
  fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 1));
  app.exit(report.ok ? 0 : 1);
});
