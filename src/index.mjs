// Public engine API, used by the CLI now and by the desktop app later.
//   const project = await createProject('clip.mp4', { dictionary })
//   ...user edits project.words...
//   await exportVideo(project, 'clip.captioned.mp4', { style: 'bold' })
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, extractAudio } from './ffmpeg.mjs';
import { transcribe } from './transcribe.mjs';
import { applyDictionary } from './dictionary.mjs';
import { buildCaptions } from './captions.mjs';
import { burn } from './render.mjs';
import { flagForReview, THRESHOLDS } from './review.mjs';

export { reviewText, reviewStats } from './review.mjs';
export { buildCaptions } from './captions.mjs';

export { PRESETS, resolveStyle } from './styles.mjs';
export { modelPlan, modelStatus, downloadModels, modelsBase } from './models.mjs';
export { pickEngine } from './transcribe.mjs';
export { learn, loadDictionary, saveDictionary } from './dictionary.mjs';

/** Transcribes a video into an editable project (plain JSON). */
export async function createProject(video, { engine, quality = 'balanced', language, dictionary = {}, vocabulary: extraVocabulary = [], onStage, onProgress } = {}) {
  onStage?.('probe');
  const meta = await probe(video);
  onStage?.('audio');
  const audio = await extractAudio(video);
  onStage?.('transcribe');
  const t0 = Date.now();
  const vocabulary = [...Object.values(dictionary), ...extraVocabulary];
  const { words, engine: used } = await transcribe(audio, { engine, quality, language, vocabulary, onProgress });
  return {
    version: 1,
    video: path.resolve(video),
    ...meta,
    engine: used,
    transcribeSeconds: (Date.now() - t0) / 1000,
    words: flagForReview(applyDictionary(words, dictionary), THRESHOLDS[used]),
  };
}

/** Writes the captioned video (+ .srt next to it). */
export async function exportVideo(project, output, opts = {}) {
  const { ass, srt } = buildCaptions(project, opts);
  const assFile = path.join(os.tmpdir(), `captions-${process.pid}-${Date.now()}.ass`);
  fs.writeFileSync(assFile, ass);
  try {
    await burn(project.video, assFile, output, { ...opts, duration: project.duration });
  } finally {
    fs.rmSync(assFile, { force: true });
  }
  const srtFile = output.replace(/\.[^.]+$/, '') + '.srt';
  fs.writeFileSync(srtFile, srt);
  return { video: output, srt: srtFile };
}
