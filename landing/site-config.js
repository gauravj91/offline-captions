/* =====================================================================
   SITE CONFIG — the one place to edit. Every page loads this file.
   Prices and names are also written into the HTML so the pages read
   right with JavaScript off and for search engines; this file updates
   them in the browser. When you change a price here, also run the
   find/replace in README.md so the static text and JSON-LD match.
   ===================================================================== */
window.SITE_CONFIG = {
  APP_NAME: "Offline Captions",          // working name
  SITE_URL: "https://offlinecaptions.com", // domain live since 19 Oct 2026
  CHECKOUT_URL: "",                      // optional fallback link; Paddle overlay checkout (below) is used when configured

  /* Sales switch. false = Pre-order buttons become "Get the launch price" and point to the
     launch waitlist, and Paddle isn't loaded. Set true only once PADDLE_ENV is "production". */
  SALES_OPEN: false,
  WEB_APP_URL: "https://offline-captions-web.vercel.app",

  /* Paddle checkout (checkout.js). Sandbox values: swap all four for live ones at launch. */
  PADDLE_ENV: "sandbox",                 // "sandbox" | "production"
  PADDLE_CLIENT_TOKEN: "test_614d5608c73d6ff75f543edf96c",
  PADDLE_PRICE_ID: "pri_01m5494svf188dx7n4yf7j4dm4",   // founding pre-order price (USD 29 / INR 1,499 / EUR 29 / GBP 25)
  PADDLE_PRICE_ID_FULL: "pri_01m5494s3ag36bywbmnq64sgp7", // after launch (USD 39 / INR 1,999 / EUR 39 / GBP 35 / CAD 49 / AUD 59)
  LICENSE_API: "https://offline-captions-api.hirewire.workers.dev",
  CHECKOUT_URL_INR: "",                  // optional separate checkout for the ₹ price (Razorpay, Lemon Squeezy with INR...)
  WAITLIST_ACTION: "https://offline-captions-api.hirewire.workers.dev/waitlist", // our Worker; export: GET /waitlist/export (admin token, see server/README.md)
  CONTACT_EMAIL: "hello@offlinecaptions.com",                     // TODO(Gaurav): support address shown in the footer when set

  PRICE_PREORDER: "$29",                 // founding pre-order
  PRICE_FULL: "$39",                     // after launch
  PRICE_INR_PREORDER: "₹1,499",          // PROPOSAL — Gaurav's decision (see README). India founding price
  PRICE_INR_FULL: "₹1,999",              // PROPOSAL — Gaurav's decision. India price after launch
  /* Shorts Studio (v2) — PLANNED, waitlist only, not for sale. Shown on home + hinglish pricing. */
  PRICE_SHORTS_BUNDLE: "$79",            // planned one-time bundle, captions included
  PRICE_SHORTS_UPGRADE: "$40",           // planned upgrade for Offline Captions owners
  PRICE_INR_SHORTS_BUNDLE: "₹2,499",     // planned India bundle price
  INR_TAX_NOTE: "",                      // TODO(Gaurav): e.g. "incl. 18% GST" or "+ GST" once tax handling is decided

  /* Open policy choices. Leave "" until decided: the line that depends on it stays hidden. */
  UPDATES_POLICY: "",                    // TODO e.g. "Free updates for every 1.x version"
  DEVICE_LIMIT: "",                      // TODO e.g. "Use it on up to 2 of your own computers"
  MONEY_BACK_DAYS: "",                   // TODO e.g. "30" -> shows "30-day money-back guarantee"
  PREORDER_REFUND: ""                    // TODO e.g. "Pre-orders are refundable any time before launch."
};
