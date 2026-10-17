import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelPlan, modelStatus } from '../src/models.mjs';

test('model plan picks the engine and its files', () => {
  assert.equal(modelPlan({ language: 'en' }).engine, 'parakeet');
  assert.equal(modelPlan({}).files.length, 4);
  const hs = modelPlan({ language: 'hinglish', quality: 'fast' });
  assert.equal(hs.engine, 'hinglish'); assert.equal(hs.approxMB, 350); assert.equal(hs.files.length, 5);
  assert.equal(modelPlan({ language: 'hinglish', quality: 'accurate' }).approxMB, 1200);
  const w = modelPlan({ language: 'de', quality: 'fast' });
  assert.ok(w.managed && /whisper-base/.test(w.model));
});

test('model status sees files on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const prev = process.env.CAPTIONS_MODEL_DIR;
  process.env.CAPTIONS_MODEL_DIR = dir;
  try {
    const plan = modelPlan({ language: 'hinglish' });
    assert.equal(modelStatus({ language: 'hinglish' }).ready, false);
    for (const f of plan.files) { fs.mkdirSync(path.dirname(f.dest), { recursive: true }); fs.writeFileSync(f.dest, 'x'); }
    assert.equal(modelStatus({ language: 'hinglish' }).ready, true);
  } finally {
    if (prev === undefined) delete process.env.CAPTIONS_MODEL_DIR; else process.env.CAPTIONS_MODEL_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
