// Electron main process. Owns windows, dialogs and the personal dictionary.
// All heavy work (model download, transcription, ffmpeg export) runs in a
// utilityProcess (app/worker.mjs) so the UI never freezes.
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, Menu } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Pure engine modules only: transcription/ffmpeg stay in the worker.
import { PRESETS, resolveStyle } from '../src/styles.mjs';
import { buildCaptions } from '../src/captions.mjs';
import { learn, loadDictionary, saveDictionary } from '../src/dictionary.mjs';
import { toolPaths } from './tools.mjs';
import { loadLicense, licenseStatus, activate, deactivate, revalidate } from '../src/license.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.CAPTIONS_UI_SHOTS; // dev only: scripted screenshot tour
const modelsDir = process.env.CAPTIONS_MODEL_DIR || path.join(os.homedir(), '.offline-captions', 'models');
let win;
// Paid desktop app: exporting needs an activated license (the free trial is the web app).
// CAPTIONS_NO_LICENSE=1 skips the check for development and screenshots.
const LICENSE_REQUIRED = !process.env.CAPTIONS_NO_LICENSE && !SHOTS;
export const BUY_URL = process.env.CAPTIONS_BUY_URL || 'https://offline-captions-site.vercel.app/#checkout';
const licenseFile = () => path.join(app.getPath('userData'), 'license.json');
let license = { licensed: false, reason: 'none' };

// ---------- worker (utilityProcess) ----------
let worker;
let seq = 0;
const pending = new Map();

function startWorker() {
  const tools = toolPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: path.join(here, '..') });
  worker = utilityProcess.fork(path.join(here, 'worker.mjs'), [], {
    serviceName: 'captions-engine',
    stdio: 'inherit',
    env: { ...process.env, ...tools, CAPTIONS_MODEL_DIR: modelsDir },
  });
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress) return p.onProgress?.(m.progress);
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  });
  worker.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`Engine stopped unexpectedly (code ${code}). Try again.`));
    pending.clear();
    worker = null;
  });
}

function call(type, args, onProgress) {
  if (!worker) startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, args });
  });
}

// ---------- dictionary (lives in the user's profile, shared by all videos) ----------
const dictFile = () => path.join(app.getPath('userData'), 'dictionary.json');
let dictionary = {};

// ---------- styles: preset + the overrides the engine supports (size, position) ----------
function styleFrom({ style = 'bold', size, position } = {}) {
  const o = {};
  if (Number.isFinite(size)) o.size = size;
  if (Number.isFinite(position)) o.position = position;
  return resolveStyle(style, o);
}

// ---------- IPC ----------
const send = (channel, payload) => win?.webContents.send(channel, payload);

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, modelsDir,
    dictionarySize: Object.keys(dictionary).length,
  }));
  ipcMain.handle('app:presets', () => PRESETS);

  ipcMain.handle('license:status', () => ({ ...license, required: LICENSE_REQUIRED, buyUrl: BUY_URL }));
  ipcMain.handle('license:activate', async (_e, key) => {
    try { license = await activate(licenseFile(), key); return { ok: true, ...license }; }
    catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  ipcMain.handle('license:deactivate', async () => { license = await deactivate(licenseFile()); return license; });

  ipcMain.handle('dialog:videos', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose videos', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Export to…', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:show', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('models:status', (_e, opts) => call('modelStatus', opts));
  ipcMain.handle('models:download', (_e, opts) => call('download', opts, (p) => send('models:progress', p)));

  ipcMain.handle('job:transcribe', (_e, { jobId, file, opts }) =>
    call('transcribe', { file, opts: { ...opts, dictionary } }, (p) => send('job:progress', { jobId, ...p })));

  ipcMain.handle('captions:build', (_e, { project, style, fillers }) => {
    const { lines } = buildCaptions(project, { style: styleFrom(style), fillers });
    return lines;
  });

  ipcMain.handle('dict:learn', (_e, { before, after }) => {
    learn(dictionary, String(before || ''), String(after || ''));
    saveDictionary(dictFile(), dictionary);
    return Object.keys(dictionary).length;
  });

  ipcMain.handle('job:export', (_e, { jobId, project, outDir, style, fillers, draft }) => {
    if (LICENSE_REQUIRED && !license.licensed) throw new Error('LICENSE_REQUIRED');
    const dir = outDir || path.dirname(project.video);
    const base = path.basename(project.video).replace(/\.[^.]+$/, '');
    const output = path.join(dir, `${base}.captioned.mp4`);
    return call('export', { project, output, opts: { style: styleFrom(style), fillers, quality: draft ? 'draft' : 'high' } },
      (p) => send('job:progress', { jobId, ...p }));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1080, minHeight: 700,
    backgroundColor: '#0b0b0d', title: 'Offline Captions', show: !SHOTS,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false, offscreen: !!SHOTS,
    },
  });
  // No navigation away from the app, no new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  if (SHOTS) import('./dev-shots.mjs').then((m) => m.tour(win, SHOTS)).catch((e) => { console.error(e); app.exit(1); });
}

app.whenReady().then(() => {
  dictionary = loadDictionary(dictFile());
  license = licenseStatus(loadLicense(licenseFile()));
  revalidate(licenseFile()).then((s) => { license = s; send('license:changed', license); }).catch(() => {});
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  registerIpc();
  startWorker();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => worker?.kill());
