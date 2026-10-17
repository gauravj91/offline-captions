// Engine switch. Parakeet (English, most accurate + fastest) is the default;
// Whisper covers other languages and is the fallback. --lang hinglish (or
// hi-en) picks the Roman-script Hinglish engine.
import { transcribeWhisper, fixTimes } from './engines/whisper.mjs';
import { transcribeParakeet } from './engines/parakeet.mjs';
import { transcribeHinglish } from './engines/hinglish.mjs';
import { fixVocabulary } from './vocabulary.mjs';

export { MODELS, windows, alignConfidence, vocabularyPrompt, stripPrompt, fixTimes } from './engines/whisper.mjs';

export function pickEngine({ engine, language } = {}) {
  if (engine) return engine;
  if (language && /^(hinglish|hi-en|hien)$/i.test(language)) return 'hinglish';
  return !language || language.toLowerCase().startsWith('en') ? 'parakeet' : 'whisper';
}

/**
 * @param {Float32Array} audio 16 kHz mono
 * @param {{engine?:'parakeet'|'whisper'|'hinglish', quality?:string, language?:string, vocabulary?:string[], onProgress?:(fraction:number)=>void}} opts
 */
export async function transcribe(audio, opts = {}) {
  const engine = pickEngine(opts);
  const res = engine === 'parakeet' ? await transcribeParakeet(audio, opts)
    : engine === 'hinglish' ? await transcribeHinglish(audio, opts)
    : await transcribeWhisper(audio, opts);
  const words = fixVocabulary(res.words, opts.vocabulary || []);
  return { engine, text: words.map((w) => w.text).join(' '), words: fixTimes(words) };
}
