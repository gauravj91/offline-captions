// Words -> caption lines + .ass + .srt. Pure (no native modules), so the
// desktop app's main process can call it on every edit for the live preview.
import { segment, removeFillers } from './segment.mjs';
import { resolveStyle } from './styles.mjs';
import { buildAss } from './ass.mjs';
import { buildSrt } from './srt.mjs';

/** style: preset name or a full style object (e.g. resolveStyle('bold', { size, position })). */
export function buildCaptions(project, { style = 'bold', fillers = true, segmentOpts } = {}) {
  const st = resolveStyle(style);
  const words = fillers ? removeFillers(project.words) : project.words;
  const lines = segment(words, st.mode === 'single' ? { maxWords: 1 } : segmentOpts);
  return {
    lines,
    ass: buildAss(lines, st, { width: project.width, height: project.height }),
    srt: buildSrt(lines),
  };
}
