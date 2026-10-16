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
import { segment, removeFillers } from './segment.mjs';
import { resolveStyle } from './styles.mjs';
import { buildAss } from './ass.mjs';
import { buildSrt } from './srt.mjs';
import { burn } from './render.mjs';
import { flagForReview } from './review.mjs';

export { reviewText, reviewStats } from './review.mjs';

export { PRESETS } from './styles.mjs';
export { learn, loadDictionary, saveDictionary } from './dictionary.mjs';

/** Transcribes a video into an editable project (plain JSON). */
export async function createProject(video, { quality = 'fast', language, dictionary = {}, onStage } = {}) {
  onStage?.('probe');
  const meta = await probe(video);
  onStage?.('audio');
  const audio = await extractAudio(video);
  onStage?.('transcribe');
  const t0 = Date.now();
  const { words } = await transcribe(audio, { quality, language });
  return {
    version: 1,
    video: path.resolve(video),
    ...meta,
    transcribeSeconds: (Date.now() - t0) / 1000,
    words: flagForReview(applyDictionary(words, dictionary)),
  };
}

export function buildCaptions(project, { style = 'bold', fillers = true, segmentOpts } = {}) {
  const st = resolveStyle(style);
  const words = fillers ? removeFillers(project.words) : project.words;
  const lines = segment(words, st.mode === 'single' ? { maxWords: 1 } : segmentOpts);
  return {
    lines,
    ass: buildAss(lines, st, { width: project.width, height: project.height }),
    srt: buildSrt(lines),
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
