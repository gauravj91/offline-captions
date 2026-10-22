// Offline Captions license server — Cloudflare Worker + Durable Object.
// Dodo Payments (merchant of record, since 22 Oct 2026; Paddle code kept but unused) sends webhooks here; we issue Ed25519-signed license keys
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
//   DODO_ENV              "test" | "live"
//   PREORDER              "false" once the desktop app ships (key emails then say "open the app"); default pre-order copy
//   DODO_PRODUCTS         JSON {"<product_id>": "founding"|"full", ...}
// Secrets
//   DODO_WEBHOOK_SECRET   whsec_… signing key of the Dodo TEST-mode webhook endpoint (Standard Webhooks)
//   DODO_WEBHOOK_SECRET_LIVE  same, for the LIVE-mode endpoint
//   PADDLE_WEBHOOK_SECRET endpoint secret key of the Paddle notification destination
//   LICENSE_PRIVATE_KEY   base64url PKCS8 Ed25519 private key
//   WAITLIST_ADMIN_TOKEN  bearer token for GET /waitlist/export (CSV) and /waitlist/stats
//   RESEND_API_KEY        Resend sending key (domain offlinecaptions.com) for license-key emails
// Optional vars: MAIL_FROM (default "Offline Captions <keys@offlinecaptions.com>"), MAIL_REPLY_TO (default hello@offlinecaptions.com)
//
// Key layout
//   lic:<lid>    license record (JSON)        txn:<txn_id> -> lid
//   em:<email>   [lid, ...] (licenses bought with that email; used by "find my key")
//   cust:<ctm>   {email, name}                evt:<event_id> -> "1" (dedupe, 30 days)
//   wl:<segment>:<email>  waitlist signup {email, segment, intent[], page, country, first, last}

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
// Standard Webhooks (Dodo): base64 HMAC-SHA256 over `${id}.${ts}.${rawBody}`, key = base64-decoded secret minus "whsec_".
export async function verifyStandardWebhook(secret, id, ts, sigHeader, rawBody, nowSec = Date.now() / 1000, toleranceSec = 300) {
  if (!secret || !id || !ts || !sigHeader || Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${ts}.${rawBody}`)));
  let b = ""; for (const x of mac) b += String.fromCharCode(x);
  const want = btoa(b);
  return sigHeader.split(" ").some((p) => { const [v, sig] = p.split(","); return v === "v1" && sig && timingSafeEqual(sig, want); });
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
  async list(prefix) {
    const m = await this.ctx.storage.list({ prefix });
    return [...m.entries()].map(([k, r]) => [k, r.v]);
  }
}
function store(env) {
  if (!env.STORE) return env.KV;
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  return {
    // LEGACY_KV: read-only fallback for records written before the move to the Durable Object (17 Oct 2026 sandbox tests).
    get: async (k) => (await stub.get(k)) ?? (env.LEGACY_KV && !k.startsWith("evt:") ? await env.LEGACY_KV.get(k) : null),
    put: (k, v, opts = {}) => stub.put(k, v, opts.expirationTtl || null),
    list: (prefix) => stub.list(prefix) };
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

// Provider-neutral issue (Dodo). `o` = {txn, tier, email, customer_id, product_id, currency, total, country, provider}
async function issueLicenseFor(env, o) {
  const existing = await store(env).get(`txn:${o.txn}`);
  if (existing) return getJSON(env, `lic:${existing}`);
  const lid = newId(); const iat = Math.floor(Date.now() / 1000);
  const email = o.email ? String(o.email).toLowerCase() : null;
  const key = await signToken(env, "OC1", { l: lid, t: o.tier, i: iat, ...(email ? { e: email } : {}) });
  const rec = { lid, key, tier: o.tier, status: "active", created: new Date().toISOString(), provider: o.provider,
    txn: o.txn, customer_id: o.customer_id || null, email, price_id: o.product_id || null, currency: o.currency || null,
    total: o.total ?? null, country: o.country || null, devices: [] };
  await putJSON(env, `lic:${lid}`, rec);
  await store(env).put(`txn:${o.txn}`, lid);
  if (email) await indexEmail(env, email, lid);
  rec.isNew = true;
  return rec;
}

async function indexEmail(env, email, lid) {
  const k = `em:${email.toLowerCase()}`; const list = (await getJSON(env, k)) || [];
  if (!list.includes(lid)) { list.push(lid); await putJSON(env, k, list); }
}

// ---------- email (Resend) ----------
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TIER_NAME = { founding: "Founding license", full: "Full license" };
export function keyEmail(recs, kind, preorder = false) {
  const many = recs.length > 1;
  const subject = kind === "purchase" ? "Your Offline Captions license key" : many ? "Your Offline Captions license keys" : "Your Offline Captions license key";
  const intro = kind === "purchase" ? (preorder ? "Thanks for buying Offline Captions at the founding price. Here's your license key." : "Thanks for buying Offline Captions. Here's your license key.") : `You asked us to resend your license key${many ? "s" : ""}.`;
  const pre = preorder ? "Windows: download the app at https://offlinecaptions.com/download/windows , open it, click Activate and paste the key. If Windows says \"unknown publisher\", click More info, then Run anyway.\nMac: coming soon. We'll email you the download at this address the day it's ready." : "";
  const preHtml = preorder ? `<p><b>Windows:</b> <a href="https://offlinecaptions.com/download/windows">download the app</a>, open it, click <b>Activate</b> and paste the key. If Windows says "unknown publisher", click <b>More info</b>, then <b>Run anyway</b>.</p><p><b>Mac:</b> coming soon. We'll email you the download at this address the day it's ready.</p>` : "";
  const blocks = recs.map((r) => ({ name: TIER_NAME[r.tier] || "License", key: r.key, date: (r.created || "").slice(0, 10) }));
  const text = [intro, "", ...blocks.flatMap((b) => [`${b.name}${b.date ? ` (bought ${b.date})` : ""}:`, b.key, ""]),
    ...(preorder ? [pre, ""] : ["To activate: open Offline Captions, click Activate, and paste the key.", "Get the app: https://offlinecaptions.com/"]),
    "Find your key again any time: https://offlinecaptions.com/find-my-key/",
    ...(kind === "purchase" ? ["Changed your mind? Full refund within 14 days: just reply to this email."] : []),
    "", "Questions? Just reply to this email.", "", "Offline Captions"].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#111;line-height:1.5">
<h2 style="margin:0 0 12px">Offline Captions</h2><p>${escHtml(intro)}</p>
${blocks.map((b) => `<p style="margin:16px 0 6px"><b>${escHtml(b.name)}</b>${b.date ? ` <span style="color:#666">(bought ${b.date})</span>` : ""}</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f4;border:1px solid #ddd;border-radius:8px;padding:12px;font-size:13px">${escHtml(b.key)}</pre>`).join("")}
${preorder ? preHtml : `<p>To activate: open Offline Captions, click <b>Activate</b>, and paste the key.</p>`}
<p>${preorder ? "" : `<a href="https://offlinecaptions.com/">Get the app</a> · `}<a href="https://offlinecaptions.com/find-my-key/">Find your key again</a></p>
${kind === "purchase" ? `<p style="color:#666">Changed your mind? Full refund within 14 days: just reply to this email.</p>` : ""}
<p style="color:#666">Questions? Just reply to this email.</p></div>`;
  return { subject, text, html };
}
async function sendMail(env, to, { subject, text, html }) {
  if (!env.RESEND_API_KEY) return { skipped: "no_resend_key" };
  const r = await (env.FETCH || fetch)("https://api.resend.com/emails", { method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "Offline Captions <keys@offlinecaptions.com>", to: [to],
      reply_to: env.MAIL_REPLY_TO || "hello@offlinecaptions.com", subject, text, html }) });
  if (!r.ok) { console.error("resend", r.status, await r.text()); return { error: r.status }; }
  return { ok: true };
}
async function emailNewLicense(env, rec) {
  if (!rec.email) return;
  try {
    const res = await sendMail(env, rec.email, keyEmail([rec], "purchase", env.PREORDER !== "false"));
    if (res.ok) { const cur = await getJSON(env, `lic:${rec.lid}`); cur.emailed_at = new Date().toISOString(); await putJSON(env, `lic:${rec.lid}`, cur); }
  } catch (e) { console.error("email", e); }
}

// POST /api/recover {email}: emails every active key bought with that address. Always answers {ok:true}
// so the endpoint can't be used to learn who bought. One email per address per 10 minutes.
async function handleRecover(req, env) {
  let b; try { b = await readBody(req); } catch { return json({ error: "bad_body" }, 400); }
  const email = String(b.get("email") || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  if (await store(env).get(`rl:${email}`)) return json({ ok: true });
  await store(env).put(`rl:${email}`, "1", { expirationTtl: 600 });
  let lids = (await getJSON(env, `em:${email}`)) || [];
  if (!lids.length && store(env).list) // licenses issued before the email index existed
    lids = (await store(env).list("lic:")).map(([, v]) => JSON.parse(v)).filter((r) => (r.email || "").toLowerCase() === email).map((r) => r.lid);
  const recs = [];
  for (const lid of lids) { const r = await getJSON(env, `lic:${lid}`); if (r && r.status === "active") recs.push(r); }
  if (recs.length) await sendMail(env, email, keyEmail(recs, "recover", env.PREORDER !== "false"));
  return json({ ok: true });
}

async function handleDodoWebhook(req, env) {
  const raw = await req.text();
  const id = req.headers.get("webhook-id"), ts = req.headers.get("webhook-timestamp");
  const sigH = req.headers.get("webhook-signature");
  // Test-mode and live-mode endpoints each have their own signing key; accept either.
  const isLive = await verifyStandardWebhook(env.DODO_WEBHOOK_SECRET_LIVE, id, ts, sigH, raw);
  const isTest = !isLive && (await verifyStandardWebhook(env.DODO_WEBHOOK_SECRET, id, ts, sigH, raw));
  if (!isLive && !isTest) return json({ error: "bad_signature" }, 401);
  // Once live, test-mode payments must not mint keys that work in the real app.
  if (isTest && env.DODO_ENV === "live") return json({ ok: true, result: "test_mode_ignored" });
  if (await store(env).get(`evt:${id}`)) return json({ ok: true, duplicate: true });
  const evt = JSON.parse(raw); const d = evt.data || {};
  let products = {}; try { products = JSON.parse(env.DODO_PRODUCTS || "{}"); } catch {}
  let result = "ignored";
  switch (evt.type) {
    case "payment.succeeded": {
      const pid = d.product_cart?.[0]?.product_id || null;
      const tier = d.metadata?.tier === "founding" || d.metadata?.tier === "full" ? d.metadata.tier : products[pid] || "full";
      if (pid && Object.keys(products).length && !products[pid]) { result = "other_product"; break; }
      const rec = await issueLicenseFor(env, { provider: "dodo", txn: d.payment_id, tier, email: d.customer?.email,
        customer_id: d.customer?.customer_id, product_id: pid, currency: d.currency, total: d.total_amount, country: d.billing?.country });
      if (d.customer?.customer_id) await putJSON(env, `cust:${d.customer.customer_id}`, { email: d.customer.email, name: d.customer.name || null });
      if (rec.isNew) await emailNewLicense(env, rec);
      result = `license:${rec.lid}`;
      break;
    }
    case "refund.succeeded": {
      const lid = d.payment_id && (await store(env).get(`txn:${d.payment_id}`));
      if (!lid) { result = "no_license"; break; }
      const rec = await getJSON(env, `lic:${lid}`);
      const full = d.is_partial === false || (d.is_partial == null && rec.total != null && Number(d.amount) >= Number(rec.total));
      if (full) { await setStatusByTxn(env, d.payment_id, "revoked", "refund"); result = "revoked"; }
      else result = "partial_refund_kept";
      break;
    }
    case "dispute.opened":
    case "dispute.lost":
    case "dispute.accepted":
    case "dispute.expired":
      if (d.payment_id && (await setStatusByTxn(env, d.payment_id, "revoked", evt.type))) result = "revoked";
      break;
    case "dispute.won":
    case "dispute.cancelled":
      if (d.payment_id) {
        const lid = await store(env).get(`txn:${d.payment_id}`);
        const rec = lid && (await getJSON(env, `lic:${lid}`));
        if (rec && rec.status === "revoked" && String(rec.status_reason || "").startsWith("dispute")) {
          await setStatusByTxn(env, d.payment_id, "active", evt.type); result = "restored";
        }
      }
      break;
  }
  await store(env).put(`evt:${id}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true, result });
}

