// In-browser media: audio extraction for Whisper, and the burned-in MP4 export
// (demux with mp4box.js -> WebCodecs VideoDecoder -> canvas + captions ->
// VideoEncoder -> mp4-muxer). Nothing here touches the network.
import MP4Box, { DataStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { drawCaption } from './draw.js';

const SR = 16000;

/** Decodes the file's audio track. Returns the AudioBuffer (or null if the video has no audio). */
export async function decodeAudio(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try {
    return await ac.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    return null;
  } finally {
    ac.close?.();
  }
}

/** 16 kHz mono Float32Array of the first `seconds` of the audio (what Whisper wants). */
export async function toWhisperAudio(buf, seconds) {
  const dur = Math.min(buf.duration, seconds);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * SR)), SR);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start(0, 0, dur);
  const r = await off.startRendering();
  return r.getChannelData(0);
}

// ---------------------------------------------------------------- demux
function demux(arrayBuffer, endSec) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const out = { info: null, video: null, audio: null, vSamples: [], aSamples: [] };
    let expected = 0, got = 0;
    file.onError = (e) => reject(new Error(String(e)));
    file.onReady = (info) => {
      out.info = info;
      out.video = info.videoTracks[0] || null;
      out.audio = info.audioTracks[0] || null;
      for (const t of [out.video, out.audio].filter(Boolean)) {
        file.setExtractionOptions(t.id, t, { nbSamples: 500 });
        expected += t.nb_samples;
      }
      if (!out.video) return reject(new Error('No video track found'));
      file.start();
    };
    file.onSamples = (id, track, samples) => {
      const list = track === out.video ? out.vSamples : out.aSamples;
      for (const s of samples) {
        got++;
        // Keep a margin past the end: B-frames are decoded out of order.
        if (s.dts / s.timescale <= endSec + 1.5) list.push({ is_sync: s.is_sync, cts: s.cts, dts: s.dts, duration: s.duration, timescale: s.timescale, data: s.data });
      }
      file.releaseUsedSamples(id, samples.at(-1).number + 1);
      if (got >= expected) resolve({ ...out, file });
    };
    const buf = arrayBuffer.slice(0);
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    // Files whose sample count we cannot reach (fragmented, truncated): resolve after flush.
    setTimeout(() => (out.info ? resolve({ ...out, file }) : reject(new Error('Not an MP4/MOV file'))), 0);
  });
}

function videoDescription(file, track) {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8); // drop the box header
    }
  }
  return undefined;
}

function aacDescription(file, track) {
  const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
  return entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
}

/** Rotation in degrees from the track matrix (phone videos are often stored sideways). */
function rotationOf(track) {
  const m = track.matrix;
  if (!m) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------- encode helpers
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function outputSize(w, h, maxShort) {
  const s = Math.min(1, maxShort / Math.min(w, h));
  return { width: even(w * s), height: even(h * s), scaled: s < 1 };
}

async function pickVideoCodec(width, height, fps) {
  const bitrate = Math.round(Math.min(14e6, Math.max(2.5e6, width * height * fps * 0.11)));
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  // H.264 High: level 4.0 up to 1080p30 (245,760 MB/s), 4.2 up to 1080p60.
  const level = mbps <= 245760 ? '28' : mbps <= 522240 ? '2a' : '33';
  const candidates = [
    { codec: `avc1.6400${level}`, mux: 'avc' }, { codec: `avc1.4d00${level}`, mux: 'avc' },
    { codec: 'vp09.00.41.08', mux: 'vp9' }, { codec: 'av01.0.08M.08', mux: 'av1' },
  ];
  for (const c of candidates) {
    const cfg = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, mux: c.mux };
    } catch { /* try next */ }
  }
  throw new Error('This browser cannot encode video (WebCodecs VideoEncoder). Try Chrome or Edge, or download the SRT.');
}

async function pickAudioCodec(channels) {
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac', sampleRate: 48000 }, { codec: 'opus', mux: 'opus', sampleRate: 48000 }]) {
    const cfg = { codec: c.codec, sampleRate: c.sampleRate, numberOfChannels: channels, bitrate: 160000 };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, mux: c.mux };
    } catch { /* next */ }
  }
  return null;
}

const until = (cond) => new Promise((r) => { const f = () => (cond() ? r() : setTimeout(f, 1)); f(); });

