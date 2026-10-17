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
  accurate: 'onnx-community/whisper-large-v3-turbo_timestamped',
};

const cache = new Map();

async function getTranscriber(model) {
  if (!cache.has(model)) {
    if (process.env.CAPTIONS_MODEL_DIR) env.cacheDir = process.env.CAPTIONS_MODEL_DIR;
    cache.set(model, pipeline('automatic-speech-recognition', model, { dtype: 'q8' }));
  }
  return cache.get(model);
}

const SR = 16000;

/**
 * Splits long audio into windows Whisper can take in one pass (< 30 s),
 * cutting at the quietest moment so words are not chopped in half.
 * We window ourselves (instead of the pipeline's chunk/stride merge) because
 * the built-in merge drops words and breaks with a vocabulary prompt.
 */
export function windows(audio, { max = 28, min = 18 } = {}) {
  const out = [];
  const frame = SR / 20; // 50 ms
  let start = 0;
  while (audio.length - start > max * SR) {
    let best = start + max * SR, bestE = Infinity;
    for (let f = start + min * SR; f + frame <= start + max * SR; f += frame) {
      let e = 0;
      for (let i = f; i < f + frame; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = f + frame / 2; }
    }
    out.push([start, Math.round(best)]);
    start = Math.round(best);
  }
  out.push([start, audio.length]);
  return out;
}

/**
 * @param {Float32Array} audio 16 kHz mono
 * @returns {Promise<{text:string, words:{text:string,start:number,end:number,confidence:number|null}[]}>}
 */
export async function transcribeWhisper(audio, { quality = 'fast', language, vocabulary = [], onProgress } = {}) {
  const model = MODELS[quality] || quality;
  const asr = await getTranscriber(model);
  const tk = asr.tokenizer;
  const eot = tk.model.tokens_to_ids?.get('<|endoftext|>') ?? 50257;
  // Vocabulary prompt: Whisper reads "previous text" before transcribing, so
  // listing the creator's names/brands makes it hear and spell them that way.
  const prompt = vocabularyPrompt(vocabulary);
  const base = { return_timestamps: 'word' };
  if (language) Object.assign(base, { language, task: 'transcribe' });
  if (prompt) base.decoder_input_ids = promptIds(tk, prompt, language);

  const all = [];
  for (const [a, b] of windows(audio)) {
    const rec = new ConfidenceRecorder();
    const lp = new LogitsProcessorList(); lp.push(rec);
    const out = await asr(audio.subarray(a, b), { ...base, logits_processor: lp });
    const off = a / SR;
    let words = (out.chunks || [])
      .map((c) => ({
        text: c.text.trim(),
        start: off + Number(c.timestamp?.[0] ?? 0),
        end: off + Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0),
      }))
      .filter((w) => w.text);
    if (prompt) words = stripPrompt(words, prompt);
    const tokens = rec.steps.filter((t) => t.id < eot)
      .map((t) => ({ text: tk.decode([t.id], { skip_special_tokens: true }), p: t.p }));
    all.push(...alignConfidence(words, tokens));
    onProgress?.(b / audio.length);
  }
  return { text: all.map((w) => w.text).join(' '), words: fixTimes(all) };
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

const MAX_PROMPT_CHARS = 400; // Whisper allows ~224 prompt tokens; stay well under.

export function vocabularyPrompt(vocabulary) {
  const terms = [...new Set(vocabulary.map((t) => String(t).trim()).filter(Boolean))];
  let out = '';
  for (const t of terms) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : '';
}

function promptIds(tokenizer, prompt, language = 'en') {
  const id = (t) => tokenizer.model.tokens_to_ids.get(t);
  const code = (language || 'en').toLowerCase().slice(0, 2);
  const ids = [id('<|startofprev|>'), ...tokenizer.encode(' ' + prompt, { add_special_tokens: false }),
    id('<|startoftranscript|>'), id(`<|${code}|>`), id('<|transcribe|>')];
  if (ids.some((x) => x == null)) throw new Error(`Unsupported language "${language}"`);
  return ids;
}

/** Whisper echoes the prompt at the start of each 30 s window; remove those runs. */
export function stripPrompt(words, prompt) {
  const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const target = key(prompt);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let acc = '', j = i;
    while (j < words.length && acc.length < target.length && target.startsWith(acc + key(words[j].text))) {
      acc += key(words[j].text); j++;
    }
    if (acc === target && acc) { i = j - 1; continue; }
    out.push(words[i]);
  }
  return out;
}
