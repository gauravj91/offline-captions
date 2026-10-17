/* =====================================================================
   WEB TRIAL CONFIG: the one place to tune the free web version.
   Plain script (not bundled): edit and redeploy, no build needed.
   Values below are a PROPOSAL; Gaurav decides the final limits.
   ===================================================================== */
window.WEB_CONFIG = {
  // ---- free web limits ----
  MAX_SECONDS: 60,              // longest video the web version captions (longer: first 60 s, or desktop app)
  MAX_EXPORT_SHORT_SIDE: 1080,  // 1080p cap: the short side of the exported MP4 (9:16 -> 1080x1920)
  STYLES: ['bold', 'clean', 'punch', 'reveal'], // all four styles are free
  WATERMARK: false,             // no watermark on web exports
  SRT_ALWAYS_FREE: true,        // SRT download is never limited

  // ---- speech models (Whisper via transformers.js, downloaded once, cached by the browser) ----
  DEFAULT_MODEL: 'base',
  // sizes in MB as listed on Hugging Face (encoder + decoder + tokenizer)
  MODELS: {
    base:  { id: 'onnx-community/whisper-base_timestamped',  label: 'Whisper base',  note: 'Fast',   mb: { wasm: 80,  webgpu: 139 } },
    small: { id: 'onnx-community/whisper-small_timestamped', label: 'Whisper small', note: 'Better', mb: { wasm: 252, webgpu: 512 } },
  },
  REVIEW_THRESHOLD: 0.6,        // same as src/review.mjs THRESHOLDS.whisper

  // ---- desktop upsell ----
  PRICE: '$29',
  PRICE_NOTE: 'founding price, one-time',
  // Where "Get the desktop app" goes. Order: this value, then landing
  // site-config.js CHECKOUT_URL, then SITE_URL (only if they are real https:// links).
  // TODO(Gaurav): set once the landing page has a domain/checkout.
  UPSELL_URL: '',
  DESKTOP_ONLY: [
    'Long videos (no 60 s limit) and batches of many clips',
    '4K export',
    'NVIDIA Parakeet English: more accurate and faster',
    'Hinglish mode (Roman-script captions for Hindi-English speech)',
    'A personal dictionary that remembers every fix',
  ],
};
