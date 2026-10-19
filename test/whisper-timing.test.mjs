import test from 'node:test';
import assert from 'node:assert/strict';
import { timingBroken, spreadOverSegments, clampLong } from '../src/engines/whisper.mjs';

test('collapsed word times are detected and re-timed from segments', () => {
  const words = ['far', 'left', 'cartel', 'for', 'years.'].map((text) => ({ text, start: 29.92, end: 29.92 }));
  assert.equal(timingBroken(words, 24.3), true);
  spreadOverSegments(words, [{ timestamp: [0, 7.8], text: ' far left cartel for years.' }, { timestamp: [8, 12], text: ' [Cheering]' }], 10);
  assert.equal(words[0].start, 10);
  assert.ok(words.at(-1).end <= 17.81 && words.at(-1).end > 17.7);
  assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start));
});

test('healthy word times are left alone', () => {
  const words = [{ text: 'a', start: 0, end: 0.3 }, { text: 'b', start: 0.3, end: 0.6 }, { text: 'c', start: 0.6, end: 0.9 }];
  assert.equal(timingBroken(words, 20), false);
});

test('a word stretched over applause is pulled to its end', () => {
  const [w] = clampLong([{ text: 'Ladies', start: 0, end: 9.58 }]);
  assert.ok(w.start > 8.5 && w.end === 9.58);
});