// Local price shown on the site, by visitor country (Cloudflare geo). Mirrors the Dodo by_currency rules.
const EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
const PRICES = { USD: { founding: "$29", full: "$39" }, INR: { founding: "₹1,499", full: "₹1,999" },
  EUR: { founding: "€29", full: "€39" }, GBP: { founding: "£25", full: "£35" }, CAD: { founding: "$29", full: "C$49" }, AUD: { founding: "$29", full: "A$59" } };
export function priceFor(country) {
  const cur = country === "IN" ? "INR" : EURO.includes(country) ? "EUR" : country === "GB" ? "GBP" : country === "CA" ? "CAD" : country === "AU" ? "AUD" : "USD";
  // CAD/AUD have no founding-price rule, so the founding checkout is forced to USD there.
  return { country: country || null, currency: cur, founding_currency: PRICES[cur].founding.startsWith("$") ? "USD" : cur, ...PRICES[cur] };
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


// ---------- waitlist ----------
// POST /waitlist from the landing forms (form-encoded or JSON). JS clients get JSON; a plain
// form post is redirected back to the page with #joined. Segments are a fixed list so the
// public endpoint can't be used to write arbitrary keys.
const SEGMENTS = ["launch", "launch-hinglish", "shorts-studio", "shorts-studio-hinglish"];
const INTENTS = ["upgrade40", "bundle79"];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

async function readBody(req) {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const b = await req.json();
    return { get: (k) => (Array.isArray(b[k]) ? b[k][0] : b[k]), getAll: (k) => [].concat(b[k] ?? []) };
  }
  const f = await req.formData();
  return { get: (k) => f.get(k), getAll: (k) => f.getAll(k) };
}

