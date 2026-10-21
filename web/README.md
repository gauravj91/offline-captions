# Offline Captions: web version (free trial, top of the funnel)

"See the value on the web, get more in the desktop app." A static site: drop one short video, get word-by-word animated captions, review the unsure words, pick one of the 4 styles, and download a burned-in MP4 and an SRT.

**Everything runs in the visitor's browser tab.** The video is read from their disk into memory, the audio is decoded and transcribed in a Web Worker, the captions are drawn on a canvas and the MP4 is encoded with WebCodecs. Nothing is uploaded and there is no server. The only network traffic is the static site itself and the one-time speech model download from Hugging Face, which the browser then caches (Cache API, `transformers-cache`). The page CSP only allows `connect-src` to `'self'` and Hugging Face.

## Build, run, deploy

```bash
cd web
npm install
npm run build            # -> dist/ (bundles with esbuild, copies ORT wasm, fonts, config)
npm run serve            # http://localhost:8787 with the same COOP/COEP headers as Vercel
```

`dist/` is the whole site (about 22 MB, mostly the ONNX Runtime WASM). It is not in git; rebuild it.
Deploy: upload `dist/` as a static Vercel project (no build step). `vercel.json` (copied into `dist/`) sets the headers:
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Together they turn on `crossOriginIsolated`, which threaded WASM needs (SharedArrayBuffer). Without them ONNX Runtime falls back to one thread, which is about 2x slower. Hugging Face sends CORS headers, so model downloads work under `require-corp`.

## Flow

1. **Import**: one video (MP4/MOV best, WebM works), language (English default, 15 others, auto-detect), model Fast (Whisper base) / Better (Whisper small). The model card shows the backend (WebGPU or WASM + thread count), the download size, and "✓ Cached" once it is in the browser.
2. **Audio**: `AudioContext.decodeAudioData` on the file, resampled to 16 kHz mono with an `OfflineAudioContext` (first `MAX_SECONDS` only).
3. **Transcribe** (`src/worker.js`): transformers.js 3.8.1 `onnx-community/whisper-{base,small}_timestamped`, `return_timestamps: 'word'`. WASM: q8 encoder + decoder. WebGPU (when there is an adapter): fp32 encoder on the GPU, q8 decoder on WASM. If WebGPU fails it retries on WASM by itself. It reuses `windows()`, `alignConfidence()` and `fixTimes()` from `src/engines/whisper.mjs` (same quiet-point windowing and per-word confidence as the desktop engine).
4. **Review**: same UX as the desktop app: yellow flagged words (`flagForReview` from `src/review.mjs`, Whisper threshold 0.6), click a word to jump there and edit it inline (Enter keeps it, an empty word deletes it, Esc cancels, the fix is applied to identical words in this video), "Next flagged word" (N / Tab), filler toggle (fillers struck through). Lines come from `src/segment.mjs`.
5. **Style**: the 4 `PRESETS` from `src/styles.mjs`, plus position and size. The live preview is a `<canvas>` over the `<video>`, drawn by `src/draw.js`. That is a canvas port of `app/renderer/preview.js` / `src/ass.mjs` (same lines, sizes, outline, shadow, highlight/box/single/reveal, the single-word 90 ms pop).
6. **Export** (`src/media.js`): mp4box.js demux → `VideoDecoder` → draw the frame + the captions with the same `drawCaption()` as the preview → `VideoEncoder` (H.264 High; falls back to VP9 then AV1) → mp4-muxer. AAC audio is copied as it is (no re-encode, no AAC encoder needed). Other audio is re-encoded (AAC if the browser can, else Opus). Files mp4box can't read (WebM/MKV) go through a seek-a-`<video>` fallback. Phone rotation matrices are honoured. SRT uses `src/srt.mjs`.

Libraries are bundled or vendored (no CDN at runtime): transformers.js + onnxruntime-web (bundled; `vendor/ort/ort-wasm-simd-threaded.jsep.{mjs,wasm}` copied), mp4box.js 0.5.4, mp4-muxer 5.2 (bundled). Fonts: `fonts/` (OFL Anton, Montserrat ExtraBold) via `@font-face`.

## Trial limits (`config.js`, a plain script: edit and redeploy, no rebuild)

| Constant | Value (proposal; Gaurav decides) | Effect |
|---|---|---|
| `MAX_SECONDS` | 300 (60 until 21 Oct 2026) | Longer clips: a clear note, the first 5 min is captioned and exported, "Full length in the desktop app" link |
| `MAX_EXPORT_SHORT_SIDE` | 1080 | 4K sources export at 1080p (e.g. 1080×1920), with a note |
| `STYLES` | all 4 | |
| `WATERMARK` | false | No watermark (none is drawn) |
| `SRT_ALWAYS_FREE` | true | SRT button never limited |
| `MODELS`, `DEFAULT_MODEL` | base (~80 MB WASM / ~139 MB WebGPU), small (~252 / ~512 MB) | Sizes from the HF file listings |
| `PRICE`, `PRICE_NOTE`, `UPSELL_URL`, `DESKTOP_ONLY` | $29 founding, one-time | Upsell dialog + after-export card |

Desktop-only, shown in the upsell: long videos + batch, 4K, Parakeet English, Hinglish (in the language list as "Hinglish (desktop app)", which opens the dialog), the persistent personal dictionary (the web edit toast says the desktop app remembers fixes).
Upsell rules (no dark patterns): a "Desktop app" button in the header, a note when a limit is hit, one dismissible card after an export. Nothing is blocked behind it and nothing nags. **Link**: `UPSELL_URL`, else landing `site-config.js` `CHECKOUT_URL`, else `SITE_URL`, but only when it is a real `https://` link. Today all of them are placeholders, so the button reads "Pre-orders open soon" with no link. Set `UPSELL_URL` (or the landing checkout) to switch it on.

