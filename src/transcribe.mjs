// Local speech-to-text with word timestamps. Runs fully on-device via
// transformers.js (ONNX Runtime); the model is downloaded once and cached.
// Upgrade path: swap in whisper.cpp / Parakeet behind the same interface.
import { pipeline, env } from '@huggingface/transformers';

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
  const out = await asr(audio, opts);
  const words = (out.chunks || [])
    .map((c) => ({
      text: c.text.trim(),
      start: Number(c.timestamp?.[0] ?? 0),
      end: Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0),
    }))
    .filter((w) => w.text);
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
