// "Paste a link" import. No network: downloads use a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLink, isBlockedHost, BLOCKED_MESSAGE, MESSAGES, filenameFromDisposition, classifyContentType,
  safeFilename, driveConfirmUrl, downloadLink, onedriveDownloadUrl,
} from '../src/fetch-link.mjs';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const DRIVE_DL = `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`;

test('Google Drive: /file/d/ID/view, open?id=, uc?id= and friends', () => {
  for (const u of [
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view`,
    `https://drive.google.com/file/d/${ID}`,
    `https://drive.google.com/file/u/1/d/${ID}/edit`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?id=${ID}&export=download`,
    `https://drive.google.com/u/0/uc?id=${ID}&export=download`,
    `https://docs.google.com/uc?export=download&id=${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}`,
    `drive.google.com/file/d/${ID}/view`, // pasted without https://
    `  https://drive.google.com/file/d/${ID}/view?usp=drive_link  `,
  ]) {
    const r = parseLink(u);
    assert.equal(r.ok, true, u);
    assert.equal(r.service, 'gdrive', u);
    assert.equal(r.id, ID, u);
    assert.equal(r.url, DRIVE_DL, u);
  }
});

test('Google Drive: folders, Docs and id-less links get a clear message', () => {
  assert.equal(parseLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn').code, 'driveFolder');
  assert.equal(parseLink('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMn').code, 'driveFolder');
  assert.equal(parseLink(`https://docs.google.com/document/d/${ID}/edit`).code, 'driveDoc');
  assert.equal(parseLink('https://drive.google.com/drive/my-drive').code, 'driveNoId');
});

test('Dropbox: rewritten to dl=1, /scl/ links keep rlkey', () => {
  assert.equal(parseLink('https://www.dropbox.com/s/abc123/clip.mp4?dl=0').url, 'https://www.dropbox.com/s/abc123/clip.mp4?dl=1');
  assert.equal(parseLink('https://dropbox.com/s/abc123/clip.mp4').url, 'https://www.dropbox.com/s/abc123/clip.mp4?dl=1');
  assert.equal(parseLink('https://www.dropbox.com/s/abc123/clip.mp4?raw=1').url, 'https://www.dropbox.com/s/abc123/clip.mp4?dl=1');
  const scl = parseLink('https://www.dropbox.com/scl/fi/x9y8z7/My%20Clip.mov?rlkey=k3y456&st=ab12cd&dl=0');
  assert.equal(scl.service, 'dropbox');
  const u = new URL(scl.url);
  assert.equal(u.pathname, '/scl/fi/x9y8z7/My%20Clip.mov');
  assert.equal(u.searchParams.get('rlkey'), 'k3y456');
  assert.equal(u.searchParams.get('st'), 'ab12cd');
  assert.equal(u.searchParams.get('dl'), '1');
  assert.equal(parseLink('https://dl.dropboxusercontent.com/s/abc/clip.mp4').url, 'https://dl.dropboxusercontent.com/s/abc/clip.mp4');
  assert.equal(parseLink('https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1').code, 'dropboxFolder');
  assert.equal(parseLink('https://www.dropbox.com/sh/abc/xyz?dl=0').code, 'dropboxFolder');
});

test('OneDrive / SharePoint and direct https links', () => {
  const od = parseLink('https://1drv.ms/v/s!AbcDef123');
  assert.equal(od.service, 'onedrive');
  assert.equal(od.url, onedriveDownloadUrl('https://1drv.ms/v/s!AbcDef123'));
  assert.match(od.url, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/root\/content$/);
  assert.equal(new URL(parseLink('https://contoso-my.sharepoint.com/:v:/g/personal/me/EaBc?e=x1').url).searchParams.get('download'), '1');
  const d = parseLink('https://cdn.example.com/videos/take%202.mp4');
  assert.equal(d.service, 'direct');
  assert.equal(d.url, 'https://cdn.example.com/videos/take%202.mp4');
});

test('YouTube, Instagram, TikTok and other social links are blocked, not downloaded', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/shorts/abc123', 'https://m.youtube.com/watch?v=x',
    'https://music.youtube.com/watch?v=x', 'https://youtu.be/dQw4w9WgXcQ', 'youtu.be/dQw4w9WgXcQ', 'http://youtube.com/watch?v=x',
    'https://www.youtube-nocookie.com/embed/x', 'https://www.instagram.com/reel/Cxyz/', 'https://instagram.com/p/abc',
    'https://www.tiktok.com/@me/video/123', 'https://vm.tiktok.com/ZMabc/', 'https://www.facebook.com/watch/?v=1', 'https://fb.watch/abc/',
    'https://x.com/me/status/1', 'https://twitter.com/me/status/1', 'https://vimeo.com/12345', 'https://www.snapchat.com/spotlight/x',
    'https://WWW.YOUTUBE.COM/watch?v=x',
  ]) {
    const r = parseLink(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.code, 'blocked', u);
    assert.equal(r.message, BLOCKED_MESSAGE);
  }
  assert.match(BLOCKED_MESSAGE, /We don't download from YouTube or social sites: their terms don't allow it\./);
  // Lookalikes are not blocked.
  assert.equal(isBlockedHost('notyoutube.com'), false);
  assert.equal(isBlockedHost('youtube.com.evil.example'), false);
  assert.equal(isBlockedHost('studio.youtube.com'), true);
});

