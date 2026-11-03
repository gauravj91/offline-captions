// Groups words into short caption lines that read well on vertical video.
const FILLERS = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'mm', 'ah']);

// Whisper sometimes emits speaker-change marks (">>", "-") as words or glued to a word.
// Strip them, and drop tokens left with no letters or digits, so they never reach captions.
export function cleanMarks(words) {
  const out = [];
  for (const w of words) {
    const text = String(w.text).replace(/^\s*(?:>{2,}|&gt;&gt;)\s*/, '').replace(/\s*(?:>{2,}|&gt;&gt;)\s*$/, '').trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    out.push(text === w.text ? w : { ...w, text });
  }
  return out;
}

export function removeFillers(words) {
  return words.filter((w) => !FILLERS.has(w.text.toLowerCase().replace(/[^a-z]/g, '')));
}

/**
 * @param words [{text,start,end}]
 * @param opts maxWords, maxChars, maxDur (s), gap (s) that forces a break
 * @returns [{start,end,words:[...]}]
 */
export function segment(words, { maxWords = 4, maxChars = 22, maxDur = 2.5, gap = 0.6 } = {}) {
  words = cleanMarks(words);
  const lines = [];
  let cur = [];
  const flush = () => {
    if (cur.length) lines.push({ start: cur[0].start, end: cur.at(-1).end, words: cur });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const prev = cur.at(-1);
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      if (
        cur.length >= maxWords || chars > maxChars ||
        w.end - cur[0].start > maxDur || w.start - prev.end > gap ||
        /[.!?]$/.test(prev.text) || (/[,;:]$/.test(prev.text) && cur.length >= 2)
      ) flush();
    }
    cur.push(w);
  }
  flush();
  // Hold each line on screen until the next starts (max 0.5 s) to avoid flicker.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const hold = next ? Math.min(next.start, lines[i].end + 0.5) : lines[i].end + 0.5;
    lines[i].end = Math.max(lines[i].end, hold);
  }
  return lines;
}
