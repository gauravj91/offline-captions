# Offline Captions (working name)

Animated, word-highlight captions for short-form video. **Everything runs on the creator's computer**: no uploads, no credits, no watermark, one-time price.

This repo is the **caption engine + CLI** (phase 1) and the **Mac/Windows desktop app** (phase 2, `app/`) that wraps the same engine.

## Quick start (macOS or Windows)

Requirements: Node 20+ and ffmpeg on your PATH (`brew install ffmpeg` / `winget install ffmpeg`).

```bash
npm install
node src/cli.mjs my-video.mp4 --style bold
# -> my-video.captioned.mp4 + my-video.captioned.srt
```

The first run downloads the speech model and caches it in `~/.offline-captions/models` (Parakeet ~660 MB; Whisper models 80–800 MB).

**Engines.** English uses **NVIDIA Parakeet-TDT 0.6B v2** (via sherpa-onnx), our most accurate and fastest option (7.6% WER on our 28-clip benchmark vs 9.6% for Whisper-small). Other languages use Whisper (`--lang de` etc.); force one with `--engine parakeet|whisper|hinglish`.

**Hinglish (`--lang hinglish`).** Roman-script captions for Hindi-English speech ("Usko gaali de do, complaint kar lo"). Oriserve Whisper-Hindi2Hinglish (Apache-2.0) writes the text; AI4Bharat IndicConformer-hi (MIT) hears the same audio in Devanagari for word timing; `hinglish-align.mjs` matches the two across scripts. Words it can't time precisely are flagged for review. `--quality fast|balanced` = Swift (~150 MB + 200 MB timing model), `accurate` = Apex (~1 GB). On 10 real creator clips (CoSHE-Eval), script-blind WER is 22–24% vs 30% for IndicConformer alone, and that measure overstates errors because spellings differ across scripts.
Parakeet model licence: CC-BY-4.0, so credit "NVIDIA Parakeet-TDT 0.6B v2" in the app's About/credits.

Options:

| Flag | What it does |
|---|---|
| `--style bold\|clean\|punch\|reveal` | Caption look (see below) |
| `--engine parakeet\|whisper\|hinglish` | Default: Parakeet for English, Hinglish for `--lang hinglish`, Whisper otherwise |
| `--quality fast\|balanced\|accurate` | Whisper: base / small / large-v3-turbo. Hinglish: Swift / Swift / Apex |
| `--dict dictionary.json` | Personal dictionary, e.g. `{"fit lab": "FitLab"}` (its values are also fed to the model) |
| `--words "Hormozi,FitLab"` | Extra names/brands to listen for |
| `--lang en` | Force language (default: auto) |
| `--keep-fillers` | Don't remove um/uh |
| `--draft` | Fast, lower-quality render for previews |
| `--edit` | Stop after transcription; writes `<video>.captions.json` you can correct |
| `--from project.json` | Render from an edited project |
| `--out dir` | Output folder |

Several videos at once: `node src/cli.mjs a.mp4 b.mp4 c.mp4 --style clean` (batch).

### Styles
- **bold**: big all-caps (Anton), active word turns yellow and pops.
- **clean**: sentence case (Montserrat ExtraBold), active word on a purple pill.
- **punch**: one huge word at a time, centred.
- **reveal**: words appear as they're spoken, green highlight.

## Desktop app (Electron, macOS + Windows)

```bash
npm install
npm run app          # dev: opens the app (needs ffmpeg on PATH or in vendor/ffmpeg/, see below)
npm run dist:mac     # on a Mac  -> dist/Offline Captions-<v>-arm64.dmg (+ x64)
npm run dist:win     # on Windows -> dist/Offline Captions Setup <v>.exe (NSIS)
```

