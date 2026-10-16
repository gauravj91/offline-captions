// Locates ffmpeg/ffprobe and runs them. The desktop app will ship its own
// LGPL ffmpeg build and set FFMPEG_PATH / FFPROBE_PATH; in dev we use PATH.
import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(bin, args, { collect = 'stdout', onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 20000) err = err.slice(-20000);
      onStderr?.(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${err.slice(-2000)}`));
      resolve(collect === 'buffer' ? Buffer.concat(out) : Buffer.concat(out).toString());
    });
  });
}

/** Width, height, duration (s) of the first video stream. */
export async function probe(file) {
  const json = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(json);
  const s = j.streams?.[0] || {};
  let { width = 1080, height = 1920 } = s;
  const rot = Math.abs(s.side_data_list?.find((d) => d.rotation != null)?.rotation || 0);
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  return { width, height, duration: Number(j.format?.duration || 0) };
}

/** Decodes the audio track to 16 kHz mono Float32 PCM (what Whisper expects). */
export async function extractAudio(file) {
  const buf = await run(FFMPEG, [
    '-v', 'error', '-i', file, '-vn', ...(process.env.CAPTIONS_DENOISE !== '1' ? [] : ['-af', 'highpass=f=80,afftdn=nf=-25,loudnorm']), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
  ], { collect: 'buffer' });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
