// License keys for the desktop app.
// Keys are issued by the license server (server/src/worker.js) after a Paddle purchase and are
// Ed25519-signed, so the app checks them offline. Activating binds the key to this computer
// (server enforces the device limit) and returns a signed activation token we keep locally.
// The app re-validates online at most every REVALIDATE_DAYS; being offline never locks anyone out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LICENSE_API = process.env.CAPTIONS_LICENSE_API || 'https://offline-captions-api.hirewire.workers.dev';
// Public half of the signing key (sandbox key; replace when switching Paddle to live).
export const LICENSE_PUBLIC_KEY = process.env.CAPTIONS_LICENSE_PUBKEY || 'V2fTkx0uJFZxFCCeSG_0VkzIi7mEv5F4AYsU51FPQ44';
export const REVALIDATE_DAYS = 14;

const b64uDec = (s) => Buffer.from(s, 'base64url');

let _pub = null;
function publicKey(pubB64u = LICENSE_PUBLIC_KEY) {
  if (_pub && _pub.raw === pubB64u) return _pub.key;
  // Wrap the raw 32-byte key in an SPKI header so node:crypto can load it.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), b64uDec(pubB64u)]);
  _pub = { raw: pubB64u, key: crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }) };
  return _pub.key;
}

/** Verify a signed token ("PREFIX.payload.sig"). Returns the payload or null. */
export function verifyToken(token, prefix, pubB64u) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  try {
    const ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey(pubB64u), b64uDec(parts[2]));
    return ok ? JSON.parse(b64uDec(parts[1]).toString('utf8')) : null;
  } catch { return null; }
}

/** Light clean-up of a pasted key (spaces, line breaks, quotes). */
export const normalizeKey = (k) => String(k || '').replace(/[\s"'<>]/g, '');

/** Stable, anonymous id for this computer (hash only; nothing identifying leaves the machine). */
export function deviceId() {
  const macs = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00').map((n) => n.mac).sort();
  const seed = [os.hostname(), os.platform(), os.arch(), os.userInfo().username, macs[0] || ''].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
export const deviceName = () => `${os.hostname()} (${os.platform() === 'darwin' ? 'Mac' : os.platform() === 'win32' ? 'Windows' : os.platform()})`;

// ---------- local store ----------
export function loadLicense(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function saveLicense(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Offline status from what is stored. */
export function licenseStatus(stored, { device = deviceId(), pub } = {}) {
  if (!stored?.key) return { licensed: false, reason: 'none' };
  const k = verifyToken(stored.key, 'OC1', pub);
  if (!k) return { licensed: false, reason: 'invalid_key' };
  if (stored.revoked) return { licensed: false, reason: 'revoked', email: k.e || stored.email || null };
  const a = verifyToken(stored.activation, 'OCA1', pub);
  if (!a || a.l !== k.l || a.d !== device) return { licensed: false, reason: 'not_activated', email: k.e || null };
  return { licensed: true, tier: k.t, email: k.e || stored.email || null, licenseId: k.l, activatedAt: a.i };
}

async function post(api, route, body, fetchImpl) {
  const r = await fetchImpl(api + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const ERRORS = {
  invalid_key: "That doesn't look like an Offline Captions key. Copy it again from your purchase email.",
  unknown_license: "We couldn't find that license. If you just bought it, wait a minute and try again.",
  license_revoked: 'This license was refunded, so it no longer works.',
  device_limit: 'This key is already active on the maximum number of computers. Deactivate one first.',
};

export async function activate(file, rawKey, { api = LICENSE_API, fetchImpl = fetch, pub } = {}) {
  const key = normalizeKey(rawKey);
  if (!verifyToken(key, 'OC1', pub)) throw Object.assign(new Error(ERRORS.invalid_key), { code: 'invalid_key' });
  const device = deviceId();
  let res;
  try { res = await post(api, '/api/activate', { key, device_id: device, device_name: deviceName() }, fetchImpl); }
  catch { throw Object.assign(new Error('Activation needs an internet connection once. Check your connection and try again.'), { code: 'offline' }); }
  if (res.status !== 200) {
    const code = res.data.error || 'server_error';
    throw Object.assign(new Error(ERRORS[code] || 'Activation failed. Please try again or contact support.'), { code, details: res.data });
  }
  const stored = { key, activation: res.data.activation, email: res.data.email || null, checkedAt: Date.now(), deviceLimit: res.data.device_limit };
  saveLicense(file, stored);
  return licenseStatus(stored, { device, pub });
}

export async function deactivate(file, { api = LICENSE_API, fetchImpl = fetch } = {}) {
  const stored = loadLicense(file);
  if (stored?.key) {
    try { await post(api, '/api/deactivate', { key: stored.key, device_id: deviceId() }, fetchImpl); } catch {}
  }
  try { fs.unlinkSync(file); } catch {}
  return { licensed: false, reason: 'none' };
}

/** Background re-check. Only a definite "revoked" answer changes anything; network errors are ignored. */
export async function revalidate(file, { api = LICENSE_API, fetchImpl = fetch, force = false, pub } = {}) {
  const stored = loadLicense(file);
  if (!stored?.key) return licenseStatus(stored, { pub });
  if (!force && Date.now() - (stored.checkedAt || 0) < REVALIDATE_DAYS * 864e5) return licenseStatus(stored, { pub });
  try {
    const { status, data } = await post(api, '/api/validate', { key: stored.key, device_id: deviceId() }, fetchImpl);
    if (status === 200) {
      stored.checkedAt = Date.now();
      if (data.status === 'revoked') stored.revoked = true;
      if (data.status === 'active' && !data.activated_here) stored.activation = null; // deactivated from elsewhere
      saveLicense(file, stored);
    }
  } catch {}
  return licenseStatus(stored, { pub });
}
