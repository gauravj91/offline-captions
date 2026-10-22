import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./cf-loader.mjs", import.meta.url); // stubs the "cloudflare:workers" module outside Workers
const { default: worker, verifyPaddleSignature } = await import("../src/worker.js");

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64u = (b) => Buffer.from(b).toString("base64url");
const store = new Map();
const env = {
  KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v),
        list: async (p) => [...store.entries()].filter(([k]) => k.startsWith(p)) },
  WAITLIST_ADMIN_TOKEN: "admintok",
  PADDLE_WEBHOOK_SECRET: "whsec_test", DEVICE_LIMIT: "2", ALLOWED_ORIGINS: "*", PADDLE_ENV: "test",
  LICENSE_PRIVATE_KEY: b64u(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
  LICENSE_PUBLIC_KEY: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)),
};
async function sign(raw, ts = Math.floor(Date.now() / 1000)) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PADDLE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${ts}:${raw}`))).toString("hex");
  return `ts=${ts};h1=${h}`;
}
async function hook(evt, sigOverride) {
  const raw = JSON.stringify(evt);
  return worker.fetch(new Request("https://x/webhooks/paddle", { method: "POST", body: raw, headers: { "paddle-signature": sigOverride ?? await sign(raw) } }), env);
}
const post = (p, b) => worker.fetch(new Request("https://x" + p, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), env);

test("rejects bad and stale signatures", async () => {
  assert.equal((await hook({ event_id: "e0" }, "ts=1;h1=abc")).status, 401);
  assert.equal(await verifyPaddleSignature("s", await sign("x", 1), "x"), false);
});

test("purchase -> key -> activate -> limit -> deactivate -> refund revokes", async () => {
  await hook({ event_id: "e1", event_type: "customer.created", data: { id: "ctm_1", email: "Buyer@Example.com" } });
  const r = await hook({ event_id: "e2", event_type: "transaction.completed", data: { id: "txn_1", status: "completed", customer_id: "ctm_1", currency_code: "INR",
    items: [{ price: { id: "pri_full", custom_data: { tier: "full" } } }], details: { totals: { grand_total: "199900" } }, address: { country_code: "IN" } } });
  assert.equal(r.status, 200);
  // duplicate delivery is idempotent
  assert.equal((await (await hook({ event_id: "e2", event_type: "transaction.completed", data: {} })).json()).duplicate, true);
  const lic = await (await worker.fetch(new Request("https://x/api/license?txn=txn_1&email=buyer@example.com"), env)).json();
  assert.match(lic.key, /^OC1\./);
  assert.equal((await worker.fetch(new Request("https://x/api/license?txn=txn_1&email=evil@x.com"), env)).status, 403);
  assert.equal((await post("/api/activate", { key: lic.key + "x", device_id: "d1" })).status, 400);
  const a1 = await (await post("/api/activate", { key: lic.key, device_id: "d1", device_name: "Win PC" })).json();
  assert.match(a1.activation, /^OCA1\./);
  assert.equal((await post("/api/activate", { key: lic.key, device_id: "d1" })).status, 200); // re-activate same device ok
  await post("/api/activate", { key: lic.key, device_id: "d2" });
  const r3 = await post("/api/activate", { key: lic.key, device_id: "d3" });
  assert.equal(r3.status, 409);
  await post("/api/deactivate", { key: lic.key, device_id: "d2" });
  assert.equal((await post("/api/activate", { key: lic.key, device_id: "d3" })).status, 200);
  await hook({ event_id: "e3", event_type: "adjustment.created", data: { action: "refund", type: "full", status: "approved", transaction_id: "txn_1" } });
  const v = await (await post("/api/validate", { key: lic.key, device_id: "d1" })).json();
  assert.equal(v.status, "revoked"); assert.equal(v.ok, false);
  assert.equal((await post("/api/activate", { key: lic.key, device_id: "d9" })).status, 403);
});

test("waitlist: form + JSON signups, intent merge, honeypot, export auth", async () => {
  const form = (fields, headers = {}) => { const f = new FormData(); for (const [k, v] of fields) f.append(k, v);
    return worker.fetch(new Request("https://x/waitlist", { method: "POST", body: f, headers }), env); };
  let r = await form([["email", "A@Ex.test"], ["segment", "shorts-studio"], ["intent", "upgrade40"], ["page", "/"]], { referer: "https://site.test/#pricing" });
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "https://site.test/#joined");
  r = await worker.fetch(new Request("https://x/waitlist", { method: "POST", body: JSON.stringify({ email: "a@ex.test", segment: "shorts-studio", intent: ["bundle79", "bogus"] }),
    headers: { "content-type": "application/json", accept: "application/json" } }), env);
  assert.equal(r.status, 200);
  assert.equal((await form([["email", "nope"]], { accept: "application/json" })).status, 400);
  await form([["email", "bot@ex.test"], ["_gotcha", "x"]], { accept: "application/json" });
  await form([["email", "b@ex.test"], ["segment", "evil:key"]], { accept: "application/json" });
  assert.equal((await worker.fetch(new Request("https://x/waitlist/stats"), env)).status, 401);
  const st = await (await worker.fetch(new Request("https://x/waitlist/stats", { headers: { authorization: "Bearer admintok" } }), env)).json();
  assert.equal(st.segments["shorts-studio"], 1); assert.equal(st.segments.launch, 1);
  assert.equal(st.intent["shorts-studio:upgrade40"], 1); assert.equal(st.intent["shorts-studio:bundle79"], 1);
  const csv = await (await worker.fetch(new Request("https://x/waitlist/export?token=admintok"), env)).text();
  assert.match(csv, /"a@ex.test","shorts-studio","upgrade40 bundle79"/); assert.doesNotMatch(csv, /bot@ex.test/);
});

// ---------- Dodo ----------
const { verifyStandardWebhook, priceFor } = await import("../src/worker.js");
env.DODO_WEBHOOK_SECRET = "whsec_" + Buffer.from("dodo-secret-key-bytes-123456").toString("base64");
env.DODO_PRODUCTS = JSON.stringify({ pdt_found: "founding", pdt_full: "full" });
async function dsign(id, ts, raw) {
  const k = await crypto.subtle.importKey("raw", Buffer.from(env.DODO_WEBHOOK_SECRET.slice(6), "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "v1," + Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${raw}`))).toString("base64");
}
let wn = 0;
async function dhook(evt, bad) {
  const raw = JSON.stringify(evt), id = "msg_" + (++wn), ts = String(Math.floor(Date.now() / 1000));
  return worker.fetch(new Request("https://x/webhooks/dodo", { method: "POST", body: raw,
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": bad ? "v1,AAAA" : await dsign(id, ts, raw) } }), env);
}
test("dodo: bad signature rejected", async () => {
  assert.equal((await dhook({ type: "payment.succeeded", data: {} }, true)).status, 401);
  assert.equal(await verifyStandardWebhook(env.DODO_WEBHOOK_SECRET, "a", "1", "v1,x", "{}"), false);
});
test("dodo: payment -> key, refund revokes, dispute won restores only disputes", async () => {
  const r = await (await dhook({ type: "payment.succeeded", data: { payment_id: "pay_1", total_amount: 2900, currency: "USD",
    customer: { customer_id: "cus_1", email: "Dodo@Buyer.com" }, product_cart: [{ product_id: "pdt_found", quantity: 1 }], billing: { country: "DE" } } })).json();
  assert.match(r.result, /^license:/);
  const lic = await (await worker.fetch(new Request("https://x/api/license?txn=pay_1&email=dodo@buyer.com"), env)).json();
  assert.equal(lic.tier, "founding"); assert.ok(lic.key.startsWith("OC1."));
  assert.equal((await (await dhook({ type: "payment.succeeded", data: { payment_id: "pay_x", product_cart: [{ product_id: "pdt_other" }] } })).json()).result, "other_product");
  assert.equal((await (await dhook({ type: "refund.succeeded", data: { payment_id: "pay_1", amount: 1000, is_partial: true } })).json()).result, "partial_refund_kept");
  assert.equal((await (await dhook({ type: "refund.succeeded", data: { payment_id: "pay_1", amount: 2900, is_partial: false } })).json()).result, "revoked");
  assert.equal((await (await dhook({ type: "dispute.won", data: { payment_id: "pay_1" } })).json()).result, "ignored");
  await dhook({ type: "payment.succeeded", data: { payment_id: "pay_2", total_amount: 3900, customer: { email: "b@c.de" }, product_cart: [{ product_id: "pdt_full" }] } });
  assert.equal((await (await dhook({ type: "dispute.opened", data: { payment_id: "pay_2" } })).json()).result, "revoked");
  assert.equal((await (await dhook({ type: "dispute.won", data: { payment_id: "pay_2" } })).json()).result, "restored");
});
test("price by country", () => {
  assert.equal(priceFor("IN").founding, "₹1,499"); assert.equal(priceFor("FR").currency, "EUR");
  assert.equal(priceFor("CA").founding_currency, "USD"); assert.equal(priceFor(undefined).full, "$39");
});

test("dodo: key emailed on purchase (once) and find-my-key resends active keys only", async () => {
  const sent = [];
  env.RESEND_API_KEY = "re_test";
  env.FETCH = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  await dhook({ type: "payment.succeeded", data: { payment_id: "pay_m1", total_amount: 2900, customer: { email: "Mail@Buyer.com" }, product_cart: [{ product_id: "pdt_found" }] } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.deepEqual(sent[0].body.to, ["mail@buyer.com"]);
  assert.match(sent[0].body.text, /OC1\./);
  await dhook({ type: "payment.succeeded", data: { payment_id: "pay_m1", customer: { email: "mail@buyer.com" }, product_cart: [{ product_id: "pdt_found" }] } });
  assert.equal(sent.length, 1); // same payment again: no second email
  await dhook({ type: "payment.succeeded", data: { payment_id: "pay_m2", total_amount: 3900, customer: { email: "mail@buyer.com" }, product_cart: [{ product_id: "pdt_full" }] } });
  await dhook({ type: "refund.succeeded", data: { payment_id: "pay_m2", amount: 3900, is_partial: false } });
  sent.length = 0;
  const r = await post("/api/recover", { email: "MAIL@buyer.com" });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal((sent[0].body.text.match(/OC1\./g) || []).length, 1); // refunded key left out
  await post("/api/recover", { email: "mail@buyer.com" });
  assert.equal(sent.length, 1); // rate limited
  assert.deepEqual(await (await post("/api/recover", { email: "nobody@x.com" })).json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal((await post("/api/recover", { email: "bad" })).status, 400);
  delete env.RESEND_API_KEY; delete env.FETCH;
});

test("dodo: live env ignores test-mode webhooks; pre-order copy in key email", async () => {
  env.DODO_ENV = "live";
  const r = await (await dhook({ type: "payment.succeeded", data: { payment_id: "pay_t1", customer: { email: "t@t.de" }, product_cart: [{ product_id: "pdt_found" }] } })).json();
  assert.equal(r.result, "test_mode_ignored");
  delete env.DODO_ENV;
  const { keyEmail } = await import("../src/worker.js");
  const m = keyEmail([{ tier: "founding", key: "OC1.x", created: "2026-10-22" }], "purchase", true);
  assert.match(m.subject, /pre-order/); assert.match(m.text, /isn't out yet/); assert.match(m.text, /14 days/);
  assert.doesNotMatch(keyEmail([{ tier: "full", key: "OC1.y" }], "recover", false).text, /14 days/);
});