/** Re-encodes decoded audio (used when the source audio is not AAC, or not an MP4). */
async function encodeAudioBuffer(buf, endSec, muxerRef, onChunk) {
  const channels = Math.min(2, buf.numberOfChannels);
  const pick = await pickAudioCodec(channels);
  if (!pick) return null;
  const sr = pick.cfg.sampleRate;
  const dur = Math.min(buf.duration, endSec);
  const off = new OfflineAudioContext(channels, Math.ceil(dur * sr), sr);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start(0, 0, dur);
  const pcm = await off.startRendering();
  return {
    mux: { codec: pick.mux, numberOfChannels: channels, sampleRate: sr },
    async run() {
      const enc = new AudioEncoder({ output: (chunk, meta) => onChunk(chunk, meta), error: (e) => { throw e; } });
      enc.configure(pick.cfg);
      const N = 4096;
      for (let i = 0; i < pcm.length; i += N) {
        const n = Math.min(N, pcm.length - i);
        const data = new Float32Array(n * channels);
        for (let c = 0; c < channels; c++) data.set(pcm.getChannelData(c).subarray(i, i + n), c * n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((i / sr) * 1e6), data });
        enc.encode(ad); ad.close();
        if (enc.encodeQueueSize > 20) await until(() => enc.encodeQueueSize < 10);
      }
      await enc.flush(); enc.close();
    },
  };
}

/**
 * Burns the captions into an MP4.
 * @param file        the user's File (stays in memory, never uploaded)
 * @param audioBuffer decoded audio (fallback re-encode), may be null
 * @param lines/style caption lines (segment.mjs) and resolved style
 * @param endSec      stop here (web trial limit)
 * @param maxShort    export cap for the short side (1080)
 * @returns {blob, width, height, codec, audio, ms, frames}
 */
export async function exportMp4({ file, arrayBuffer, audioBuffer, lines, style, endSec, maxShort, onProgress }) {
  const t0 = performance.now();
  let dm = null;
  try { dm = await demux(arrayBuffer, endSec); } catch { dm = null; }
  let decCfg = null;
  if (dm?.video) {
    decCfg = { codec: dm.video.codec, codedWidth: dm.video.video.width, codedHeight: dm.video.video.height, description: videoDescription(dm.file, dm.video) };
    try { if (!(await VideoDecoder.isConfigSupported(decCfg)).supported) decCfg = null; } catch { decCfg = null; }
  }
  if (!decCfg) return exportViaVideoElement({ file, audioBuffer, lines, style, endSec, maxShort, onProgress, t0 });

  const rot = rotationOf(dm.video);
  const srcW = dm.video.video.width, srcH = dm.video.video.height;
  const dispW = rot % 180 ? srcH : srcW, dispH = rot % 180 ? srcW : srcH;
  const { width, height } = outputSize(dispW, dispH, maxShort);
  const ts = dm.video.timescale;
  const vs = dm.vSamples;
  const t0cts = Math.min(...vs.slice(0, 32).map((s) => s.cts)); // edit-list approximation: first shown frame = 0
  const fps = Math.min(60, Math.max(1, Math.round(dm.video.nb_samples / (dm.video.duration / ts)))) || 30;
  const vcodec = await pickVideoCodec(width, height, fps);

  // Audio: copy AAC as-is (no quality loss, no encoder needed); otherwise re-encode.
  let audioMux = null, audioCopy = false, audioJob = null;
  const aChunks = [];
  if (dm.audio) {
    const desc = /^mp4a\.40/.test(dm.audio.codec) ? aacDescription(dm.file, dm.audio) : null;
    if (desc) {
      audioCopy = true;
      audioMux = { codec: 'aac', numberOfChannels: dm.audio.audio.channel_count, sampleRate: dm.audio.audio.sample_rate };
    } else if (audioBuffer) {
      audioJob = await encodeAudioBuffer(audioBuffer, endSec, null, (c, m) => aChunks.push([c, m]));
      audioMux = audioJob?.mux || null;
    }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: vcodec.mux, width, height, frameRate: fps },
    ...(audioMux ? { audio: audioMux } : {}),
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  let encErr = null, frames = 0, lastKey = -Infinity;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  encoder.configure(vcodec.cfg);
  const total = vs.filter((s) => (s.cts - t0cts) / ts < endSec).length || 1;

  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      if (t >= endSec || t < 0) { frame.close(); return; }
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
      ctx.translate(width / 2, height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      const dw = rot % 180 ? height : width, dh = rot % 180 ? width : height;
      ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      drawCaption(ctx, lines, style, t, width, height);
      const vf = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || Math.round(1e6 / fps) });
      const key = t - lastKey >= 2;
      if (key) lastKey = t;
      encoder.encode(vf, { keyFrame: key });
      vf.close(); frame.close();
      frames++;
      onProgress?.(Math.min(0.99, frames / total));
    },
    error: (e) => { encErr = e; },
  });
  decoder.configure(decCfg);

  for (const s of vs) {
    if (encErr) throw encErr;
    if (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 6) await until(() => encErr || (decoder.decodeQueueSize <= 3 && encoder.encodeQueueSize <= 3));
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round(((s.cts - t0cts) / ts) * 1e6),
      duration: Math.round((s.duration / ts) * 1e6),
      data: s.data,
    }));
  }
  await decoder.flush(); decoder.close();
  await encoder.flush(); encoder.close();
  if (encErr) throw encErr;

  if (audioCopy) {
    const ats = dm.audio.timescale;
    const meta = { decoderConfig: { codec: dm.audio.codec, numberOfChannels: audioMux.numberOfChannels, sampleRate: audioMux.sampleRate, description: aacDescription(dm.file, dm.audio) } };
    let first = true;
    for (const s of dm.aSamples) {
      const tsec = s.cts / ats;
      if (tsec >= endSec) break;
      muxer.addAudioChunkRaw(s.data, 'key', Math.round(tsec * 1e6), Math.round((s.duration / ats) * 1e6), first ? meta : undefined);
      first = false;
    }
  } else if (audioJob) {
    await audioJob.run();
    for (const [c, m] of aChunks) muxer.addAudioChunk(c, m);
  }
  muxer.finalize();
  onProgress?.(1);
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }), width, height, fps, frames,
    codec: vcodec.cfg.codec, audio: audioCopy ? 'AAC (copied)' : audioMux ? `${audioMux.codec} (re-encoded)` : 'none',
    ms: Math.round(performance.now() - t0), path: 'webcodecs',
  };
}