The flow, in order:
1. **Import**: drop or pick one or many videos (batch queue). Language: English (Parakeet) / Hinglish / Other (Whisper, pick the language). Quality fast / balanced / accurate (Parakeet ignores it; the hint says so).
2. **First-run model download**: size shown before you start (Parakeet ~660 MB, Hinglish Swift ~350 MB, Apex ~1.2 GB, Whisper 80–800 MB), byte-level progress bar, stored in `~/.offline-captions/models` (shared with the CLI). "Runs offline · nothing uploaded" badge in the title bar.
3. **Transcribe** with per-video progress (stage + % of audio windows). The first finished video opens while the rest keep running.
4. **Review**: 9:16-aware preview with a live HTML caption overlay of the chosen style (mirrors `ass.mjs`: same lines, sizes, outline, modes). Word-by-word transcript, flagged words (`review: true`) in yellow. Click a word: the video jumps there and the word becomes editable inline. Enter keeps it (clears the flag), a change is taught to the personal dictionary via `learn()` and applied to identical words in the same video, empty deletes it, Esc cancels. "Next flagged word" (or N / Tab). Filler-removal toggle (fillers shown struck through).
5. **Style**: the four `PRESETS` (bold, clean, punch, reveal) plus **position** and **size**, the two overrides `resolveStyle()` supports (position 8–60% from the bottom; 45–55% snaps to centre, as in `ass.mjs`; size 60–150% of the preset).
6. **Export** MP4 (burned in, libass) + SRT, this video or all, optional fast draft render, choose a folder (default: next to each video), progress bar, "Open folder".
About box credits NVIDIA Parakeet (CC-BY-4.0), AI4Bharat IndicConformer (MIT), Oriserve Whisper-Hindi2Hinglish (Apache-2.0), sherpa-onnx (Apache-2.0), Whisper, FFmpeg and the OFL fonts.

**Architecture**

| File | Role |
|---|---|
| `app/main.mjs` | Main process: window, dialogs, IPC, personal dictionary (`<userData>/dictionary.json`). Imports only pure engine modules |
| `app/worker.mjs` | `utilityProcess`: model download, transcription (sherpa-onnx / ONNX Runtime native code), ffmpeg export. The UI never blocks |
| `app/preload.cjs` | The only bridge (`window.captions`), via `contextBridge` |
| `app/tools.mjs` | Finds ffmpeg/ffprobe + fonts and passes `FFMPEG_PATH` / `FFPROBE_PATH` / `CAPTIONS_FONTS_DIR` to the worker |
| `app/renderer/` | Plain HTML/CSS/JS (no framework, no build step). `preview.js` = live caption overlay |
| `app/dev-shots.mjs` | Dev only: `CAPTIONS_UI_SHOTS=<dir> CAPTIONS_UI_VIDEO=a.mp4,b.mp4 npm run app` drives the real app and saves screenshots |
| `src/models.mjs` | Model manifest, on-disk status, streaming download with byte progress (also usable from the CLI) |
| `src/captions.mjs` | `buildCaptions()` split out of `index.mjs` so the main process can call it without loading native modules |
| `electron-builder.yml` | dmg (arm64 + x64) and NSIS (x64) targets |

Security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP (no network from the page), navigation and new windows blocked, `shell.openExternal` only for `https://` credit links.

**What must be bundled** (not in git):
- **ffmpeg + ffprobe** with libass/freetype/harfbuzz and an H.264 encoder, per platform in `vendor/ffmpeg/<platform>-<arch>/` (see `vendor/ffmpeg/README.md`). electron-builder copies it to `<resources>/ffmpeg/`; `app/tools.mjs` sets `FFMPEG_PATH`/`FFPROBE_PATH`, the same contract `src/ffmpeg.mjs` already uses. Dev fallback: Homebrew paths, then `PATH`. **Licence decision needed**: `render.mjs` uses libx264, which makes the ffmpeg build GPL; an LGPL build means switching to `h264_videotoolbox` / `h264_mf`.
- **Native modules**: `sherpa-onnx-node` + its platform package (`sherpa-onnx-darwin-arm64`, `-darwin-x64`, `-win-x64`) and `onnxruntime-node` (Whisper). They are N-API, so no Electron rebuild, but each OS installer must be built on that OS (or with the right optional deps installed) and they are `asarUnpack`ed.
- **Fonts** (`fonts/`, OFL) are unpacked from the asar so libass can read them.
- Models are **not** bundled: downloaded on first run (keeps the installer small).

**Signing (not done here)**: macOS needs an Apple Developer ID certificate + notarisation (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars for electron-builder; `hardenedRuntime` is already on, entitlements for JIT may be needed by ONNX Runtime). Windows: Azure Artifact Signing or an OV/EV certificate (`win.azureSignOptions` or `CSC_LINK`). Unsigned builds work for testing: macOS right-click → Open; Windows SmartScreen → More info → Run anyway.

## How it works

