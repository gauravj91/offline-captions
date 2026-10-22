const ts = (t) => {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};

/** Plain subtitles (for YouTube upload, accessibility, other editors). */
export function buildSrt(lines) {
  return lines
    .map((l, i) => `${i + 1}\n${ts(l.start)} --> ${ts(l.end)}\n${l.words.map((w) => w.text).join(' ')}\n`)
    .join('\n');
}

/** WebVTT (web players, HTML5 <track>, many editors). */
export function buildVtt(lines) {
  const vt = (t) => ts(t).replace(',', '.');
  return 'WEBVTT\n\n' + lines
    .map((l) => `${vt(l.start)} --> ${vt(l.end)}\n${l.words.map((w) => w.text).join(' ')}\n`)
    .join('\n');
}

/** Plain-text transcript, one caption line per row. */
export function buildTxt(lines) {
  return lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n') + '\n';
}