test('garbage, http and odd schemes are rejected', () => {
  assert.equal(parseLink('').code, 'invalid');
  assert.equal(parseLink('hello there').code, 'invalid');
  assert.equal(parseLink('file:///Users/me/clip.mp4').code, 'invalid');
  assert.equal(parseLink('ftp://example.com/clip.mp4').code, 'invalid');
  assert.equal(parseLink('http://example.com/clip.mp4').code, 'http');
  assert.equal(parseLink('https://user:pw@example.com/clip.mp4').code, 'invalid');
  assert.equal(parseLink('https://localhost/clip.mp4').code, 'invalid');
});

test('response helpers: file names, content types, Drive virus-scan page', () => {
  assert.equal(filenameFromDisposition('attachment; filename="My Clip.mp4"'), 'My Clip.mp4');
  assert.equal(filenameFromDisposition("attachment; filename=\"x.mp4\"; filename*=UTF-8''Caf%C3%A9%20reel.mov"), 'Café reel.mov');
  assert.equal(filenameFromDisposition('attachment; filename=clip.webm'), 'clip.webm');
  assert.equal(filenameFromDisposition(null), null);

  assert.equal(safeFilename('../../etc/passwd'), 'passwd.mp4');
  assert.equal(safeFilename('clip.MOV'), 'clip.MOV');
  assert.equal(safeFilename('clip', 'video/quicktime'), 'clip.mov');
  assert.equal(safeFilename('', 'video/webm'), 'linked-video.webm');
  assert.equal(safeFilename('a:b?.mkv'), 'a_b_.mkv');

  assert.equal(classifyContentType('video/mp4'), true);
  assert.equal(classifyContentType('application/octet-stream'), true);
  assert.equal(classifyContentType(''), true);
  assert.equal(classifyContentType('text/html; charset=utf-8'), 'html');
  assert.equal(classifyContentType('image/jpeg'), false);
  assert.equal(classifyContentType('application/zip'), false);

  const page = `<html><body><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="submit" value="Download anyway"><input type="hidden" name="id" value="${ID}">
    <input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t">
    <input type="hidden" name="uuid" value="1234-abcd"></form></body></html>`;
  const u = new URL(driveConfirmUrl(page));
  assert.equal(u.host, 'drive.usercontent.google.com');
  assert.equal(u.searchParams.get('id'), ID);
  assert.equal(u.searchParams.get('uuid'), '1234-abcd');
  assert.equal(u.searchParams.get('confirm'), 't');
  const old = new URL(driveConfirmUrl(`<a id="uc-download-link" href="/uc?export=download&amp;confirm=AbC1&amp;id=${ID}">Download anyway</a>`));
  assert.equal(old.searchParams.get('confirm'), 'AbC1');
  assert.equal(driveConfirmUrl('<html>Sign in</html>'), null);
});

// ---------- downloadLink with a fake fetch (no network) ----------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-link-test-'));
const resp = (body, headers = {}, { status = 200, url = '' } = {}) => {
  const r = new Response(body, { status, headers });
  Object.defineProperty(r, 'url', { value: url });
  return r;
};
const fakeFetch = (routes) => async (url) => {
  for (const [match, make] of routes) if (url.includes(match)) return make(url);
  throw new Error(`unexpected fetch ${url}`);
};