```
video ──ffmpeg──> 16 kHz audio ──Whisper (ONNX, local)──> words + timestamps
      ──dictionary fixes──> filler removal ──line grouping──> .ass (per-word animation)
      ──ffmpeg + libass──> captioned .mp4  (+ .srt)
```

| File | Role |
|---|---|
| `src/ffmpeg.mjs` | Probe video, extract audio, run ffmpeg (`FFMPEG_PATH`/`FFPROBE_PATH` override) |
| `src/transcribe.mjs` | Engine switch (Parakeet default, Whisper fallback) |
| `src/engines/parakeet.mjs` | Parakeet via sherpa-onnx: download, word timing, confidence |
| `src/engines/hinglish.mjs` | Roman Hinglish: Whisper-Hinglish text + IndicConformer timing |
| `src/engines/hinglish-align.mjs` | Cross-script word alignment (consonant skeletons + DP) |
| `src/engines/whisper.mjs` | Whisper via transformers.js: vocabulary prompt, windowing, confidence |
| `src/vocabulary.mjs` | Snaps near-misses onto your names/brands ("Ormozi" → "Hormozi") |
| `src/review.mjs` | Yellow-word flags (per-engine thresholds) |
| `src/dictionary.mjs` | Personal dictionary: apply + learn from corrections |
| `src/segment.mjs` | Filler removal, split words into short readable lines |
| `src/styles.mjs` | Style presets (sizes relative to video height) |
| `src/ass.mjs` | Builds the animated .ass subtitle file |
| `src/render.mjs` | Burns captions in with ffmpeg/libass, bundled fonts |
| `src/index.mjs` | Engine API used by the CLI and the desktop app |
| `src/models.mjs` | Model manifest, status, download with progress |
| `src/captions.mjs` | Words → lines + .ass + .srt (pure) |
| `fonts/` | Bundled OFL fonts (Anton, Montserrat ExtraBold) |

Tests: `npm test`.

## Roadmap

**Phase 1: engine (this repo)** ✅ transcription, dictionary, 4 styles, burn-in, SRT, batch
- [x] Per-word confidence → "yellow words" to review (`review: true` in the project JSON, `[[word]]` in CLI output; threshold 0.6)
- [x] Vocabulary prompt: dictionary values + `--words "Hormozi,FitLab"` are fed to Whisper so names are heard right the first time
- [x] Own windowing at quiet points (fixes words dropped by the pipeline's chunk merge on clips > 30 s)
- [ ] Optional denoise (`CAPTIONS_DENOISE=1`) — needs testing on real noisy clips
- [ ] Accuracy test set: 50–100 real creator clips, track error rate vs CapCut/Submagic
- [x] Parakeet engine (best accuracy + speed on CPU)
- [ ] Parakeet v3 (25 European languages)
- [ ] Same-clip comparison vs CapCut/Submagic (test pack sent to Gaurav)

**Phase 2: desktop app**
- [x] Electron shell: drag-drop batch queue, language/quality, live HTML caption preview, click-to-fix words (teaches the dictionary), next-flagged, filler toggle, style picker with position/size, MP4+SRT export (single/batch), About/credits
- [x] Engine in a `utilityProcess`; secure renderer (contextIsolation, sandbox, CSP)
- [x] Model download manager with byte progress (`src/models.mjs`)
- [x] electron-builder config (dmg arm64/x64, NSIS x64)
- [ ] Bundle ffmpeg (decide LGPL vs GPL: libx264 vs VideoToolbox/Media Foundation encoders)
- [ ] Test on real macOS + Windows machines (only verified headless on Linux so far)
- [ ] Save/restore projects (edits are in memory until export), undo, split/merge words, edit word timing
- [ ] Brand preset (custom colours/fonts), more caption positions/animations, drag-to-position on the preview
- [ ] App icon, cancel buttons for download/transcribe/export, Whisper vocabulary field in the UI
- [ ] Hinglish/Whisper progress inside the model-loading step (first run loads 1–2 GB into memory with no %)
- [ ] Licence keys (Lemon Squeezy), auto-update
- [ ] Code signing: Apple Developer ID + notarisation; Azure Artifact Signing for Windows

**Phase 3: launch**
- [ ] Pre-order landing page (`landing/`), $29 founding price
- [ ] Posts in r/NewTubers, r/CapCut; "CapCut captions alternative" SEO page
