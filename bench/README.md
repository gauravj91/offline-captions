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
