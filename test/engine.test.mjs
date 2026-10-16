import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDictionary, learn } from '../src/dictionary.mjs';
import { segment, removeFillers } from '../src/segment.mjs';
import { assTime, assColor, buildAss } from '../src/ass.mjs';
import { buildSrt } from '../src/srt.mjs';
import { resolveStyle } from '../src/styles.mjs';
import { fixTimes } from '../src/transcribe.mjs';

const W = (s, t0 = 0, d = 0.3) => s.split(' ').map((text, i) => ({ text, start: t0 + i * d, end: t0 + (i + 1) * d }));

test('dictionary merges multi-word matches and keeps punctuation', () => {
  const out = applyDictionary(W('fix your romanian dead lift.'), { 'romanian dead lift': 'Romanian deadlift' });
  assert.deepEqual(out.map((w) => w.text), ['fix', 'your', 'Romanian deadlift.']);
  assert.equal(out[2].start, 0.6); assert.equal(out[2].end, 1.5); assert.ok(out[2].fixed);
});

test('learn stores corrections', () => {
  assert.deepEqual(learn({}, 'fit lab,', 'FitLab'), { 'fit lab': 'FitLab' });
  assert.deepEqual(learn({}, 'Same', 'same'), {});
});

test('fillers removed, lines broken on punctuation and length', () => {
  const ws = removeFillers(W('um so this is great. uh and here we go again today'));
  assert.ok(!ws.some((w) => /^(um|uh)$/.test(w.text)));
  const lines = segment(ws, { maxWords: 4 });
  assert.deepEqual(lines[0].words.map((w) => w.text), ['so', 'this', 'is', 'great.']);
  for (const l of lines) assert.ok(l.words.length <= 4);
});

test('times are monotonic', () => {
  const w = fixTimes([{ text: 'a', start: 1, end: 0.5 }, { text: 'b', start: 0.2, end: 0.3 }]);
  assert.ok(w[0].end > w[0].start && w[1].start >= w[0].end);
});

test('ass helpers and output', () => {
  assert.equal(assTime(3725.456), '1:02:05.46');
  assert.equal(assColor('#FFE500'), '&H0000E5FF');
  const lines = segment(W('hello there world'));
  const ass = buildAss(lines, resolveStyle('bold'), { width: 1080, height: 1920 });
  assert.match(ass, /PlayResY: 1920/);
  assert.equal((ass.match(/^Dialogue:/gm) || []).length, 3); // one event per active word
  assert.match(ass, /HELLO/);
  assert.match(buildSrt(lines), /00:00:00,000 --> /);
});

import { alignConfidence } from '../src/transcribe.mjs';
import { flagForReview } from '../src/review.mjs';

test('confidence is aligned to words via token text, min over tokens', () => {
  const words = [{ text: 'Hey' }, { text: 'Hormozi,' }, { text: 'hi.' }];
  alignConfidence(words, [{ text: ' Hey', p: 0.9 }, { text: ' Hor', p: 0.4 }, { text: 'mo', p: 0.8 }, { text: 'zi', p: 0.7 }, { text: ',', p: 0.1 }, { text: ' hi', p: 0.95 }, { text: '.', p: 0.99 }]);
  assert.deepEqual(words.map((w) => w.confidence), [0.9, 0.4, 0.95]);
});

test('review flags unsure words, runs, and trusts dictionary fixes', () => {
  const out = flagForReview([
    { text: 'a', confidence: 0.9 }, { text: 'b', confidence: 0.3 }, { text: 'c', confidence: 0.8 },
    { text: 'd', confidence: 0.2 }, { text: 'FitLab', confidence: 0.1, fixed: true }, { text: 'e', confidence: null },
  ]);
  assert.deepEqual(out.map((w) => w.review), [false, true, true, true, false, true]);
});

import { stripPrompt, vocabularyPrompt } from '../src/transcribe.mjs';

test('vocabulary prompt dedupes and prompt echoes are stripped', () => {
  const p = vocabularyPrompt(['Hormozi', 'FitLab', 'Hormozi', ' ']);
  assert.equal(p, 'Hormozi, FitLab.');
  const ws = ['Hormozi,', 'FitLab.', 'My', 'coach', 'Hormozi', 'uses', 'Hormozi,', 'FitLab.', 'FitLab', 'rocks'].map((text) => ({ text }));
  assert.deepEqual(stripPrompt(ws, p).map((w) => w.text), ['My', 'coach', 'Hormozi', 'uses', 'FitLab', 'rocks']);
});

import { windows } from '../src/transcribe.mjs';

test('long audio is windowed under 30 s, cut at the quietest point', () => {
  const sr = 16000, a = new Float32Array(sr * 65).fill(0.5);
  a.fill(0, sr * 24, sr * 24.3); // silence at 24 s
  const w = windows(a);
  assert.ok(w.every(([s, e]) => (e - s) / sr <= 28.01));
  assert.ok(Math.abs(w[0][1] / sr - 24.15) < 0.2);
  assert.equal(w.at(-1)[1], a.length);
});