test('download: Drive file through the virus-scan page lands in its own folder', async () => {
  const dir = tmp();
  const page = `<form id="download-form" action="https://drive.usercontent.google.com/download"><input type="hidden" name="id" value="${ID}"><input type="hidden" name="uuid" value="u1"></form>`;
  const seen = [];
  const r = await downloadLink(`https://drive.google.com/file/d/${ID}/view`, dir, {
    fetch: fakeFetch([
      ['uuid=u1', () => resp(new Uint8Array(3000), { 'content-type': 'video/mp4', 'content-length': '3000', 'content-disposition': 'attachment; filename="beach.mp4"' })],
      ['confirm=t', () => resp(page, { 'content-type': 'text/html; charset=utf-8' })],
    ]),
    onProgress: (p) => seen.push(p),
    verify: async () => true,
  });
  assert.equal(r.name, 'beach.mp4');
  assert.equal(r.bytes, 3000);
  assert.equal(fs.statSync(r.file).size, 3000);
  assert.equal(path.dirname(path.dirname(r.file)), dir);
  assert.deepEqual(seen.at(-1), { received: 3000, total: 3000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download: errors are friendly and leave nothing behind', async () => {
  const dir = tmp();
  const run = (routes, link = `https://drive.google.com/file/d/${ID}/view`, opts = {}) =>
    downloadLink(link, dir, { fetch: fakeFetch(routes), ...opts });
  // Not shared: Drive answers with a sign-in page.
  await assert.rejects(run([['drive.usercontent', () => resp('<html>Sign in - Google Accounts</html>', { 'content-type': 'text/html' })]]),
    { code: 'driveNotShared', message: MESSAGES.driveNotShared });
  assert.match(MESSAGES.driveNotShared, /isn't shared as 'Anyone with the link'/);
  // Not shared: 403.
  await assert.rejects(run([['drive.usercontent', () => resp('no', {}, { status: 403 })]]), { code: 'driveNotShared' });
  // Bigger than 4 GB by header.
  await assert.rejects(run([['drive.usercontent', () => resp('x', { 'content-type': 'video/mp4', 'content-length': String(5 * 1024 ** 3) })]]), { code: 'tooBig' });
  // Bigger than the cap while streaming (no content-length).
  await assert.rejects(run([['drive.usercontent', () => resp(new Uint8Array(2048), { 'content-type': 'video/mp4' })]], undefined, { maxBytes: 1000 }), { code: 'tooBig' });
  // Not a video by content type, and by ffprobe.
  await assert.rejects(run([['dropbox', () => resp('PK', { 'content-type': 'application/zip' })]], 'https://www.dropbox.com/s/abc/clip.mp4?dl=0'), { code: 'notVideo' });
  await assert.rejects(run([['example.com', () => resp('hello', { 'content-type': 'application/octet-stream' })]], 'https://example.com/clip.mp4', { verify: async () => false }), { code: 'notVideo' });
  // Dropbox link that's gone.
  await assert.rejects(run([['dropbox', () => resp('', {}, { status: 404 })]], 'https://www.dropbox.com/s/abc/clip.mp4?dl=0'), { code: 'dropboxNotShared' });
  // Network failure and cancel.
  await assert.rejects(run([['drive', () => { throw new TypeError('fetch failed'); }]]), { code: 'network' });
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(run([['drive', () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }]], undefined, { signal: ctl.signal }), { code: 'cancelled' });
  // Blocked links never reach fetch.
  await assert.rejects(run([], 'https://youtu.be/abc'), { code: 'blocked', message: BLOCKED_MESSAGE });
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download: direct link names the file from the URL', async () => {
  const dir = tmp();
  const r = await downloadLink('https://cdn.example.com/v/take%202.mov?sig=1', dir, {
    fetch: fakeFetch([['cdn.example.com', (u) => resp(new Uint8Array(10), { 'content-type': 'video/quicktime' }, { url: u })]]),
  });
  assert.equal(r.name, 'take 2.mov');
  fs.rmSync(dir, { recursive: true, force: true });
});
