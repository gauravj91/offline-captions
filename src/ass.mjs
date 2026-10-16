// Builds an Advanced SubStation Alpha (.ass) file with per-word animation.
// libass (inside ffmpeg) renders it, so the same file previews and burns in.

/** #RRGGBB -> &HAABBGGRR (ASS colour, alpha 00 = opaque) */
export function assColor(hex, alpha = 0) {
  const h = hex.replace('#', '');
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

export function assTime(t) {
  t = Math.max(0, t);
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, ' ');

export function buildAss(lines, style, { width, height }) {
  const fs = Math.round(style.size * height);
  const outline = Math.max(0, Math.round(style.outlineW * height));
  const shadow = Math.max(0, Math.round((style.shadow || 0) * height));
  const marginV = Math.round(style.position * height);
  const align = style.position >= 0.45 && style.position <= 0.55 ? 5 : 2; // middle or bottom-centre
  const c = assColor(style.color), hl = assColor(style.highlight), oc = assColor(style.outline);
  const txt = (w) => {
    let t = style.stripPunct ? w.text.replace(/[.,;:!?]+$/u, '') : w.text;
    return esc(style.uppercase ? t.toUpperCase() : t);
  };

  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${style.font},${fs},${c},${hl},${oc},${assColor('#000000', 0x80)},${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},${shadow},${align},${Math.round(width * 0.08)},${Math.round(width * 0.08)},${align === 5 ? 0 : marginV},1`,
    '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const ev = [];
  const push = (start, end, text, layer = 0) => {
    if (end - start >= 0.01) ev.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
  };
  const popTag = (s = style.pop) => (s && s !== 100
    ? `{\\fscx${s}\\fscy${s}\\t(0,90,\\fscx100\\fscy100)}` : '');

  for (const line of lines) {
    const ws = line.words;
    if (style.mode === 'single') {
      ws.forEach((w, i) => push(w.start, i + 1 < ws.length ? ws[i + 1].start : line.end,
        `{\\fad(0,0)}${popTag()}${txt(w)}`));
      continue;
    }
    // Before the first word starts (line hold from the previous gap) show plain line.
    for (let i = 0; i < ws.length; i++) {
      const start = i === 0 ? line.start : ws[i].start;
      const end = i + 1 < ws.length ? ws[i + 1].start : line.end;
      const parts = ws.map((w, k) => {
        const t = txt(w);
        if (style.mode === 'reveal' && k > i) return `{\\alpha&HFF&}${t}{\\alpha&H00&}`;
        if (k !== i) return t;
        if (style.mode === 'box') {
          // Opaque box around the active word via BorderStyle-like trick: thick
          // outline in box colour + no blur. Reads as a highlight pill.
          const bw = Math.round(fs * 0.18);
          return `{\\3c${assColor(style.box)}\\bord${bw}\\shad0}${t}{\\3c${oc}\\bord${outline}\\shad${shadow}}`;
        }
        const s = style.pop || 100;
        return `{\\1c${hl}\\fscx${s}\\fscy${s}}${t}{\\1c${c}\\fscx100\\fscy100}`;
      });
      push(start, end, parts.join(' '));
    }
  }
  return header.join('\n') + '\n' + ev.join('\n') + '\n';
}
