// Snaps near-misses onto the creator's own names/brands, for any engine:
//   "Ormozi" -> "Hormozi", "Submogic" -> "Submagic", "Fit Lab" -> "FitLab".
// Only fires on close spellings of reasonably long terms, and every snapped
// word is flagged yellow so the creator glances at it once.

const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export function fixVocabulary(words, vocabulary, { minLen = 5, threshold = 0.75 } = {}) {
  const terms = [...new Set(vocabulary.map((t) => String(t).trim()).filter(Boolean))]
    .map((t) => ({ term: t, k: key(t), n: t.split(/\s+/).length }))
    .filter((t) => t.k.length >= minLen);
  if (!terms.length) return words;
  const out = [];
  for (let i = 0; i < words.length; ) {
    let best = null;
    for (const t of terms) {
      // try spans of 1..(term words + 1) words: "Fit Lab" -> "FitLab"
      for (let span = 1; span <= t.n + 1 && i + span <= words.length; span++) {
        const run = words.slice(i, i + span);
        const k = key(run.map((w) => w.text).join(''));
        if (Math.abs(k.length - t.k.length) > 3) continue;
        const s = similarity(k, t.k);
        if (s >= threshold && (!best || s > best.s || (s === best.s && span > best.span))) best = { t, span, s, run };
      }
    }
    if (!best) { out.push(words[i++]); continue; }
    const { run, t, s } = best;
    const exact = s === 1 && run.length === 1 && run[0].text.replace(/[^\p{L}\p{N}\s]+$/u, '') === t.term;
    const trail = run.at(-1).text.match(/[^\p{L}\p{N}']+$/u)?.[0] || '';
    out.push(exact ? run[0] : {
      text: t.term + trail, start: run[0].start, end: run.at(-1).end,
      confidence: Math.min(...run.map((w) => w.confidence ?? 1)), snapped: true,
    });
    i += run.length;
  }
  return out;
}
