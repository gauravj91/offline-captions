// "Paste a link" import: downloads the user's OWN video from a cloud share link
// (Google Drive, Dropbox, OneDrive/SharePoint, or any direct https link to a
// video file) into a local folder, so it can be queued like a dropped file.
//
// This is the only network use in the app besides the one-time model
// download, and it only runs when the user presses Add. Everything here except
// downloadLink() is pure (no network, no fs) so it can be unit tested offline.
//
// We do NOT download from YouTube or social sites: their terms don't allow it.
// The host list lives in BLOCKED_HOSTS below and nowhere else.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BYTES = 4 * 1024 ** 3; // 4 GB
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'];

/** Video/social platforms whose terms don't allow downloading. Matches the host and any subdomain. */
export const BLOCKED_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com',
  'instagram.com', 'cdninstagram.com', 'instagr.am',
  'tiktok.com', 'tiktokcdn.com', 'tiktokv.com',
  'facebook.com', 'fb.watch', 'fb.com', 'fbcdn.net',
  'x.com', 'twitter.com', 't.co', 'twimg.com',
  'threads.net', 'threads.com', 'snapchat.com', 'linkedin.com', 'pinterest.com', 'pin.it',
  'reddit.com', 'redd.it', 'vimeo.com', 'twitch.tv', 'dailymotion.com', 'dai.ly',
  'kick.com', 'rumble.com', 'bilibili.com', 'likee.video', 'triller.co',
];

export const BLOCKED_MESSAGE = "We don't download from YouTube or social sites: their terms don't allow it. "
  + 'Use the original file from your phone or computer, or a Drive/Dropbox link.';

export const MESSAGES = {
  invalid: 'That doesn\'t look like a link. Paste a Google Drive or Dropbox share link (it starts with https://).',
  http: 'Only secure https:// links are supported.',
  driveFolder: 'That\'s a Drive folder. Open the video inside it and copy that file\'s link instead.',
  driveDoc: 'That\'s a Google Docs/Sheets/Slides link, not a video. Share the video file itself.',
  driveNoId: 'Couldn\'t find the file in that Drive link. Use Share > Copy link on the video.',
  driveNotShared: 'This Drive file isn\'t shared as \'Anyone with the link\'. In Drive, choose Share > General access > Anyone with the link, then paste it again.',
  driveMissing: 'Couldn\'t open this Drive file. Make sure it\'s shared as \'Anyone with the link\' and hasn\'t been deleted, then paste the link again.',
  driveQuota: 'Google Drive says this file has been downloaded too many times recently. Try again later, or download it in your browser and drop it here.',
  dropboxFolder: 'That\'s a Dropbox folder. Open the video inside it and copy that file\'s link instead.',
  dropboxNotShared: 'This Dropbox link isn\'t public or has been removed. In Dropbox, use Share > Copy link on the video, then paste it again.',
  onedriveNotShared: 'This OneDrive link isn\'t shared with \'Anyone with the link\', or it has expired.',
  notFound: 'That file wasn\'t found. It may have been moved or deleted; check the link.',
  notVideo: 'That link didn\'t lead to a video file. Paste a link to the video itself (MP4, MOV, MKV, WebM).',
  webPage: 'That link opens a web page, not a video file. Paste a share link from Google Drive or Dropbox, or a direct link to the video.',
  tooBig: 'That video is larger than 4 GB, which is the limit for links. Download it and drop the file here instead.',
  network: 'Couldn\'t reach that link. Check your internet connection and try again.',
  cancelled: 'Download cancelled.',
};

