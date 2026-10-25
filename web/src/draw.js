// Canvas caption renderer. One function draws both the live preview and every
// exported frame, so what you see is what you download. It mirrors
// app/renderer/preview.js (and src/ass.mjs): same lines, same style numbers
// (fractions of video height), same four modes: highlight, box, single, reveal.

/** Index of the line on screen at time t (lines are sorted), or -1. */
export function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].end <= t) lo = mid + 1;
    else if (lines[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/** Active word inside a line: the last word that has started (first word during the lead-in). */
export function activeWord(line, t) {
  let a = 0;
  for (let i = 0; i < line.words.length; i++) if (line.words[i].start <= t) a = i;
  return a;
}

const wordText = (w, st) => {
  const t = st.stripPunct ? w.text.replace(/[.,;:!?]+$/u, '') : w.text;
  return st.uppercase ? t.toUpperCase() : t;
};
const fontOf = (st, px) => `${st.bold ? '700' : '400'} ${px.toFixed(2)}px "${st.font}", "Anton", sans-serif`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws the caption for time t onto ctx, for a frame of W x H pixels.
 * Nothing is cleared: the caller draws the video frame (or clears) first.
 */
export function drawCaption(ctx, lines, st, t, W, H) {
  const li = lineAt(lines, t);
  if (li < 0 || !st) return;
  const line = lines[li];
  const k = activeWord(line, t);
  const fs = st.size * H;
  const pop = (st.pop || 100) / 100;
  // Which words are drawn, and at what size.
  let items;
  if (st.mode === 'single') {
    // ass.mjs: \fscx{pop} then \t(0,90) back to 100%: a quick pop on each word.
    const age = Math.max(0, t - line.words[k].start);
    const s = pop + (1 - pop) * Math.min(1, age / 0.09);
    items = [{ text: wordText(line.words[k], st), size: fs * s, active: true }];
  } else {
    items = line.words.map((w, i) => ({
      text: wordText(w, st),
      size: (st.mode === 'highlight' || st.mode === 'reveal') && i === k ? fs * pop : fs,
      active: i === k,
      hidden: st.mode === 'reveal' && i > k,
    }));
  }
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // Measure, then wrap inside the 8% side margins (same as the .ass MarginL/R).
  ctx.font = fontOf(st, fs);
  const space = ctx.measureText(' ').width;
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? fs * 0.8, desc = m.fontBoundingBoxDescent ?? fs * 0.2;
  for (const it of items) { ctx.font = fontOf(st, it.size); it.w = ctx.measureText(it.text).width; }
  // Side margins: 8% each, unless st.insetR asks for a wider right margin
  // (Fit to safe zone keeps lines clear of the TikTok/Reels/Shorts button column).
  const left = W * 0.08, right = W - W * Math.max(0.08, st.insetR || 0);
  const maxW = right - left;
  const rows = [];
  let row = [], rw = 0;
  for (const it of items) {
    const add = (row.length ? space : 0) + it.w;
    if (row.length && rw + add > maxW) { rows.push({ items: row, w: rw }); row = []; rw = 0; }
    rw += (row.length ? space : 0) + it.w; row.push(it);
  }
  if (row.length) rows.push({ items: row, w: rw });
  for (const r of rows) r.h = Math.max(...r.items.map((i) => i.size)) * 1.12;
  const blockH = rows.reduce((n, r) => n + r.h, 0);
  const middle = st.position >= 0.45 && st.position <= 0.55; // same rule as ass.mjs
  let y = middle ? (H - blockH) / 2 : H - st.position * H - blockH;

  const ow = Math.max(0, st.outlineW * H);
  const drop = (st.shadow || 0) * H;
  for (const r of rows) {
    let x = left + (maxW - r.w) / 2;
    for (const it of r.items) {
      const scale = it.size / fs;
      const base = y + (r.h - (asc + desc) * scale) / 2 + asc * scale;
      if (!it.hidden) {
        ctx.font = fontOf(st, it.size);
        const isBox = st.mode === 'box' && it.active;
        if (isBox) {
          const padX = it.size * 0.16, padY = it.size * 0.02;
          ctx.fillStyle = st.box;
          roundRect(ctx, x - padX, base - asc * scale - padY, it.w + padX * 2, (asc + desc) * scale + padY * 2, it.size * 0.14);
          ctx.fill();
        } else {
          // ASS shadow: the outlined text offset by `shadow`, in 50% black.
          if (drop > 0) {
            ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.strokeStyle = 'rgba(0,0,0,.5)';
            if (ow > 0) { ctx.lineWidth = ow * 2; ctx.strokeText(it.text, x + drop, base + drop); }
            ctx.fillText(it.text, x + drop, base + drop);
          }
          if (ow > 0) { ctx.strokeStyle = st.outline; ctx.lineWidth = ow * 2; ctx.strokeText(it.text, x, base); }
        }
        ctx.fillStyle = it.active && st.mode !== 'single' ? st.highlight : st.color;
        ctx.fillText(it.text, x, base);
      }
      x += it.w + space;
    }
    y += r.h;
  }
  ctx.restore();
}

/** Static three-word sample for the style cards. */
export function drawSample(canvas, st) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const words = ['your', 'words', 'pop'].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.3 }));
  const line = { start: 0, end: 1, words };
  // Scale so the sample's font is ~30% of the card height whatever the preset size.
  const k = (H * 0.3) / (st.size * H);
  const s = { ...st, size: st.size * k, outlineW: Math.max(st.outlineW * k, 1 / H), shadow: (st.shadow || 0) * k, position: 0.5 };
  drawCaption(ctx, [line], s, 0.35, W, H);
}
