// Builds dist/: the static site Vercel (or any static host) serves.
//   node build.mjs          -> dist/
// Bundles src/main.js (UI) and src/worker.js (Whisper) with esbuild, copies the
// ONNX Runtime WASM files, the OFL fonts and the landing site-config.js, so
// nothing is fetched from a CDN at runtime. Only the speech model is downloaded
// (from Hugging Face, once, into the browser cache).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'dist');
const watch = process.argv.includes('--watch');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor/ort'), { recursive: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

const common = {
  bundle: true, format: 'esm', target: ['chrome113', 'firefox130', 'safari17'], minify: !watch, sourcemap: true,
  logLevel: 'info', platform: 'browser',
  // One copy of transformers.js even when we import helpers from ../src/engines.
  alias: { '@huggingface/transformers': path.join(here, 'node_modules/@huggingface/transformers/dist/transformers.web.js') },
  // onnxruntime-web pulls Node-only modules behind runtime checks.
  external: ['fs', 'path', 'url', 'worker_threads', 'module', 'sharp', 'onnxruntime-node'],
  define: { 'process.env.NODE_ENV': '"production"' },
};
await esbuild.build({ ...common, entryPoints: { app: path.join(here, 'src/main.js'), worker: path.join(here, 'src/worker.js') }, outdir: out });

// ONNX Runtime WASM (threaded + SIMD; JSEP build also carries the WebGPU EP).
const ortDist = path.join(here, 'node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) fs.copyFileSync(path.join(ortDist, f), path.join(out, 'vendor/ort', f));
for (const f of ['Anton-Regular.ttf', 'Montserrat-ExtraBold.ttf', 'OFL-Anton.txt', 'OFL-Montserrat.txt']) fs.copyFileSync(path.join(here, '../fonts', f), path.join(out, 'fonts', f));
fs.copyFileSync(path.join(here, '../landing/site-config.js'), path.join(out, 'site-config.js'));
fs.copyFileSync(path.join(here, '../landing/analytics.js'), path.join(out, 'analytics.js'));
for (const f of ['index.html', 'app.css', 'config.js']) fs.copyFileSync(path.join(here, f), path.join(out, f));
fs.copyFileSync(path.join(here, 'vercel.json'), path.join(out, 'vercel.json'));
console.log('built', out);
