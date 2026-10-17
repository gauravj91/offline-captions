import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyToken, licenseStatus, activate, deactivate, revalidate, deviceId, normalizeKey } from '../src/license.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
const tok = (prefix, payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${prefix}.${body}.${crypto.sign(null, Buffer.from(`${prefix}.${body}`), privateKey).toString('base64url')}`;
};
const KEY = tok('OC1', { l: 'lic1', t: 'full', i: 1, e: 'a@b.co' });
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lic-')), 'license.json');
const fakeFetch = (routes) => async (url, init) => {
  const r = routes[new URL(url).pathname](JSON.parse(init.body));
  return { status: r[0], json: async () => r[1] };
};

test('verifies signed keys and rejects tampering', () => {
  assert.equal(verifyToken(KEY, 'OC1', pub).l, 'lic1');
  assert.equal(verifyToken(KEY.replace('.', '.x'), 'OC1', pub), null);
  assert.equal(verifyToken(KEY, 'OCA1', pub), null);
  assert.equal(normalizeKey(` "${KEY.slice(0, 10)}\n${KEY.slice(10)}" `), KEY);
});

test('activate -> licensed offline; revoked on revalidate; deactivate clears', async () => {
  const fetchImpl = fakeFetch({
    '/api/activate': (b) => [200, { activation: tok('OCA1', { l: 'lic1', d: b.device_id, i: 2 }), email: 'a@b.co', device_limit: 2 }],
    '/api/validate': () => [200, { status: 'revoked', activated_here: true }],
    '/api/deactivate': () => [200, { ok: true }],
  });
  const s = await activate(file, KEY, { fetchImpl, pub, api: 'https://t' });
  assert.equal(s.licensed, true); assert.equal(s.email, 'a@b.co');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(licenseStatus(stored, { pub }).licensed, true);
  assert.equal(licenseStatus(stored, { pub, device: 'other' }).reason, 'not_activated'); // copied file doesn't work elsewhere
  assert.equal((await revalidate(file, { fetchImpl, pub, api: 'https://t' })).licensed, true); // not due yet
  assert.equal((await revalidate(file, { fetchImpl, pub, api: 'https://t', force: true })).reason, 'revoked');
  assert.equal((await deactivate(file, { fetchImpl, api: 'https://t' })).licensed, false);
  assert.equal(fs.existsSync(file), false);
});

test('device limit error is friendly; offline revalidate keeps license', async () => {
  const limited = fakeFetch({ '/api/activate': () => [409, { error: 'device_limit', limit: 2 }] });
  await assert.rejects(activate(file, KEY, { fetchImpl: limited, pub, api: 'https://t' }), /maximum number of computers/);
  const ok = fakeFetch({ '/api/activate': (b) => [200, { activation: tok('OCA1', { l: 'lic1', d: b.device_id, i: 2 }) }] });
  await activate(file, KEY, { fetchImpl: ok, pub, api: 'https://t' });
  const offline = async () => { throw new Error('ENOTFOUND'); };
  assert.equal((await revalidate(file, { fetchImpl: offline, pub, api: 'https://t', force: true })).licensed, true);
  assert.equal(deviceId(), deviceId());
});
