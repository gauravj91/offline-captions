// Gives Roman-Hinglish words (from the Whisper Hinglish model, which has no
// timestamps) word timings borrowed from IndicConformer's Devanagari pass.
// Both passes heard the same audio, so we align their words by a script-blind
// consonant skeleton ("कस्टम" ~ "custom" -> "kstm" ~ "kstm") and copy times.

const DEV = {
  'क':'k','ख':'k','ग':'g','घ':'g','ङ':'n','च':'c','छ':'c','ज':'j','झ':'j','ञ':'n',
  'ट':'t','ठ':'t','ड':'d','ढ':'d','ण':'n','त':'t','थ':'t','द':'d','ध':'d','न':'n',
  'प':'p','फ':'f','ब':'b','भ':'b','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'s',
  'ष':'s','स':'s','ह':'h','क़':'k','ख़':'k','ग़':'g','ज़':'j','ड़':'r','ढ़':'r','फ़':'f',
  '़':'', 'ं':'n','ँ':'n',
};
const DIGITS = { '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9' };

export function skeleton(word) {
  let s = '';
  for (const ch of word.normalize('NFC').toLowerCase()) {
    if (DEV[ch] !== undefined) s += DEV[ch];
    else if (DIGITS[ch]) s += DIGITS[ch];
    else if (/[a-z0-9]/.test(ch)) s += ch;
  }
  return s
    .replace(/ph/g, 'f').replace(/([kgcjtdpb])h/g, '$1').replace(/sh/g, 's')
    .replace(/[aeiouwy]/g, '').replace(/[cq]/g, 'k').replace(/z/g, 'j').replace(/x/g, 'ks')
    .replace(/v/g, 'b').replace(/(.)\1+/g, '$1');
}

function sim(a, b) {
  if (!a && !b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n, 1);
}

/**
 * @param {string[]} roman  words to time (Whisper-Hinglish)
 * @param {{text:string,start:number,end:number}[]} timed  words with times (IndicConformer)
 * @param {number} duration seconds of audio, for words with no anchor
 * @returns {{text:string,start:number,end:number,anchored:boolean}[]}
 */
export function alignWords(roman, timed, duration) {
  const A = roman.map(skeleton), B = timed.map((w) => skeleton(w.text));
  const m = A.length, n = B.length, GAP = -0.4;
  const S = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const P = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 1; i <= m; i++) { S[i][0] = i * GAP; P[i][0] = 1; }
  for (let j = 1; j <= n; j++) { S[0][j] = j * GAP; P[0][j] = 2; }
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const d = S[i - 1][j - 1] + (sim(A[i - 1], B[j - 1]) * 2 - 1), u = S[i - 1][j] + GAP, l = S[i][j - 1] + GAP;
    if (d >= u && d >= l) { S[i][j] = d; P[i][j] = 0; } else if (u >= l) { S[i][j] = u; P[i][j] = 1; } else { S[i][j] = l; P[i][j] = 2; }
  }
  const match = new Array(m).fill(-1);
  for (let i = m, j = n; i > 0 || j > 0; ) {
    const p = P[i][j];
    if (i > 0 && j > 0 && p === 0) { if (sim(A[i - 1], B[j - 1]) >= 0.34) match[i - 1] = j - 1; i--; j--; }
    else if (i > 0 && (j === 0 || p === 1)) i--; else j--;
  }
  const out = roman.map((text, i) => match[i] >= 0
    ? { text, start: timed[match[i]].start, end: timed[match[i]].end, anchored: true }
    : { text, start: NaN, end: NaN, anchored: false });
  // Unanchored words: share the gap between neighbouring anchors, by length.
  for (let i = 0; i < out.length; ) {
    if (out[i].anchored) { i++; continue; }
    let j = i; while (j < out.length && !out[j].anchored) j++;
    const from = i > 0 ? out[i - 1].end : (timed[0]?.start ?? 0);
    const to = j < out.length ? out[j].start : Math.max(from + 0.3 * (j - i), timed.at(-1)?.end ?? duration);
    const total = out.slice(i, j).reduce((a, w) => a + w.text.length + 1, 0);
    let t = from;
    for (let k = i; k < j; k++) { const d = (to - from) * (out[k].text.length + 1) / total; out[k].start = t; out[k].end = t += d; }
    i = j;
  }
  return out;
}
