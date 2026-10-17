// Live caption preview: an HTML approximation of what src/ass.mjs + libass
// burn in. Same lines (built by the engine), same style numbers (fractions of
// video height), same four modes: highlight, box, single, reveal.
/* exported CaptionPreview */
'use strict';

const CaptionPreview = (() => {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wordText = (w, st) => {
    let t = st.stripPunct ? w.text.replace(/[.,;:!?]+$/u, '') : w.text;
    return st.uppercase ? t.toUpperCase() : t;
  };

  /** Index of the line on screen at time t (lines are sorted), or -1. */
  function lineAt(lines, t) {
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
  function activeWord(line, t) {
    let a = 0;
    for (let i = 0; i < line.words.length; i++) if (line.words[i].start <= t) a = i;
    return a;
  }

  // Outline as a ring of text-shadows: renders the same everywhere (CSS
  // -webkit-text-stroke draws inside the glyph and boxes on some GPUs).
  function outline(r, color, drop) {
    const ring = (dx, dy, c) => {
      if (r <= 0) return [`${dx}px ${dy}px 0 ${c}`];
      const n = r > 3 ? 16 : 8, out = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push(`${(dx + Math.cos(a) * r).toFixed(2)}px ${(dy + Math.sin(a) * r).toFixed(2)}px 0 ${c}`);
      }
      return out;
    };
    const parts = r > 0 ? ring(0, 0, color) : [];
    // ASS shadow = the outlined text offset by `shadow`, in the 50%-black BackColour.
    if (drop > 0) parts.push(...ring(drop, drop, 'rgba(0,0,0,.5)'));
    return parts.join(', ') || 'none';
  }

  /** CSS for the caption block at a given frame height (px). */
  function blockCss(st, H) {
    const fs = st.size * H;
    const middle = st.position >= 0.45 && st.position <= 0.55; // same rule as ass.mjs
    return {
      fontFamily: `'${st.font}', 'Anton', sans-serif`,
      fontSize: `${fs}px`,
      fontWeight: st.bold ? '700' : '400',
      color: st.color,
      top: middle ? '50%' : 'auto',
      bottom: middle ? 'auto' : `${st.position * H}px`,
      transform: middle ? 'translateY(-50%)' : 'none',
      textShadow: outline(Math.max(0, st.outlineW * H), st.outline, (st.shadow || 0) * H),
    };
  }

  /** HTML for one line with word k active. */
  function lineHtml(line, k, st) {
    const ws = line.words;
    if (st.mode === 'single') {
      return `<span class="w" data-pop>${esc(wordText(ws[k], st))}</span>`;
    }
    return ws.map((w, i) => {
      const t = esc(wordText(w, st));
      if (st.mode === 'reveal' && i > k) return `<span class="w" data-hide>${t}</span>`;
      if (i !== k) return `<span class="w">${t}</span>`;
      if (st.mode === 'box') return `<span class="w box" data-box>${t}</span>`;
      return `<span class="w" data-hl>${t}</span>`;
    }).join(' ');
  }

  // Inline styles are applied through the CSSOM (allowed by the page CSP).
  function decorate(el, st) {
    for (const w of el.querySelectorAll('.w')) {
      if (w.hasAttribute('data-hide')) w.style.visibility = 'hidden';
      if (w.hasAttribute('data-hl')) {
        w.style.color = st.highlight;
        w.style.fontSize = `${(st.pop || 100) / 100}em`;
      }
      if (w.hasAttribute('data-pop')) w.style.fontSize = `${(st.pop || 100) / 100}em`;
      if (w.hasAttribute('data-box')) {
        w.style.background = st.box;
        w.style.color = st.highlight;
        w.style.textShadow = 'none';
      }
    }
  }

  /**
   * Stateful renderer bound to an overlay element.
   *   const p = CaptionPreview.attach(overlayEl); p.set(lines, style); p.render(t)
   */
  function attach(overlay) {
    let lines = [], st = null, key = '';
    const box = document.createElement('div');
    box.className = 'cap';
    overlay.appendChild(box);
    return {
      set(newLines, style) { lines = newLines || []; st = style; key = ''; },
      render(t) {
        if (!st) return;
        const h = overlay.clientHeight;
        const li = lineAt(lines, t);
        const k = li < 0 ? -1 : activeWord(lines[li], t);
        const nk = `${li}:${k}:${h}`;
        if (nk === key) return;
        key = nk;
        if (li < 0) { box.innerHTML = ''; return; }
        Object.assign(box.style, blockCss(st, h));
        box.innerHTML = lineHtml(lines[li], k, st);
        decorate(box, st);
      },
    };
  }

  /** Static sample for the style cards. */
  function sample(el, st, words = ['your', 'words', 'pop']) {
    const line = { start: 0, end: 1, words: words.map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.3 })) };
    const cap = document.createElement('div');
    cap.className = 'cap';
    const fs = 21;
    Object.assign(cap.style, {
      fontFamily: `'${st.font}', 'Anton', sans-serif`, fontSize: `${fs}px`, color: st.color,
      textShadow: outline(Math.max(1, (st.outlineW / st.size) * fs), st.outline, ((st.shadow || 0) / st.size) * fs),
    });
    cap.innerHTML = lineHtml(line, 1, st);
    decorate(cap, st);
    el.appendChild(cap);
  }

  return { attach, sample, lineAt, activeWord };
})();