/** Fallback for files mp4box cannot read (WebM, MKV): seek a <video> frame by frame. */
async function exportViaVideoElement({ file, audioBuffer, lines, style, endSec, maxShort, onProgress, t0 }) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  const url = URL.createObjectURL(file);
  v.src = url;
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('This browser cannot decode this video. Try an MP4 (H.264).')); });
  const { width, height } = outputSize(v.videoWidth, v.videoHeight, maxShort);
  const fps = 30;
  const vcodec = await pickVideoCodec(width, height, fps);
  const aChunks = [];
  const audioJob = audioBuffer ? await encodeAudioBuffer(audioBuffer, endSec, null, (c, m) => aChunks.push([c, m])) : null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, fastStart: 'in-memory', firstTimestampBehavior: 'offset', video: { codec: vcodec.mux, width, height, frameRate: fps }, ...(audioJob ? { audio: audioJob.mux } : {}) });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  let encErr = null;
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
  encoder.configure(vcodec.cfg);
  const end = Math.min(endSec, v.duration || endSec);
  const n = Math.floor(end * fps);
  for (let i = 0; i < n; i++) {
    if (encErr) throw encErr;
    const t = i / fps;
    await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
    ctx.drawImage(v, 0, 0, width, height);
    drawCaption(ctx, lines, style, t, width, height);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
    if (encoder.encodeQueueSize > 6) await until(() => encoder.encodeQueueSize <= 3);
    onProgress?.(Math.min(0.99, i / n));
  }
  await encoder.flush(); encoder.close();
  if (audioJob) { await audioJob.run(); for (const [c, m] of aChunks) muxer.addAudioChunk(c, m); }
  muxer.finalize();
  URL.revokeObjectURL(url);
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), width, height, fps, frames: n, codec: vcodec.cfg.codec, audio: audioJob ? `${audioJob.mux.codec} (re-encoded)` : 'none', ms: Math.round(performance.now() - t0), path: 'seek' };
}
