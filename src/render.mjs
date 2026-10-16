// Burns the .ass captions into the video with ffmpeg + libass.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, run } from './ffmpeg.mjs';

export const FONTS_DIR = process.env.CAPTIONS_FONTS_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');

// ffmpeg filter args need ':' '\' and quotes escaped (Windows paths!).
const fesc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/**
 * @param quality 'draft' (fast preview) | 'high'
 * @param maxHeight optional downscale (e.g. 1080) before burning
 */
export async function burn(input, assFile, output, { quality = 'high', maxHeight, onProgress, duration } = {}) {
  const vf = [];
  if (maxHeight) vf.push(`scale=-2:'min(${maxHeight},ih)'`);
  vf.push(`ass='${fesc(assFile)}':fontsdir='${fesc(FONTS_DIR)}'`);
  const args = [
    '-y', '-v', 'error', '-stats', '-i', input, '-vf', vf.join(','),
    '-c:v', 'libx264', '-preset', quality === 'draft' ? 'veryfast' : 'medium',
    '-crf', quality === 'draft' ? '26' : '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', output,
  ];
  await run(FFMPEG, args, {
    onStderr: (s) => {
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && onProgress && duration) {
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
        onProgress(Math.min(1, t / duration));
      }
    },
  });
  return output;
}
