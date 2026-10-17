# License server (Cloudflare Worker + KV)

Paddle is the merchant of record. Flow:

1. Buyer clicks Pre-order on the landing page → `landing/checkout.js` opens the Paddle overlay checkout
   (Paddle picks the local currency / country price: INR in India, EUR in the eurozone, GBP, CAD, AUD, else USD).
2. Paddle sends `transaction.completed` to `POST /webhooks/paddle` (HMAC-verified with the notification secret).
3. The worker issues an Ed25519-signed key `OC1.<payload>.<sig>` and stores it in KV.
4. The thank-you dialog polls `GET /api/license?txn=…&email=…` and shows the key.
5. Desktop app (`src/license.mjs`): verifies the key offline, `POST /api/activate` binds it to the device
   (limit `DEVICE_LIMIT`, default 2) and returns a signed activation token. `POST /api/validate` re-checks every 14 days;
   only a definite "revoked" answer disables it. `POST /api/deactivate` frees a seat.
6. Full refund / chargeback (`adjustment.*` approved) → license `revoked`.

Sandbox: `https://offline-captions-api.hirewire.workers.dev` (Paddle notification destination subscribed to
transaction.completed/paid, customer.created/updated, adjustment.created/updated).

Going live: create a live Paddle notification destination + client token + prices, generate a NEW signing key pair,
update `LICENSE_PUBLIC_KEY` in `src/license.mjs`, and the PADDLE_* values in `landing/site-config.js`.

Tests: `node --test server/test/`. Deploy: `python3 server/deploy.py`.
