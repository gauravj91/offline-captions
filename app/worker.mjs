// Engine worker (Electron utilityProcess). Runs model downloads, transcription
// (sherpa-onnx native module / ONNX Runtime) and ffmpeg export off the UI thread.
// Protocol: { id, type, args } in; { id, progress } updates; { id, ok, result|error } out.
import { createProject, exportVideo, modelStatus, downloadModels, reviewStats } from '../src/index.mjs';

const port = process.parentPort;
const reply = (id, body) => port.postMessage({ id, ...body });

const handlers = {
  modelStatus: (args) => {
    const { ready, missing, plan } = modelStatus(args);
    return { ready, missing, engine: plan.engine, label: plan.label, approxMB: plan.approxMB, managed: plan.managed };
  },
  download: async (args, progress) => {
    const plan = await downloadModels(args, (p) => progress({ stage: 'download', ...p }));
    return { engine: plan.engine };
  },
  transcribe: async ({ file, opts }, progress) => {
    const project = await createProject(file, {
      ...opts,
      onStage: (stage) => progress({ stage, fraction: stage === 'transcribe' ? 0 : null }),
      onProgress: (fraction) => progress({ stage: 'transcribe', fraction }),
    });
    project.language = opts.language || null;
    return { project, stats: reviewStats(project.words) };
  },
  export: async ({ project, output, opts }, progress) => {
    progress({ stage: 'export', fraction: 0 });
    return exportVideo(project, output, { ...opts, onProgress: (fraction) => progress({ stage: 'export', fraction }) });
  },
};

port.on('message', async ({ data }) => {
  const { id, type, args } = data || {};
  const h = handlers[type];
  if (!h) return reply(id, { ok: false, error: `Unknown request ${type}` });
  try {
    const result = await h(args || {}, (progress) => reply(id, { progress }));
    reply(id, { ok: true, result });
  } catch (e) {
    reply(id, { ok: false, error: friendly(e) });
  }
});

function friendly(e) {
  const msg = String(e?.message || e);
  if (/ENOENT/.test(msg) && /ff(mpeg|probe)/.test(msg)) return 'ffmpeg was not found. The installer bundles it; in development install it (brew install ffmpeg / winget install ffmpeg).';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(msg)) return 'Could not reach the model server. The one-time model download needs internet; after that everything runs offline.';
  return msg;
}
