/* =====================================================================
   SITE CONFIG — the one place to edit. Every page loads this file.
   Prices and names are also written into the HTML so the pages read
   right with JavaScript off and for search engines; this file updates
   them in the browser. When you change a price here, also run the
   find/replace in README.md so the static text and JSON-LD match.
   ===================================================================== */
window.SITE_CONFIG = {
  APP_NAME: "Offline Captions",          // working name
  SITE_URL: "https://YOUR-DOMAIN.example", // TODO(Gaurav): domain undecided. Also replace in every *.html, robots.txt, sitemap.xml, llms.txt
  CHECKOUT_URL: "#checkout",             // Stripe Payment Link / Lemon Squeezy / Paddle / Gumroad
  CHECKOUT_URL_INR: "#checkout",         // optional separate checkout for the ₹ price (Razorpay, Lemon Squeezy with INR...)
  WAITLIST_ACTION: "#waitlist",          // form POST endpoint (Formspree, Buttondown, Tally...)
  CONTACT_EMAIL: "",                     // TODO(Gaurav): support address shown in the footer when set

  PRICE_PREORDER: "$29",                 // founding pre-order
  PRICE_FULL: "$39",                     // after launch
  PRICE_INR_PREORDER: "₹1,499",          // PROPOSAL — Gaurav's decision (see README). India founding price
  PRICE_INR_FULL: "₹1,999",              // PROPOSAL — Gaurav's decision. India price after launch
  INR_TAX_NOTE: "",                      // TODO(Gaurav): e.g. "incl. 18% GST" or "+ GST" once tax handling is decided

  /* Open policy choices. Leave "" until decided: the line that depends on it stays hidden. */
  UPDATES_POLICY: "",                    // TODO e.g. "Free updates for every 1.x version"
  DEVICE_LIMIT: "",                      // TODO e.g. "Use it on up to 2 of your own computers"
  MONEY_BACK_DAYS: "",                   // TODO e.g. "30" -> shows "30-day money-back guarantee"
  PREORDER_REFUND: ""                    // TODO e.g. "Pre-orders are refundable any time before launch."
};
