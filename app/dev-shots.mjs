// Dev only (CAPTIONS_UI_SHOTS=<dir>): drives the real app through its main
// screens and saves PNGs. Uses the real worker: model download, transcription
// and export all run for real. CAPTIONS_UI_VIDEO picks the clip.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tour(win, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name), img.toPNG());
    console.log('[shots] saved', name, img.getSize());
  };
  const waitFor = async (expr, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(80); }
    throw new Error(`timeout waiting for ${expr}`);
  };
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message ?? e));

  await waitFor('!!window.__ui', 20000);
  if (process.env.CAPTIONS_UI_TOUR === 'link') { // paste-a-link import (needs internet; CAPTIONS_UI_LINK = a direct/Drive/Dropbox video link)
    await js(`window.__ui.addLink('https://youtu.be/dQw4w9WgXcQ')`);
    await shot('link-1-blocked.png');
    await js(`window.__ui.addLink(${JSON.stringify(process.env.CAPTIONS_UI_LINK)})`);
    await waitFor("window.__ui.state.jobs.some((j) => j.status === 'downloading' && j.progress > 0.1) || window.__ui.state.jobs.some((j) => j.status !== 'downloading')", 120000);
    await shot('link-2-downloading.png');
    await waitFor("window.__ui.state.jobs.every((j) => j.status !== 'downloading')", 600000);
    await shot('link-3-queued.png');
    console.log('[shots] jobs', JSON.stringify(await js('window.__ui.state.jobs.map(({ name, status, error, file }) => ({ name, status, error, file }))')));
    return app.exit(0);
  }
  const videos = process.env.CAPTIONS_UI_VIDEO.split(',');
  await js(`window.__ui.addFiles(${JSON.stringify(videos)})`);
  await sleep(500);
  if (process.env.CAPTIONS_UI_TOUR === 'download') { // first-run download only (Hinglish Apex: largest)
    await js(`document.querySelector('#seg-lang [data-v=hinglish]').click()`);
    await sleep(200);
    // quality picker removed 19 Oct 2026 (auto + deeper-pass offer)
    await sleep(400);
    await js('window.__ui.start()');
    await waitFor("parseInt(document.querySelector('#dl-pct').textContent) >= 8", 90000);
    const img = await win.webContents.capturePage(); // no delay: the bar moves fast
    fs.writeFileSync(path.join(dir, '02-model-download.png'), img.toPNG());
    return app.exit(0);
  }
  await shot('01-import.png');

  const ready = await js('window.__ui.state.model && window.__ui.state.model.ready');
  await js('window.__ui.start()');
  if (!ready) {
    await waitFor("parseInt(document.querySelector('#dl-pct').textContent) >= 15", 90000);
    const img = await win.webContents.capturePage(); // no delay: the bar moves fast
    fs.writeFileSync(path.join(dir, '02-model-download.png'), img.toPNG());
  }
  await waitFor('window.__ui.state.current != null', 600000);
  // Review: pause on the first flagged word so the caption and the yellow word line up.
  await js(`(() => { const u = window.__ui; const ws = u.state.jobs[0].project.words;
    const i = Math.max(0, ws.findIndex((w) => w.review)); u.seek(ws[i].start + 0.05); })()`);
  await sleep(1200);
  await shot('03-review.png');

  // Style + export.
  await js(`document.querySelector('.tabs button[data-tab=style]').click()`);
  await js(`[...document.querySelectorAll('.preset')].find((b) => b.textContent.includes('clean')).click()`);
  await js(`(() => { const r = document.querySelector('#rng-pos'); r.value = 0.2; r.dispatchEvent(new Event('input')); })()`);
  await js(`document.querySelector('#chk-draft').click()`);
  await js(`window.__ui.seek(4.2)`);
  await js(`window.__ui.exportJobs([window.__ui.state.current])`);
  await waitFor("!document.querySelector('#ex-done').hidden", 300000);
  await shot('04-style-export.png');

  await js(`document.querySelector('#btn-about').click()`);
  await shot('05-about.png');
  app.quit();
}
