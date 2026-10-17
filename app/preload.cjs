// The only bridge between the page and the app. Exposes a small, explicit API;
// the renderer has no Node access (contextIsolation on, nodeIntegration off, sandboxed).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('captions', {
  info: () => ipcRenderer.invoke('app:info'),
  presets: () => ipcRenderer.invoke('app:presets'),
  pickVideos: () => ipcRenderer.invoke('dialog:videos'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  modelStatus: (opts) => ipcRenderer.invoke('models:status', opts),
  downloadModels: (opts) => ipcRenderer.invoke('models:download', opts),
  transcribe: (jobId, file, opts) => ipcRenderer.invoke('job:transcribe', { jobId, file, opts }),
  buildLines: (project, style, fillers) => ipcRenderer.invoke('captions:build', { project, style, fillers }),
  learn: (before, after) => ipcRenderer.invoke('dict:learn', { before, after }),
  exportVideo: (args) => ipcRenderer.invoke('job:export', args),
  onModelProgress: on('models:progress'),
  onJobProgress: on('job:progress'),
});
