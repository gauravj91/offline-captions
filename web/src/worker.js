// Speech-to-text Web Worker: Whisper (transformers.js / ONNX Runtime Web) with
// word timestamps and per-word confidence, entirely on this device.
// Messages in:  {type:'load', model, device}  {type:'transcribe', audio(Float32Array 16 kHz), language}
// Messages out: {type:'progress', ...}  {type:'ready', device, loadMs}  {type:'result', words, ms}  {type:'error', message}
import { pipeline, env, LogitsProcessor, LogitsProcessorList } from '@huggingface/transformers';
// Pure helpers shared with the desktop engine (no Node APIs used by these).
import { windows, alignConfidence, fixTimes } from '../../src/engines/whisper.mjs';

env.allowLocalModels = false;
env.useBrowserCache = true; // Cache API: downloaded once, then offline
const base = new URL('./', self.location.href).href;
env.backends.onnx.wasm.wasmPaths = base + 'vendor/ort/'; // vendored, never a CDN
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 2))) : 1;

const SR = 16000;
let asr = null, loaded = null;

// Same recorder as src/engines/whisper.mjs: greedy token + its probability.
class ConfidenceRecorder extends LogitsProcessor {
  constructor() { super(); this.steps = []; }
  _call(inputIds, logits) {
    for (let b = 0; b < logits.dims[0]; b++) {
      const d = logits[b].data;
      let max = -Infinity, arg = 0;
      for (let i = 0; i < d.length; i++) if (d[i] > max) { max = d[i]; arg = i; }
      let sum = 0;
      for (let i = 0; i < d.length; i++) if (d[i] > -Infinity) sum += Math.exp(d[i] - max);
      this.steps.push({ id: arg, p: 1 / sum });
    }
    return logits;
  }
}

async function load({ model, device }) {
  const key = `${model}|${device}`;
  if (asr && loaded === key) return post({ type: 'ready', device, loadMs: 0, cached: true });
  const t0 = performance.now();
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done') {
      const f = files.get(p.file) || { loaded: 0, total: 0 };
      if (p.total) f.total = p.total;
      f.loaded = p.status === 'done' ? (f.total || f.loaded) : (p.loaded || 0);
      files.set(p.file, f);
      let loadedB = 0, total = 0;
      for (const v of files.values()) { loadedB += v.loaded; total += v.total; }
      post({ type: 'progress', stage: 'download', file: p.file, loaded: loadedB, total });
    } else if (p.status === 'ready') {
      post({ type: 'progress', stage: 'init' });
    }
  };
  // WASM: q8 encoder + decoder (smallest). WebGPU: fp32 encoder on the GPU (the
  // heavy part), q8 decoder on WASM (small, and keeps word timestamps exact).
  const opts = device === 'webgpu'
    ? { device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } }
    : { device: 'wasm', dtype: 'q8' };
  asr = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback });
  loaded = key;
  post({ type: 'ready', device, loadMs: Math.round(performance.now() - t0), threads: env.backends.onnx.wasm.numThreads });
}

async function transcribe({ audio, language }) {
  const t0 = performance.now();
  const tk = asr.tokenizer;
  const eot = tk.model.tokens_to_ids?.get('<|endoftext|>') ?? 50257;
  const opts = { return_timestamps: 'word' };
  if (language && language !== 'auto') Object.assign(opts, { language, task: 'transcribe' });
  const all = [];
  const wins = windows(audio);
  for (const [a, b] of wins) {
    const rec = new ConfidenceRecorder();
    const lp = new LogitsProcessorList(); lp.push(rec);
    const out = await asr(audio.subarray(a, b), { ...opts, logits_processor: lp });
    const off = a / SR;
    const words = (out.chunks || [])
      .map((c) => ({ text: c.text.trim(), start: off + Number(c.timestamp?.[0] ?? 0), end: off + Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) }))
      .filter((w) => w.text);
    const tokens = rec.steps.filter((t) => t.id < eot).map((t) => ({ text: tk.decode([t.id], { skip_special_tokens: true }), p: t.p }));
    all.push(...alignConfidence(words, tokens));
    post({ type: 'progress', stage: 'transcribe', fraction: b / audio.length });
  }
  post({ type: 'result', words: fixTimes(all), ms: Math.round(performance.now() - t0) });
}

const post = (m) => self.postMessage(m);
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'transcribe') await transcribe(data);
  } catch (e) {
    // WebGPU can fail at session creation on some GPUs/drivers: tell the UI so it retries on WASM.
    post({ type: 'error', message: String(e?.message || e), during: data.type });
  }
};
