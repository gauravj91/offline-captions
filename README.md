# Offline Captions (working name)

Animated, word-highlight captions for short-form video. **Everything runs on the creator's computer**: no uploads, no credits, no watermark, one-time price.

This repo is the **caption engine + CLI** (phase 1). The Mac/Windows desktop app wraps this same engine (phase 2).

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
| `src/index.mjs` | Engine API used by CLI and future desktop app |
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
- [ ] Electron shell: drag-drop, live preview (libass/HTML overlay), click-to-fix words, style editor, brand preset
- [ ] Bundle LGPL ffmpeg build + model download manager
- [ ] Licence keys (Lemon Squeezy), auto-update
- [ ] Code signing: Apple Developer ID + notarisation; Azure Artifact Signing for Windows

**Phase 3: launch**
- [ ] Pre-order landing page (`landing/`), $29 founding price
- [ ] Posts in r/NewTubers, r/CapCut; "CapCut captions alternative" SEO page
