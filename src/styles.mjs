// Caption style presets. Colours are CSS hex (#RRGGBB); sizes are a fraction
// of video height so a preset looks the same at 720p, 1080p or 4K.
export const PRESETS = {
  // Big, bold, all caps, active word turns yellow and pops. The "Hormozi" look.
  bold: {
    font: 'Anton', bold: false, size: 0.068, uppercase: true,
    color: '#FFFFFF', highlight: '#FFE500', outline: '#000000', outlineW: 0.006, shadow: 0.003,
    pop: 112, position: 0.30, mode: 'highlight', stripPunct: true,
  },
  // Calm sentence case, active word gets a coloured box behind it.
  clean: {
    font: 'Montserrat Thin ExtraBold', bold: false, size: 0.046, uppercase: false,
    color: '#FFFFFF', highlight: '#FFFFFF', box: '#7C3AED', outline: '#000000', outlineW: 0.003, shadow: 0,
    pop: 100, position: 0.25, mode: 'box',
  },
  // One word at a time, huge, centred. Fast-paced edits.
  punch: {
    font: 'Anton', bold: false, size: 0.085, uppercase: true,
    color: '#FFFFFF', highlight: '#FFFFFF', outline: '#000000', outlineW: 0.008, shadow: 0.004,
    pop: 115, position: 0.5, mode: 'single', stripPunct: true,
  },
  // Words appear as they are spoken (karaoke reveal), soft green highlight.
  reveal: {
    font: 'Montserrat Thin ExtraBold', bold: false, size: 0.050, uppercase: false,
    color: '#FFFFFF', highlight: '#22C55E', outline: '#000000', outlineW: 0.005, shadow: 0.002,
    pop: 105, position: 0.30, mode: 'reveal',
  },
};

export function resolveStyle(nameOrObj, overrides = {}) {
  const base = typeof nameOrObj === 'string' ? PRESETS[nameOrObj] : nameOrObj;
  if (!base) throw new Error(`Unknown style "${nameOrObj}". Try: ${Object.keys(PRESETS).join(', ')}`);
  return { ...base, ...overrides };
}