async function handleWaitlist(req, env) {
  const wantsJson = (req.headers.get("accept") || "").includes("application/json");
  let b; try { b = await readBody(req); } catch { return json({ error: "bad_body" }, 400); }
  const back = (ok) => {
    if (wantsJson) return json(ok ? { ok: true } : { error: "invalid_email" }, ok ? 200 : 400);
    const ref = req.headers.get("referer");
    if (!ref) return json(ok ? { ok: true } : { error: "invalid_email" }, ok ? 200 : 400);
    const u = new URL(ref); u.hash = ok ? "joined" : "waitlist-error";
    return new Response(null, { status: 303, headers: { location: u.toString() } });
  };
  if (b.get("_gotcha")) return back(true); // honeypot: pretend success
  const email = String(b.get("email") || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return back(false);
  const segment = SEGMENTS.includes(b.get("segment")) ? b.get("segment") : "launch";
  const intent = [...new Set(b.getAll("intent").map(String).filter((x) => INTENTS.includes(x)))];
  const page = String(b.get("page") || "").slice(0, 120);
  const k = `wl:${segment}:${email}`;
  const prev = await getJSON(env, k);
  const now = new Date().toISOString();
  const rec = { email, segment, intent: [...new Set([...(prev?.intent || []), ...intent])], page: prev?.page || page,
                country: req.cf?.country || prev?.country || null, first: prev?.first || now, last: now };
  await putJSON(env, k, rec);
  return back(true);
}

async function waitlistRows(env) {
  const s = store(env);
  // Test signups made with @example.com addresses are left out.
  if (s.list) return (await s.list("wl:")).map(([, v]) => JSON.parse(v)).filter((r) => !r.email.endsWith("@example.com"));
  return []; // test KV without list support
}

async function handleWaitlistAdmin(req, env, path) {
  const auth = req.headers.get("authorization") || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("token");
  if (!env.WAITLIST_ADMIN_TOKEN || !tok || !timingSafeEqual(tok, env.WAITLIST_ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
  const rows = await waitlistRows(env);
  if (path === "/waitlist/stats") {
    const seg = {}; const intent = {};
    for (const r of rows) { seg[r.segment] = (seg[r.segment] || 0) + 1; for (const i of r.intent || []) intent[`${r.segment}:${i}`] = (intent[`${r.segment}:${i}`] || 0) + 1; }
    return json({ total: rows.length, segments: seg, intent });
  }
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["email,segment,intent,page,country,first,last",
    ...rows.map((r) => [r.email, r.segment, (r.intent || []).join(" "), r.page, r.country, r.first, r.last].map(q).join(","))].join("\n");
  return new Response(csv + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=waitlist.csv" } });
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
      if (url.pathname === "/health") return json({ ok: true, provider: "dodo", env: env.DODO_ENV || "unknown" });
      if (url.pathname === "/webhooks/dodo" && req.method === "POST") return await handleDodoWebhook(req, env);
      if (url.pathname === "/api/price" && req.method === "GET") return json(priceFor(req.cf?.country), 200, { ...c, "cache-control": "private, max-age=3600" });
      if (url.pathname === "/webhooks/paddle" && req.method === "POST") return await handleWebhook(req, env);
      if (url.pathname === "/waitlist" && req.method === "POST") {
        const r = await handleWaitlist(req, env);
        for (const [k, v] of Object.entries(c)) r.headers.set(k, v);
        return r;
      }
      if ((url.pathname === "/waitlist/export" || url.pathname === "/waitlist/stats") && req.method === "GET")
        return await handleWaitlistAdmin(req, env, url.pathname);
      if (url.pathname === "/api/recover" && req.method === "POST") {
        const r = await handleRecover(req, env);
        for (const [k, v] of Object.entries(c)) r.headers.set(k, v);
        return r;
      }
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
