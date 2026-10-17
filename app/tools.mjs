// Where the worker finds ffmpeg/ffprobe and the caption fonts.
// Same contract as src/ffmpeg.mjs: FFMPEG_PATH / FFPROBE_PATH, else PATH.
//   Packaged app: <resources>/ffmpeg/ffmpeg[.exe] (copied by electron-builder
//   "extraResources"; see README "Desktop app"), fonts from app.asar.unpacked.
//   Dev: env overrides, then PATH, plus Homebrew folders because apps started
//   from Finder do not inherit the shell's PATH.
import fs from 'node:fs';
import path from 'node:path';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

export function toolPaths({ packaged, resourcesPath, appRoot }) {
  const env = {};
  const bundled = packaged ? path.join(resourcesPath, 'ffmpeg') : path.join(appRoot, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`);
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  for (const [key, name] of [['FFMPEG_PATH', 'ffmpeg'], ['FFPROBE_PATH', 'ffprobe']]) {
    if (process.env[key]) continue;
    const candidates = [path.join(bundled, exe(name)), ...extra.map((d) => path.join(d, name))];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) env[key] = hit; // otherwise src/ffmpeg.mjs falls back to PATH
  }
  if (packaged && !process.env.CAPTIONS_FONTS_DIR) {
    env.CAPTIONS_FONTS_DIR = path.join(resourcesPath, 'app.asar.unpacked', 'fonts');
  }
  return env;
}
