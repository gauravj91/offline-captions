// Hinglish (Hindi-English code-switched) captions in Roman script, fully offline.
// Two passes over each window:
//   1. Oriserve Whisper-Hindi2Hinglish (Apache-2.0) writes the Roman text
//      ("Usko gaali de do, complaint kar lo") but gives no word timestamps.
//   2. AI4Bharat IndicConformer-hi CTC (MIT) hears the same audio in Devanagari
//      with token timestamps.
// hinglish-align.mjs matches the two word lists across scripts and copies the
// times over. Words with no match get interpolated times and are flagged for review.
// Test (CoSHE-Eval, real creator speech): script-blind WER Swift 23.6%,
// Apex 22.3%, IndicConformer alone 30.4%; ~80% of words anchored.
// sherpa-onnx exports: parismitaglobalsolutions/indicconformer-sherpa-onnx (Apache-2.0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { windows } from './whisper.mjs';
import { alignWords } from './hinglish-align.mjs';

const require = createRequire(import.meta.url);
const SR = 16000;
export const REPO = 'https://huggingface.co/parismitaglobalsolutions/indicconformer-sherpa-onnx/resolve/main/';
// fast/balanced -> Swift (~150 MB, ~6x realtime); accurate -> Apex (~1 GB, ~2x realtime).
export const VARIANTS = { fast: 'swift', balanced: 'swift', accurate: 'apex' };
export const TIMING = { dir: 'indicconformer-hi', files: { 'model.int8.onnx': 'hi/model.int8.onnx', 'tokens.txt': 'tokens.txt' } };
export const textModel = (v) => ({ dir: `hinglish-${v}`, files: Object.fromEntries(['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'].map((f) => [f, `hi-hinglish-${v}/${f}`])) });

const base = () => process.env.CAPTIONS_MODEL_DIR || path.join(os.homedir(), '.offline-captions', 'models');

async function ensure({ dir, files }, onProgress) {
  const d = path.join(base(), dir);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, remote] of Object.entries(files)) {
    const dest = path.join(d, name);
    if (fs.existsSync(dest)) continue;
    onProgress?.(`downloading ${dir}/${name}`);
    const res = await fetch(REPO + remote);
    if (!res.ok) throw new Error(`Model download failed (${res.status}) for ${remote}`);
    fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
    fs.renameSync(dest + '.part', dest);
  }
  return d;
}

export async function ensureModels(quality = 'balanced', onProgress) {
  return { timing: await ensure(TIMING, onProgress), text: await ensure(textModel(VARIANTS[quality] || 'swift'), onProgress) };
}

const cache = {};
async function recognizers(quality) {
  const v = VARIANTS[quality] || 'swift';
  if (!cache[v]) {
    const sherpa = require('sherpa-onnx-node');
    const { timing, text } = await ensureModels(quality);
    const featConfig = { sampleRate: SR, featureDim: 80 };
    const numThreads = Math.max(1, Math.min(4, os.cpus().length));
    cache[v] = {
      timing: new sherpa.OfflineRecognizer({ featConfig, modelConfig: { nemoCtc: { model: path.join(timing, 'model.int8.onnx') }, tokens: path.join(timing, 'tokens.txt'), numThreads } }),
      text: new sherpa.OfflineRecognizer({ featConfig, modelConfig: { whisper: { encoder: path.join(text, 'encoder.int8.onnx'), decoder: path.join(text, 'decoder.int8.onnx'), language: 'hi', task: 'transcribe' }, tokens: path.join(text, 'tokens.txt'), numThreads } }),
    };
  }
  return cache[v];
}

function decode(rec, samples) {
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: SR, samples });
  rec.decode(st);
  return rec.getResult(st);
}

/** IndicConformer CTC tokens (" कस", "्टम"; sherpa turns ▁ into a space) -> timed Devanagari words. */
export function ctcWords({ tokens, timestamps }, offset = 0) {
  const words = [];
  tokens.forEach((t, i) => {
    const s = offset + timestamps[i];
    if (/^[▁ ]/.test(t) || !words.length) words.push({ text: t.replace(/^[▁ ]+/, ''), start: s, end: s + 0.08 });
    else { const w = words.at(-1); w.text += t; w.end = s + 0.08; }
  });
  return words.filter((w) => w.text);
}

/** Stretch each word's end toward the next word's start (CTC ends are spikes). */
export function fillEnds(words, maxHold = 0.6) {
  return words.map((w, i) => {
    const next = words[i + 1];
    const end = next ? Math.min(next.start, w.start + maxHold) : w.end + 0.3;
    return { ...w, end: Math.max(w.end, end) };
  });
}

export async function transcribeHinglish(audio, { quality = 'balanced', onProgress } = {}) {
  const rec = await recognizers(quality);
  const all = [];
  for (const [a, b] of windows(audio)) { // Whisper decoder: windows under 30 s
    const seg = audio.subarray(a, b);
    const timed = ctcWords(decode(rec.timing, seg), a / SR);
    const roman = decode(rec.text, seg).text.trim().split(/\s+/).filter(Boolean);
    const aligned = alignWords(roman, timed, (b - a) / SR)
      .map((w) => ({ ...w, start: Math.max(w.start, a / SR), end: Math.min(w.end, b / SR) }));
    all.push(...aligned.map(({ text, start, end, anchored }) => ({ text, start, end, confidence: anchored ? 1 : 0.5 })));
    onProgress?.(b / audio.length);
  }
  const words = fillEnds(all);
  return { text: words.map((w) => w.text).join(' '), words };
}
