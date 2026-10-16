# Accuracy benchmark

1. Put clips + human transcripts in a `refs.json`: `[{"file": "clips/a.wav", "ref": "what was said", "sec": 12.3}]`
2. `node bench/run.mjs path/to/refs.json fast out-fast.json` (and `balanced`)
3. `pip install jiwer num2words && python3 bench/score.py out-fast.json out-balanced.json`

Reports WER, clips needing <=2 fixes, share of words flagged yellow, how many wrong words the flags caught, and speed.

## Results 16 Oct 2026: 28 clips from People's Speech (test set, internet audio, 330 s total, noisy and accented)

| Model | WER | WER excl. "you know"/um/uh | Clips <=2 fixes | Flags catch wrong words | Speed (2 vCPU) |
|---|---|---|---|---|---|
| fast (Whisper base) | 15.5% | 14.2% | 14/28 | 53% (12% of words flagged) | 6.4x realtime |
| balanced (Whisper small) | 11.0% | 9.6% | 14/28 | 32% (7% flagged) | 3.0x realtime |

Notes: the reference transcripts are imperfect themselves (e.g. "highefficiency", missing "percent"), so true WER is a bit lower. Whisper drops disfluencies, which is what captions want anyway.
Next: whisper large-v3-turbo via whisper.cpp in the desktop build, which should be a big step up; the flag threshold still needs tuning for the balanced model.

## Round 2 (16 Oct 2026): stronger models, same 28 clips

WER with fillers removed / with reference-format quirks also normalised (gonna→going to, compounds, "percent"):

| Model | WER | Normalised WER | Clips <=2 fixes | Speed (2 vCPU) | Licence |
|---|---|---|---|---|---|
| Whisper base (fast) | 14.2% | 12.9% | 14/28 | 6.4x realtime | MIT |
| Whisper small (balanced) | 9.6% | 8.3% | 14/28 | 3.0x | MIT |
| Whisper large-v3-turbo | 8.4% | 7.1% | 15/28 | 0.8x (too slow on CPU) | MIT |
| **NVIDIA Parakeet-TDT 0.6B v2 (int8, sherpa-onnx)** | **7.6%** | **6.2%** | 15/28 | **17.5x** | CC-BY-4.0 (commercial OK with attribution) |

Decision candidate: Parakeet as the default engine (English; v3 adds 25 European languages), Whisper as the fallback for other languages.
Most of Parakeet's remaining "errors" are reference quirks or proper names, which the dictionary/hotwords handle.
