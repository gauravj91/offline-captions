// Personal dictionary: corrections the creator made once are applied to every
// future video. Entries map what the model hears to what should be shown.
//   { "romanian dead lift": "Romanian deadlift", "fit lab": "FitLab" }
// Matching is case-insensitive, ignores punctuation, and may span words.
import fs from 'node:fs';

export function loadDictionary(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveDictionary(file, dict) {
  fs.writeFileSync(file, JSON.stringify(dict, null, 2) + '\n');
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/** Replaces matched word runs; merged words keep the first start and last end. */
export function applyDictionary(words, dict) {
  const entries = Object.entries(dict)
    .map(([from, to]) => ({ from: from.split(/\s+/).map(norm).filter(Boolean), to }))
    .filter((e) => e.from.length)
    .sort((a, b) => b.from.length - a.from.length);
  if (!entries.length) return words;

  const out = [];
  for (let i = 0; i < words.length; ) {
    const hit = entries.find((e) => e.from.every((f, k) => words[i + k] && norm(words[i + k].text) === f));
    if (!hit) { out.push(words[i++]); continue; }
    const run = words.slice(i, i + hit.from.length);
    const trail = run.at(-1).text.match(/[^\p{L}\p{N}']+$/u)?.[0] || '';
    out.push({ text: hit.to + trail, start: run[0].start, end: run.at(-1).end, fixed: true });
    i += hit.from.length;
  }
  return out;
}

/** Learns from an edit: if the user changed `before` to `after`, remember it. */
export function learn(dict, before, after) {
  const strip = (s) => s.trim().replace(/[.,!?;:]+$/, '');
  const b = strip(before), a = strip(after);
  // Case-only changes are not learned (that's just sentence position);
  // spacing or spelling changes ("fit lab" -> "FitLab") are.
  if (b && a && b.toLowerCase() !== a.toLowerCase()) dict[b.toLowerCase()] = a;
  return dict;
}
