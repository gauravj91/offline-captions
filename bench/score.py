"""Scores bench/run.mjs output: WER, per-clip corrections, and how many errors the yellow flags caught."""
import json, re, sys
import jiwer
from num2words import num2words

def norm(s):
    s = s.lower().replace('%', ' percent').replace('&', ' and ')
    s = re.sub(r"(\d+)(st|nd|rd|th)\b", lambda m: num2words(int(m.group(1)), to='ordinal'), s)
    s = re.sub(r"\d+(\.\d+)?", lambda m: ' ' + num2words(float(m.group()) if '.' in m.group() else int(m.group())) + ' ', s)
    s = re.sub(r"[^a-z' ]", ' ', s.replace('-', ' '))
    return ' '.join(s.split())

for f in sys.argv[1:]:
    data = json.load(open(f))
    refs, hyps, per = [], [], []
    caught = errs = flagged = total = 0
    for d in data:
        r = norm(d['ref'])
        hw = [(norm(w['text']), w['review']) for w in d['words']]
        flat = [(t, rv) for ws, rv in hw for t in ws.split() if t]
        h = ' '.join(t for t, _ in flat)
        refs.append(r); hyps.append(h)
        o = jiwer.process_words(r, h)
        e = o.substitutions + o.deletions + o.insertions
        per.append(e)
        # map hypothesis-side errors (subs/inserts) to flags
        for al in o.alignments[0]:
            if al.type in ('substitute', 'insert'):
                for k in range(al.hyp_start_idx, al.hyp_end_idx):
                    errs += 1; caught += flat[k][1]
        flagged += sum(rv for _, rv in flat); total += len(flat)
    wer = jiwer.wer(refs, hyps)
    secs = sum(d['secs'] for d in data); audio = sum(d['sec'] for d in data)
    ok = sum(1 for e in per if e <= 2)
    print(f"{f}: WER {wer*100:.1f}% | clips with <=2 fixes {ok}/{len(per)} | median fixes {sorted(per)[len(per)//2]} | "
          f"flags {flagged}/{total} words ({flagged/total*100:.0f}%) catch {caught}/{errs} wrong words ({caught/max(errs,1)*100:.0f}%) | speed {audio/secs:.1f}x realtime")
