// Local speech-to-text with word timestamps. Runs fully on-device via
// transformers.js (ONNX Runtime); the model is downloaded once and cached.
// Upgrade path: swap in whisper.cpp / Parakeet behind the same interface.
import { pipeline, env, LogitsProcessor, LogitsProcessorList } from '@huggingface/transformers';

// Records, at every decoding step, the token Whisper picked (greedy = argmax)
// and its probability. Runs last in the processor chain, so it sees the final
// logits. It never changes them.
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

/** Give each word the lowest probability of the tokens that spell it. */
export function alignConfidence(words, tokens) {
  // tokens: [{text, p}] in decode order (may contain duplicates from chunk overlap)
  const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let stream = '', probs = [];
  for (const t of tokens) {
    const k = key(t.text);
    stream += k; for (let i = 0; i < k.length; i++) probs.push(t.p);
  }
  let cursor = 0;
  for (const w of words) {
    const k = key(w.text);
    if (!k) { w.confidence = 1; continue; }
    const at = stream.indexOf(k, cursor);
    if (at < 0 || at - cursor > 200) { w.confidence = null; continue; }
    w.confidence = Math.min(...probs.slice(at, at + k.length));
    cursor = at + k.length;
  }
  return words;
}

export const MODELS = {
  fast: 'onnx-community/whisper-base_timestamped',
  balanced: 'onnx-community/whisper-small_timestamped',
};

const cache = new Map();

async function getTranscriber(model) {
  if (!cache.has(model)) {
    if (process.env.CAPTIONS_MODEL_DIR) env.cacheDir = process.env.CAPTIONS_MODEL_DIR;
    cache.set(model, pipeline('automatic-speech-recognition', model, { dtype: 'q8' }));
  }
  return cache.get(model);
}

/**
 * @param {Float32Array} audio 16 kHz mono
 * @returns {Promise<{text:string, words:{text:string,start:number,end:number}[]}>}
 */
export async function transcribe(audio, { quality = 'fast', language } = {}) {
  const model = MODELS[quality] || quality;
  const asr = await getTranscriber(model);
  const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
  if (language) Object.assign(opts, { language, task: 'transcribe' });
  const rec = new ConfidenceRecorder();
  const lp = new LogitsProcessorList(); lp.push(rec);
  opts.logits_processor = lp;
  const out = await asr(audio, opts);
  const eot = asr.tokenizer.model.tokens_to_ids?.get('<|endoftext|>') ?? 50257;
  const words = (out.chunks || [])
    .map((c) => ({
      text: c.text.trim(),
      start: Number(c.timestamp?.[0] ?? 0),
      end: Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0),
    }))
    .filter((w) => w.text);
  const tokens = rec.steps.filter((t) => t.id < eot)
    .map((t) => ({ text: asr.tokenizer.decode([t.id], { skip_special_tokens: true }), p: t.p }));
  alignConfidence(words, tokens);
  return { text: out.text.trim(), words: fixTimes(words) };
}

/** Keeps timestamps monotonic and gives every word a minimum visible length. */
export function fixTimes(words, minDur = 0.08) {
  let prevEnd = 0;
  for (const w of words) {
    if (!Number.isFinite(w.start) || w.start < prevEnd) w.start = prevEnd;
    if (!Number.isFinite(w.end) || w.end < w.start + minDur) w.end = w.start + minDur;
    prevEnd = w.end;
  }
  return words;
}
