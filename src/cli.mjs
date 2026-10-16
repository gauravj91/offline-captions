#!/usr/bin/env node
// captions <video...> [--style bold|clean|punch|reveal] [--quality fast|balanced]
//          [--dict words.json] [--lang en] [--keep-fillers] [--draft] [--out dir]
//          [--edit]   stop after transcription and write <video>.captions.json
//          [--from project.json]   render from an edited project
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createProject, exportVideo, loadDictionary, PRESETS, reviewText, reviewStats } from './index.mjs';

const { values: o, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string', default: 'bold' },
    quality: { type: 'string', default: 'fast' },
    dict: { type: 'string' },
    lang: { type: 'string' },
    out: { type: 'string' },
    from: { type: 'string' },
    edit: { type: 'boolean', default: false },
    draft: { type: 'boolean', default: false },
    'keep-fillers': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (o.help || (!files.length && !o.from)) {
  console.log(`Usage: captions <video...> [--style ${Object.keys(PRESETS).join('|')}] [--quality fast|balanced]
       [--dict dictionary.json] [--lang en] [--keep-fillers] [--draft] [--out dir] [--edit | --from project.json]`);
  process.exit(o.help ? 0 : 1);
}

const dictionary = loadDictionary(o.dict);
const jobs = o.from ? [{ project: JSON.parse(fs.readFileSync(o.from, 'utf8')) }] : files.map((f) => ({ file: f }));

for (const job of jobs) {
  const t0 = Date.now();
  let project = job.project;
  if (!project) {
    process.stdout.write(`• ${path.basename(job.file)}: `);
    project = await createProject(job.file, {
      quality: o.quality, language: o.lang, dictionary,
      onStage: (s) => process.stdout.write(`${s}… `),
    });
    const st = reviewStats(project.words);
    console.log(`${project.words.length} words in ${project.transcribeSeconds.toFixed(1)}s, ${st.flagged} to check`);
    if (st.flagged) console.log(`  ${reviewText(project.words)}`);
  }
  const base = project.video.replace(/\.[^.]+$/, '');
  if (o.edit) {
    const pj = `${base}.captions.json`;
    fs.writeFileSync(pj, JSON.stringify(project, null, 2));
    console.log(`  edit the words in ${pj}, then: captions --from "${pj}"`);
    continue;
  }
  const outDir = o.out || path.dirname(project.video);
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, `${path.basename(base)}.captioned.mp4`);
  const res = await exportVideo(project, output, {
    style: o.style, fillers: !o['keep-fillers'], quality: o.draft ? 'draft' : 'high',
    onProgress: (p) => process.stdout.write(`\r  rendering ${Math.round(p * 100)}%   `),
  });
  console.log(`\r  ✓ ${res.video} (+ .srt) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