const SERVICE_LABEL = { gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive', direct: 'link' };

function hostMatches(host, list) {
  host = host.toLowerCase().replace(/\.$/, '');
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

export const isBlockedHost = (host) => hostMatches(host, BLOCKED_HOSTS);

function fail(code, message) {
  const e = new Error(message || MESSAGES[code]);
  e.code = code;
  return e;
}

/** Google Drive file id from any of the usual share-link shapes, else null. */
export function driveFileId(u) {
  const m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  const id = u.searchParams.get('id');
  if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  return null;
}

export const driveDownloadUrl = (id) =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

/** Dropbox share link -> direct download (dl=1). Keeps rlkey/st on /scl/ links. */
export function dropboxDownloadUrl(u) {
  const out = new URL(u.href);
  out.protocol = 'https:';
  if (out.hostname === 'dropbox.com') out.hostname = 'www.dropbox.com';
  out.searchParams.delete('raw');
  out.searchParams.set('dl', '1');
  out.hash = '';
  return out.href;
}

/** OneDrive personal share link -> the public "shares" content endpoint. */
export function onedriveDownloadUrl(href) {
  const token = 'u!' + Buffer.from(href, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `https://api.onedrive.com/v1.0/shares/${token}/root/content`;
}

/**
 * Classifies a pasted link. Never touches the network.
 * Returns { ok: true, service, label, url (what to download), source (as pasted) }
 * or { ok: false, code, message } (code 'blocked' for YouTube/social sites).
 */
export function parseLink(input) {
  let s = String(input ?? '').trim().replace(/^<|>$/g, '');
  if (!s) return { ok: false, code: 'invalid', message: MESSAGES.invalid };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // "youtu.be/abc" or "drive.google.com/..." pasted without the scheme.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) s = `https://${s}`;
    else return { ok: false, code: 'invalid', message: MESSAGES.invalid };
  }
  let u;
  try { u = new URL(s); } catch { return { ok: false, code: 'invalid', message: MESSAGES.invalid }; }
  const host = u.hostname.toLowerCase();
  // Blocked hosts first, whatever the scheme, so the user gets the right note.
  if (isBlockedHost(host)) return { ok: false, code: 'blocked', message: BLOCKED_MESSAGE };
  if (u.protocol === 'http:') return { ok: false, code: 'http', message: MESSAGES.http };
  if (u.protocol !== 'https:' || !host.includes('.')) return { ok: false, code: 'invalid', message: MESSAGES.invalid };
  if (u.username || u.password) return { ok: false, code: 'invalid', message: MESSAGES.invalid };

  const ok = (service, url) => ({ ok: true, service, label: SERVICE_LABEL[service], url, source: u.href });

  if (hostMatches(host, ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'])) {
    if (/\/(drive\/(u\/\d+\/)?folders|folderview)/.test(u.pathname)) return { ok: false, code: 'driveFolder', message: MESSAGES.driveFolder };
    if (/^\/(document|spreadsheets|presentation|forms|drawings)\//.test(u.pathname)) return { ok: false, code: 'driveDoc', message: MESSAGES.driveDoc };
    const id = driveFileId(u);
    if (!id) return { ok: false, code: 'driveNoId', message: MESSAGES.driveNoId };
    return { ...ok('gdrive', driveDownloadUrl(id)), id };
  }
  if (hostMatches(host, ['dropbox.com', 'dropboxusercontent.com'])) {
    if (/^\/(scl\/fo|sh)\//.test(u.pathname)) return { ok: false, code: 'dropboxFolder', message: MESSAGES.dropboxFolder };
    if (host.endsWith('dropboxusercontent.com')) return ok('dropbox', u.href);
    return ok('dropbox', dropboxDownloadUrl(u));
  }
  if (host === '1drv.ms' || hostMatches(host, ['onedrive.live.com'])) {
    if (u.searchParams.get('download') === '1' || /\/download(\.aspx)?$/i.test(u.pathname)) return ok('onedrive', u.href);
    return ok('onedrive', onedriveDownloadUrl(u.href));
  }
  if (hostMatches(host, ['sharepoint.com'])) {
    const out = new URL(u.href);
    out.searchParams.set('download', '1');
    return ok('onedrive', out.href);
  }
  return ok('direct', u.href);
}

// ---------- response helpers (pure) ----------

/** File name from a Content-Disposition header (RFC 6266 / 5987), else null. */
export function filenameFromDisposition(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = header.match(/filename\s*=\s*("((?:\\.|[^"\\])*)"|[^;]+)/i);
  if (plain) return (plain[2] ?? plain[1]).replace(/\\(.)/g, '$1').trim() || null;
  return null;
}

const TYPE_EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm',
  'video/x-matroska': 'mkv', 'video/matroska': 'mkv', 'application/x-matroska': 'mkv',
  'video/x-msvideo': 'avi', 'video/avi': 'avi', 'video/msvideo': 'avi', 'application/mp4': 'mp4',
};

const baseType = (ct) => String(ct || '').split(';')[0].trim().toLowerCase();

/**
 * Whether a Content-Type can be a video file. 'html' for web pages (sign-in
 * walls, interstitials), true for video or generic binary (checked with ffprobe
 * after download), false for anything clearly not a video.
 */
export function classifyContentType(ct) {
  const t = baseType(ct);
  if (!t) return true;
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (t.startsWith('video/') || TYPE_EXT[t]) return true;
  if (['application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/x-download', 'application/force-download', 'application/download'].includes(t)) return true;
  return false;
}

/** Safe local file name with a video extension the queue accepts. */
export function safeFilename(name, contentType) {
  let n = String(name || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  if (!n) n = 'linked-video';
  const ext = (n.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) n = `${n}.${TYPE_EXT[baseType(contentType)] || 'mp4'}`;
  return n;
}

/** The hidden-field form on Google Drive's "can't scan for viruses" page -> its download URL, else null. */
export function driveConfirmUrl(html, base = 'https://drive.usercontent.google.com/download') {
  const form = html.match(/<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i) || html.match(/<form[^>]*action="[^"]*\/download[^"]*"[^>]*>([\s\S]*?)<\/form>/i);
  if (form) {
    const action = form[0].match(/action="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&') || base;
    const url = new URL(action, base);
    for (const m of form[1].matchAll(/<input[^>]*>/gi)) {
      const name = m[0].match(/name="([^"]*)"/i)?.[1];
      const value = m[0].match(/value="([^"]*)"/i)?.[1] ?? '';
      if (name) url.searchParams.set(name, value.replace(/&amp;/g, '&'));
    }
    return url.href;
  }
  // Older page: a plain "Download anyway" link with a confirm token.
  const a = html.match(/href="(\/uc\?export=download[^"]*confirm=[^"]+)"/i);
  if (a) return new URL(a[1].replace(/&amp;/g, '&'), 'https://drive.google.com').href;
  return null;
}

/** Friendly error for a web page we got instead of a file. */
export function htmlError(service, html, finalUrl = '') {
  if (service === 'gdrive') {
    if (/too many users have viewed or downloaded|download quota/i.test(html)) return fail('driveQuota');
    return fail('driveNotShared');
  }
  if (/accounts\.google\.com|ServiceLogin/i.test(finalUrl)) return fail('driveNotShared');
  if (service === 'dropbox') return fail('dropboxNotShared');
  if (service === 'onedrive') return fail('onedriveNotShared');
  return fail('webPage');
}

function statusError(service, status) {
  if (status === 404 || status === 410) {
    // Drive answers 404 both for deleted files and for files the link can't see.
    return fail({ gdrive: 'driveMissing', dropbox: 'dropboxNotShared', onedrive: 'onedriveNotShared' }[service] || 'notFound');
  }
  if (status === 401 || status === 403) {
    return fail({ gdrive: 'driveNotShared', dropbox: 'dropboxNotShared', onedrive: 'onedriveNotShared' }[service] || 'webPage',
      service === 'direct' ? 'That link needs a sign-in, so we can\'t download it. Use a public share link instead.' : undefined);
  }
  if (status === 429 && service === 'gdrive') return fail('driveQuota');
  return fail('network', `The server returned an error (${status}). Check the link and try again.`);
}

// ---------- download (network + fs) ----------

/**
 * Downloads a parsed link into its own new folder under destDir.
 * opts: fetch (defaults to global fetch), signal, onProgress({received,total}),
 *       verify(file) -> true | false | null (null = could not check), maxBytes.
 * Resolves { file, name, bytes, service }. Cleans up its folder on any failure.
 */
export async function downloadLink(link, destDir, opts = {}) {
  const parsed = typeof link === 'string' ? parseLink(link) : link;
  if (!parsed?.ok) throw fail(parsed?.code || 'invalid', parsed?.message);
  const { signal, onProgress, verify, maxBytes = MAX_BYTES } = opts;
  const doFetch = opts.fetch || globalThis.fetch;
  const dir = path.join(destDir, crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  let partFile = null;
  try {
    const get = async (url) => {
      try {
        return await doFetch(url, { redirect: 'follow', signal, headers: { 'User-Agent': 'OfflineCaptions/1 (+https://offlinecaptions.com)', Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5' } });
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') throw fail('cancelled');
        throw fail('network');
      }
    };
    let res = await get(parsed.url);
    let kind = res.ok ? classifyContentType(res.headers.get('content-type')) : null;
    // Large Drive files: a "can't scan for viruses" page with a confirm form.
    if (res.ok && kind === 'html' && parsed.service === 'gdrive') {
      const html = await res.text();
      const next = driveConfirmUrl(html);
      if (!next) throw htmlError('gdrive', html, res.url);
      res = await get(next);
      kind = res.ok ? classifyContentType(res.headers.get('content-type')) : null;
    }
    if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw statusError(parsed.service, res.status); }
    if (kind === 'html') throw htmlError(parsed.service, await res.text().catch(() => ''), res.url);
    if (kind === false) { res.body?.cancel?.().catch(() => {}); throw fail('notVideo'); }

    const total = Number(res.headers.get('content-length')) || 0;
    if (total > maxBytes) { res.body?.cancel?.().catch(() => {}); throw fail('tooBig'); }
    const urlName = decodeURIComponent(new URL(res.url || parsed.url).pathname.split('/').pop() || '');
    const name = safeFilename(filenameFromDisposition(res.headers.get('content-disposition'))
      || (parsed.service === 'direct' || parsed.service === 'dropbox' ? urlName : '') || '', res.headers.get('content-type'));
    const file = path.join(dir, name);
    partFile = `${file}.part`;

    const out = fs.createWriteStream(partFile);
    const outDone = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    outDone.catch(() => {}); // awaited below; don't let an early failure go unhandled
    let received = 0, lastTick = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (received > maxBytes) throw fail('tooBig');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (onProgress && now - lastTick > 100) { lastTick = now; onProgress({ received, total }); }
      }
    } catch (e) {
      if (!out.closed) await new Promise((r) => { out.once('close', r); out.destroy(); });
      if (e.code) throw e;
      if (signal?.aborted || e?.name === 'AbortError') throw fail('cancelled');
      throw fail('network', 'The download was interrupted. Check your connection and try again.');
    }
    out.end();
    await outDone;
    if (!received) throw fail('notVideo');
    onProgress?.({ received, total: total || received });
    fs.renameSync(partFile, file);
    partFile = null;
    if (verify && (await verify(file)) === false) throw fail('notVideo');
    return { file, name, bytes: received, service: parsed.service };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
