// Offline Captions license server — Cloudflare Worker + KV.
// Paddle (merchant of record) sends webhooks here; we issue Ed25519-signed license keys
// that the desktop app verifies offline, and track device activations in KV.
//
// Bindings
//   STORE                 Durable Object namespace for class Store (SQLite-backed, strongly consistent)
//   KV                    (tests only) Map-backed stand-in used when STORE is absent
// Vars (plain text)
//   PADDLE_ENV            "sandbox" | "production"
//   DEVICE_LIMIT          max active devices per license (default 2)
//   ALLOWED_ORIGINS       comma-separated origins allowed to call /api/* from a browser ("*" = any)
//   LICENSE_PUBLIC_KEY    base64url raw Ed25519 public key (also baked into the desktop app)
// Secrets
//   PADDLE_WEBHOOK_SECRET endpoint secret key of the Paddle notification destination
//   LICENSE_PRIVATE_KEY   base64url PKCS8 Ed25519 private key
//
// Key layout
//   lic:<lid>    license record (JSON)        txn:<txn_id> -> lid
//   cust:<ctm>   {email, name}                evt:<event_id> -> "1" (dedupe, 30 days)

import { DurableObject } from "cloudflare:workers";

const enc = new TextEncoder();
const b64u = {
  enc(bytes) {
    let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });

function cors(req, env) {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS",
           "access-control-allow-headers": "content-type", vary: "origin" };
}

// ---------- crypto ----------
let _priv, _pub;
async function privKey(env) {
  return (_priv ??= await crypto.subtle.importKey("pkcs8", b64u.dec(env.LICENSE_PRIVATE_KEY), { name: "Ed25519" }, false, ["sign"]));
}
async function pubKey(env) {
  return (_pub ??= await crypto.subtle.importKey("raw", b64u.dec(env.LICENSE_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]));
}
export async function signToken(env, prefix, payload) {
  const body = b64u.enc(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await privKey(env), enc.encode(`${prefix}.${body}`));
  return `${prefix}.${body}.${b64u.enc(sig)}`;
}
export async function verifyToken(env, token, prefix) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, await pubKey(env), b64u.dec(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64u.dec(parts[1]))); } catch { return null; }
}

// Paddle-Signature: ts=1671552777;h1=eb4d0dc8... ; HMAC-SHA256 over `${ts}:${rawBody}`
export async function verifyPaddleSignature(secret, header, rawBody, nowSec = Date.now() / 1000, toleranceSec = 300) {
  if (!secret || !header) return false;
  const kv = Object.fromEntries(header.split(";").map((p) => p.split("=").map((s) => s.trim())));
  const ts = kv.ts; const sigs = header.split(";").filter((p) => p.trim().startsWith("h1=")).map((p) => p.trim().slice(3));
  if (!ts || !sigs.length || Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}:${rawBody}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, hex));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- storage ----------
// One SQLite-backed Durable Object ("Store") holds all records. It is strongly consistent, unlike
// Workers KV, whose edge caching (including cached "not found" results) made the thank-you page
// miss keys issued seconds earlier. Tests pass a Map-backed KV instead (env.KV).
export class Store extends DurableObject {
  async get(k) {
    const r = await this.ctx.storage.get(k);
    if (!r) return null;
    if (r.exp && r.exp < Date.now() / 1000) { await this.ctx.storage.delete(k); return null; }
    return r.v;
  }
  async put(k, v, ttl) {
    await this.ctx.storage.put(k, { v, exp: ttl ? Math.floor(Date.now() / 1000) + ttl : null });
  }
}
function store(env) {
  if (!env.STORE) return env.KV;
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  return {
    // LEGACY_KV: read-only fallback for records written before the move to the Durable Object (17 Oct 2026 sandbox tests).
    get: async (k) => (await stub.get(k)) ?? (env.LEGACY_KV && !k.startsWith("evt:") ? await env.LEGACY_KV.get(k) : null),
    put: (k, v, opts = {}) => stub.put(k, v, opts.expirationTtl || null) };
}

const getJSON = async (env, k) => { const v = await store(env).get(k); return v ? JSON.parse(v) : null; };
const putJSON = (env, k, v, opts) => store(env).put(k, JSON.stringify(v), opts);
const newId = () => b64u.enc(crypto.getRandomValues(new Uint8Array(12)));

async function issueLicense(env, txn) {
  const existing = await store(env).get(`txn:${txn.id}`);
  if (existing) return getJSON(env, `lic:${existing}`);
  const item = txn.items?.[0] || {};
  const tier = item.price?.custom_data?.tier || "full";
  const cust = txn.customer_id ? await getJSON(env, `cust:${txn.customer_id}`) : null;
  const lid = newId();
  const iat = Math.floor(Date.now() / 1000);
  const key = await signToken(env, "OC1", { l: lid, t: tier, i: iat, ...(cust?.email ? { e: cust.email } : {}) });
  const rec = {
    lid, key, tier, status: "active", created: new Date().toISOString(),
    txn: txn.id, customer_id: txn.customer_id || null, email: cust?.email || null,
    price_id: item.price?.id || null, currency: txn.currency_code || null,
    total: txn.details?.totals?.grand_total || null, country: txn.address?.country_code || null,
    devices: [],
  };
  await putJSON(env, `lic:${lid}`, rec);
  await store(env).put(`txn:${txn.id}`, lid);
  return rec;
}

