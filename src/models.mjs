// Model download manager: what each engine needs, whether it is already on
// disk, and a streaming download with byte-level progress (for the desktop
// app's first-run screen). Files land exactly where the engines look for them,
// so the CLI and the app share one local model folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickEngine } from './transcribe.mjs';
import { REPO as PARAKEET_REPO, FILES as PARAKEET_FILES, modelDir as parakeetDir } from './engines/parakeet.mjs';
import { REPO as HINGLISH_REPO, TIMING, textModel, VARIANTS } from './engines/hinglish.mjs';
import { MODELS as WHISPER_MODELS } from './engines/whisper.mjs';

export const modelsBase = () => process.env.CAPTIONS_MODEL_DIR || path.join(os.homedir(), '.offline-captions', 'models');

// Approximate sizes, shown before we ask the server for exact ones.
const APPROX_MB = {
  parakeet: 660,
  'hinglish-swift': 350,
  'hinglish-apex': 1200,
  whisper: { fast: 80, balanced: 250, accurate: 800 },
};

/**
 * What a transcription with these settings needs on disk.
 * @returns {{engine, label, approxMB, managed:boolean, files:{url,dest}[], model?:string}}
 *   managed=true: transformers.js downloads it (Whisper); files is empty.
 */
export function modelPlan({ engine, language, quality = 'balanced' } = {}) {
  const e = pickEngine({ engine, language });
  if (e === 'parakeet') {
    const dir = parakeetDir();
    return {
      engine: e, label: 'NVIDIA Parakeet-TDT 0.6B v2 (English)', approxMB: APPROX_MB.parakeet, managed: false,
      files: PARAKEET_FILES.map((f) => ({ url: PARAKEET_REPO + f, dest: path.join(dir, f) })),
    };
  }
  if (e === 'hinglish') {
    const v = VARIANTS[quality] || 'swift';
    const files = [];
    for (const m of [TIMING, textModel(v)]) {
      for (const [name, remote] of Object.entries(m.files)) {
        files.push({ url: HINGLISH_REPO + remote, dest: path.join(modelsBase(), m.dir, name) });
      }
    }
    return {
      engine: e, label: `Hinglish ${v === 'apex' ? 'Apex' : 'Swift'} + IndicConformer timing`,
      approxMB: APPROX_MB[`hinglish-${v}`], managed: false, files,
    };
  }
  const model = WHISPER_MODELS[quality] || WHISPER_MODELS.balanced;
  return {
    engine: e, label: `Whisper ${model.split('/').pop().replace('_timestamped', '')}`,
    approxMB: APPROX_MB.whisper[quality] || APPROX_MB.whisper.balanced, managed: true, files: [], model,
  };
}

/** { ready, missing, plan } — ready=true means transcription will not touch the network. */
export function modelStatus(opts = {}) {
  const plan = modelPlan(opts);
  if (plan.managed) {
    const onnx = path.join(modelsBase(), plan.model, 'onnx');
    const have = fs.existsSync(onnx) ? fs.readdirSync(onnx) : [];
    const ready = have.some((f) => /^encoder.*quantized\.onnx$/.test(f)) && have.some((f) => /^decoder.*quantized\.onnx$/.test(f));
    return { ready, missing: ready ? 0 : 1, plan };
  }
  const missing = plan.files.filter((f) => !fs.existsSync(f.dest)).length;
  return { ready: missing === 0, missing, plan };
}

/**
 * Downloads whatever is missing. Resumable at file level (finished files are kept).
 * onProgress({ received, total, file }) — total is exact once the server answers.
 */
export async function downloadModels(opts = {}, onProgress, { signal } = {}) {
  const { plan } = modelStatus(opts);
  if (plan.managed) return downloadWhisper(plan, onProgress);
  const todo = plan.files.filter((f) => !fs.existsSync(f.dest));
  const sizes = await Promise.all(todo.map(async (f) => {
    try {
      const r = await fetch(f.url, { method: 'HEAD', redirect: 'follow', signal });
      return Number(r.headers.get('content-length')) || 0;
    } catch { return 0; }
  }));
  let total = sizes.reduce((a, b) => a + b, 0) || plan.approxMB * 1e6;
  let received = 0;
  for (const f of todo) {
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    const res = await fetch(f.url, { redirect: 'follow', signal });
    if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status}) for ${path.basename(f.dest)}`);
    const tmp = f.dest + '.part';
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        received += chunk.length;
        if (received > total) total = received;
        onProgress?.({ received, total, file: path.basename(f.dest) });
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy(); fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.renameSync(tmp, f.dest);
  }
  onProgress?.({ received: total, total, file: null });
  return plan;
}

async function downloadWhisper(plan, onProgress) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = modelsBase();
  const files = new Map();
  const asr = await pipeline('automatic-speech-recognition', plan.model, {
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let received = 0, total = 0;
      for (const v of files.values()) { received += v.loaded; total += v.total; }
      onProgress?.({ received, total: Math.max(total, plan.approxMB * 1e6 * 0.5), file: p.file });
    },
  });
  await asr.dispose?.();
  onProgress?.({ received: 1, total: 1, file: null });
  return plan;
}
