// NVIDIA Parakeet-TDT 0.6B v2 (English) via sherpa-onnx: our default engine.
// Benchmark (bench/README.md): 7.6% WER vs Whisper-small 9.6%, ~6x faster.
// Model: CC-BY-4.0 (attribution in the app's About box). Runtime: Apache-2.0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { windows } from './whisper.mjs';

const require = createRequire(import.meta.url);
const SR = 16000;
const REPO = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main/';
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];

export function modelDir() {
  const base = process.env.CAPTIONS_MODEL_DIR || path.join(os.homedir(), '.offline-captions', 'models');
  return path.join(base, 'parakeet-tdt-0.6b-v2-int8');
}

/** Downloads the model once (~660 MB). Resumable at file level. */
export async function ensureModel(onProgress) {
  const dir = modelDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest)) continue;
    onProgress?.(`downloading ${f}`);
    const res = await fetch(REPO + f);
    if (!res.ok) throw new Error(`Model download failed (${res.status}) for ${f}`);
    const tmp = dest + '.part';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }
  return dir;
}

let recognizer;
async function getRecognizer() {
  if (!recognizer) {
    const dir = await ensureModel();
    const sherpa = require('sherpa-onnx-node');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, 'decoder.int8.onnx'),
          joiner: path.join(dir, 'joiner.int8.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: Math.max(1, Math.min(4, os.cpus().length)),
        modelType: 'nemo_transducer',
      },
    });
  }
  return recognizer;
}

/** Sherpa tokens (" That", "'", "s") -> words with timing and confidence. */
export function tokensToWords({ tokens, timestamps, durations = [], ys_log_probs = [] }, offset = 0) {
  const words = [];
  tokens.forEach((tok, i) => {
    const start = offset + timestamps[i];
    const end = start + (durations[i] || 0.08);
    const p = Math.exp(ys_log_probs[i] ?? 0);
    if (tok.startsWith(' ') || !words.length) {
      words.push({ text: tok.trim(), start, end, confidence: p });
    } else {
      const w = words.at(-1);
      w.text += tok; w.end = Math.max(w.end, end); w.confidence = Math.min(w.confidence, p);
    }
  });
  return words.filter((w) => w.text);
}

export async function transcribeParakeet(audio) {
  const rec = await getRecognizer();
  const all = [];
  // Parakeet handles long context, but windowing keeps memory flat on 8 GB laptops.
  for (const [a, b] of windows(audio, { max: 55, min: 35 })) {
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: SR, samples: audio.subarray(a, b) });
    rec.decode(st);
    all.push(...tokensToWords(rec.getResult(st), a / SR));
  }
  return { text: all.map((w) => w.text).join(' '), words: all };
}