async function setStatusByTxn(env, txnId, status, reason) {
  const lid = await store(env).get(`txn:${txnId}`);
  if (!lid) return null;
  const rec = await getJSON(env, `lic:${lid}`);
  rec.status = status; rec.status_reason = reason; rec.status_at = new Date().toISOString();
  await putJSON(env, `lic:${lid}`, rec);
  return rec;
}

// ---------- webhook ----------
async function handleWebhook(req, env) {
  const raw = await req.text();
  if (!(await verifyPaddleSignature(env.PADDLE_WEBHOOK_SECRET, req.headers.get("paddle-signature"), raw)))
    return json({ error: "bad_signature" }, 401);
  const evt = JSON.parse(raw);
  if (evt.event_id && (await store(env).get(`evt:${evt.event_id}`))) return json({ ok: true, duplicate: true });
  const d = evt.data || {};
  let result = "ignored";
  switch (evt.event_type) {
    case "customer.created":
    case "customer.updated":
      await putJSON(env, `cust:${d.id}`, { email: d.email, name: d.name || null });
      // back-fill email on licenses issued before the customer event arrived
      result = "customer_saved";
      break;
    case "transaction.completed":
    case "transaction.paid": {
      if (evt.event_type === "transaction.paid" || d.status === "completed" || d.status === "paid") {
        const rec = await issueLicense(env, d);
        result = rec ? `license:${rec.lid}` : "no_license";
      }
      break;
    }
    case "adjustment.created":
    case "adjustment.updated":
      if ((d.action === "refund" || d.action === "chargeback" || d.action === "chargeback_warning") && d.status === "approved" && d.transaction_id) {
        const full = d.type === "full" || d.action !== "refund";
        if (full) { await setStatusByTxn(env, d.transaction_id, "revoked", d.action); result = "revoked"; }
        else result = "partial_refund_kept";
      }
      break;
  }
  if (evt.event_id) await store(env).put(`evt:${evt.event_id}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true, result });
}

// ---------- public API ----------
async function licenseFromKey(env, key) {
  const p = await verifyToken(env, key, "OC1");
  if (!p) return { error: "invalid_key" };
  const rec = await getJSON(env, `lic:${p.l}`);
  if (!rec) return { error: "unknown_license" };
  return { rec };
}

async function handleApi(req, env, path) {
  const limit = Number(env.DEVICE_LIMIT || 2);
  if (req.method === "GET" && path === "/api/license") {
    // Used by the thank-you page right after checkout. Needs the transaction id from Paddle.js
    // plus the buyer's email when Paddle has told us the email.
    const u = new URL(req.url);
    const txn = u.searchParams.get("txn"); const email = (u.searchParams.get("email") || "").toLowerCase();
    if (!txn) return json({ error: "missing_txn" }, 400);
    const lid = await store(env).get(`txn:${txn}`);
    if (!lid) return json({ status: "pending" }, 202);
    const rec = await getJSON(env, `lic:${lid}`);
    const knownEmail = rec.email || (rec.customer_id && (await getJSON(env, `cust:${rec.customer_id}`))?.email);
    if (knownEmail && email && knownEmail.toLowerCase() !== email) return json({ error: "email_mismatch" }, 403);
    return json({ status: rec.status, key: rec.key, tier: rec.tier, email: knownEmail || null, device_limit: limit });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { key, device_id, device_name } = body || {};
  if (!key || !device_id || String(device_id).length > 128) return json({ error: "missing_fields" }, 400);
  const { rec, error } = await licenseFromKey(env, key);
  if (error) return json({ error }, error === "invalid_key" ? 400 : 404);
  const now = Math.floor(Date.now() / 1000);

  if (path === "/api/activate") {
    if (rec.status !== "active") return json({ error: "license_" + rec.status }, 403);
    let dev = rec.devices.find((x) => x.id === device_id);
    if (!dev) {
      if (rec.devices.length >= limit)
        return json({ error: "device_limit", limit, devices: rec.devices.map(({ id, name, at }) => ({ id, name, at })) }, 409);
      dev = { id: device_id, name: String(device_name || "").slice(0, 80), at: new Date().toISOString() };
      rec.devices.push(dev);
      await putJSON(env, `lic:${rec.lid}`, rec);
    }
    const activation = await signToken(env, "OCA1", { l: rec.lid, d: device_id, i: now, t: rec.tier });
    return json({ ok: true, activation, tier: rec.tier, email: rec.email, devices_used: rec.devices.length, device_limit: limit });
  }
  if (path === "/api/deactivate") {
    const before = rec.devices.length;
    rec.devices = rec.devices.filter((x) => x.id !== device_id);
    if (rec.devices.length !== before) await putJSON(env, `lic:${rec.lid}`, rec);
    return json({ ok: true, devices_used: rec.devices.length, device_limit: limit });
  }
  if (path === "/api/validate") {
    const active = rec.devices.some((x) => x.id === device_id);
    return json({ ok: rec.status === "active" && active, status: rec.status, activated_here: active, tier: rec.tier });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
    try {
      if (url.pathname === "/health") return json({ ok: true, env: env.PADDLE_ENV || "unknown" });
      if (url.pathname === "/webhooks/paddle" && req.method === "POST") return await handleWebhook(req, env);
      if (url.pathname.startsWith("/api/")) {
        const r = await handleApi(req, env, url.pathname);
        for (const [k, v] of Object.entries(c)) r.headers.set(k, v);
        return r;
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500, c);
    }
  },
};
