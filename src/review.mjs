// Picks the words a human should glance at before export ("yellow words").
// A word is flagged when Whisper was unsure of it (confidence below the
// threshold), when it is stuck between two unsure words (errors come in runs),
// or when we could not measure it. Words the dictionary fixed are trusted.
export const DEFAULT_THRESHOLD = 0.6;
// Parakeet is more confident than Whisper, so it needs a higher bar. Tuned on
// the 28-clip benchmark: 0.9 flags ~10% of words and catches ~half the errors.
export const THRESHOLDS = { whisper: 0.6, parakeet: 0.9 };

export function flagForReview(words, threshold = DEFAULT_THRESHOLD) {
  const low = words.map((w) => !w.fixed && (w.confidence == null || w.confidence < threshold));
  return words.map((w, i) => ({
    ...w,
    review: !!w.snapped || low[i] || (!w.fixed && i > 0 && i < words.length - 1 && low[i - 1] && low[i + 1]),
  }));
}

/** Plain-text view for the terminal: unsure words in [[brackets]]. */
export function reviewText(words) {
  return words.map((w) => (w.review ? `[[${w.text}]]` : w.text)).join(' ');
}

export function reviewStats(words) {
  const n = words.filter((w) => w.review).length;
  return { flagged: n, total: words.length, share: words.length ? n / words.length : 0 };
}
