// Transcribes every clip in refs.json and writes hypotheses (+ confidence) for scoring.
// usage: node bench/run.mjs <refs.json> <fast|balanced> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { extractAudio } from '../src/ffmpeg.mjs';
import { transcribe } from '../src/transcribe.mjs';
import { flagForReview } from '../src/review.mjs';

const [refsFile, quality = 'fast', outFile] = process.argv.slice(2);
const refs = JSON.parse(fs.readFileSync(refsFile, 'utf8'));
const out = [];
const t0 = Date.now();
for (const r of refs) {
  const audio = await extractAudio(path.resolve(path.dirname(refsFile), r.file));
  const s = Date.now();
  const { words } = await transcribe(audio, { quality, language: 'en' });
  out.push({ ...r, secs: (Date.now() - s) / 1000, words: flagForReview(words).map(({ text, confidence, review }) => ({ text, confidence, review })) });
  process.stderr.write('.');
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`\n${quality}: ${refs.length} clips in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