## Measured (headless test, 17 Oct 2026)

Electron 38 / Chromium 140 on a 2-vCPU Linux arm64 sandbox, WASM backend (no GPU), 2 threads (crossOriginIsolated), Whisper base q8, `samples/test.mp4` (12 s, 720×1280, H.264 + AAC):

| Step | Time |
|---|---|
| Audio decode + resample | 30–35 ms |
| Model first load (download ~80 MB + init) | 8.9 s |
| Model load from browser cache | 3.3–3.4 s |
| Transcription of 12 s | 5.6–6.3 s (≈2× faster than real time) |
| MP4 export (360 frames, 720×1280, H.264 High, AAC copied) | 2.6–2.7 s (≈4.6× real time) |

Output check: `ffprobe` gives h264 High 720×1280 30 fps, 360 frames, 12.0 s, plus aac LC 16 kHz mono; a full ffmpeg decode has no errors; frame grabs at 3.2 s ("TO FIX YOUR ROMANIAN") and 8 s match the preview. Transcript: 32 words, all correct, 0 flagged (lowest confidence 0.61 "Romanian").
Expect faster on a real laptop (4–8 threads, or WebGPU for the encoder). Transcription time grows with the clip, roughly 0.5 s per second of audio on this 2-core box. A 60 s clip is about 30 s.

Test harness: `test/e2e-electron.cjs` (see its header). It uses Electron's Chromium because Playwright's Linux arm64 Chromium has no H.264/AAC (proprietary codecs), so it can't open an MP4 at all. Normal Chrome/Edge/Safari can.

## Browser support

- Chrome / Edge 113+ (desktop + Android): full (WebCodecs, H.264 encode, WebGPU when present).
- Safari 17+: should work (WebCodecs video, decodeAudioData for MP4). **Not tested here.**
- Firefox 130+: transcription and SRT should work; MP4 export depends on its WebCodecs H.264 encoder (it falls back to VP9-in-MP4 if needed). **Not tested here.**
- Chromium builds without proprietary codecs can't decode H.264 MP4s.

## Hinglish / Parakeet in the browser: feasibility (investigated, not built)

**sherpa-onnx WASM.** sherpa-onnx has official Emscripten builds (`wasm/asr` streaming, `wasm/vad-asr` non-streaming with `OfflineRecognizer`, which supports Whisper, NeMo transducers like Parakeet, Paraformer, SenseVoice, Moonshine). Docs: https://k2-fsa.github.io/sherpa/onnx/wasm/index.html, https://github.com/k2-fsa/sherpa-onnx/blob/master/wasm/vad-asr/assets/README.md. Findings:
- The stock builds pack the model into the Emscripten virtual FS (a `.data` file preloaded at build time). Switching models means rebuilding with emsdk, or patching the loader to `FS.writeFile` a downloaded model.
- They run ONNX Runtime's CPU EP compiled to WASM. Third-party wrappers default to one thread (`numThreads: 1`). There is no WebGPU path.
- **Parakeet-TDT 0.6B v2 int8 is ~660 MB** (encoder 652 MB + decoder/joiner 9 MB, per https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx; same as our desktop manifest). The fp32 encoder is 2.4 GB of external data. 660 MB plus the runtime is near the practical limit of 32-bit WASM memory (4 GB max, often less on mobile Safari), and it is a heavy first download for a free trial.
- **Hinglish** needs two models (Whisper-Hindi2Hinglish ~150 MB+ text + IndicConformer ~200 MB timing) plus our cross-script aligner. That is roughly 350 MB+ and two runtimes. The aligner itself is pure JS and portable (`src/engines/hinglish-align.mjs`).

**A better browser path, if ever wanted:** `parakeet.js` (ONNX Runtime Web, the same runtime we already ship). It runs Parakeet-TDT v2/v3 on WebGPU (fp32 encoder on the GPU, int8 decoder on WASM) or on WASM (int8). It returns words with timestamps and confidences and caches in IndexedDB (https://github.com/casepot/parakeet.js, fork of ysdede/parakeet.js, v1.0 Jan 2026). The WebGPU encoder must be fp32 (~2.4 GB download, ~2.4 GB GPU memory per its README), so the realistic web option is WASM int8 (~660 MB).

**Recommendation:** don't put Parakeet or Hinglish on the web. The download (660 MB–1 GB) and memory make it a bad free-trial experience, and they are clean, honest reasons to own the desktop app. Whisper base (~80 MB) shows the value in under 15 s. If a web Parakeet is wanted later, prototype `parakeet.js` WASM int8 behind a "Large download" opt-in, not sherpa-onnx WASM.

## Known gaps

- Only verified headless in Electron's Chromium (WASM path). WebGPU, Safari, Firefox and real phones are untested.
- The whole file is read into memory (fine at ≤5 min for typical phone clips; a 4K 5-min clip can be over 1 GB, which may fail on low-memory devices).
- Edit lists are approximated (the first shown frame becomes t=0). Audio priming offsets of ~20 ms are not compensated.
- HEVC (iPhone "High Efficiency") MP4s only export where the browser can decode HEVC with WebCodecs. Otherwise the seek fallback needs `<video>` HEVC support.
- No vocabulary prompt field, no persistent dictionary (by design: desktop), no cancel button for download/transcribe/export.
- The upsell link is inactive until a real checkout/landing URL is set.
- Model license credits (Whisper MIT, transformers.js Apache-2.0, ORT MIT, fonts OFL) are not yet on a page.
