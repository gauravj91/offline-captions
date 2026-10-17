# Landing site: Offline Captions (working name)

Static files only: inline CSS, a little inline JS, no external fonts, scripts, analytics or CDNs. Works on any static host.

```
landing/
  index.html            home: hero + demo, style switcher, how it works, who it's for (ICP),
                        use cases, comparison, pricing + 12-month cost, FAQ, waitlist
  hinglish/index.html   India / Hinglish variant (₹ pricing)
  vs/capcut/index.html  SEO comparison page
  vs/submagic/index.html
  site-config.js        THE place to edit names, prices, links and open policies
  media/                demo clips (H.264, muted, ~1.3 MB each) + poster JPGs
  robots.txt  sitemap.xml  llms.txt
```

## 1. Edit `site-config.js`

| Key | What it does |
|---|---|
| `APP_NAME` | Product name, swapped in everywhere on every page. |
| `SITE_URL` | Your domain once chosen (see step 2). |
| `CHECKOUT_URL` / `CHECKOUT_URL_INR` | Pre-order checkout links (USD and ₹). Stripe Payment Link, Lemon Squeezy, Paddle, Gumroad, Razorpay... |
| `WAITLIST_ACTION` | Form POST endpoint with an `email` field (Formspree, Buttondown, Tally...). The Hinglish form also sends `segment=hinglish`. A hidden `_gotcha` honeypot is included. |
| `CONTACT_EMAIL` | Shown in the home footer when set. |
| `PRICE_PREORDER` / `PRICE_FULL` | $29 / $39. |
| `PRICE_INR_PREORDER` / `PRICE_INR_FULL` | **Proposal, Gaurav to decide**: ₹1,499 founding / ₹1,999 later. |
| `INR_TAX_NOTE` | e.g. "incl. 18% GST" once tax handling is decided. |
| `UPDATES_POLICY`, `DEVICE_LIMIT`, `MONEY_BACK_DAYS`, `PREORDER_REFUND` | **Open decisions.** Empty = the line/FAQ that depends on it stays hidden. Fill one and it appears in the pricing card (and FAQ for the guarantee). |

The prices and name are also written in the HTML (for no-JS visitors, search snippets and JSON-LD). If you change a price or the name, also find/replace it in the four `index.html` files, e.g.:

```bash
cd captions-app/landing
grep -rl '\$29' --include=*.html . | xargs sed -i 's/\$29/$25/g'      # example only
```
Remember the JSON-LD `"price": "29"` / `"39"` / `"1499"` values too.

## 2. Set the domain

The domain isn't decided, so every canonical, OG, JSON-LD, robots.txt, sitemap.xml and llms.txt URL uses `https://YOUR-DOMAIN.example`. When you have it:

```bash
cd captions-app/landing
grep -rl 'YOUR-DOMAIN.example' . | xargs sed -i 's#https://YOUR-DOMAIN.example#https://yourdomain.com#g'
```
(`site-config.js` is included in that replace.)

## 3. Deploy

**Vercel:** New Project → import the repo → Root Directory `captions-app/landing` → Framework "Other", no build command → Deploy. CLI: `cd captions-app/landing && npx vercel --prod`.

**Cloudflare Pages:** Create → Pages → connect repo → build command empty, output directory `captions-app/landing`. Or `npx wrangler pages deploy captions-app/landing --project-name offline-captions`.

Then submit `sitemap.xml` in Google Search Console and Bing Webmaster Tools.

## 4. Demo media and credits (keep the credits on the page)

| File | Source | Licence |
|---|---|---|
| `media/demo-en-{bold,clean,punch,reveal}.mp4`, `demo-en-raw.mp4` (19 s, 540×960) | "Connecting Classrooms to Space: Ham Radio Explainer by NASA Astronaut Nichole Ayers" (jsc2025m000040), NASA Johnson Space Center, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Connecting_Classrooms_to_Space-_Ham_Radio_Explainer_by_NASA_Astronaut_Nichole_Ayers_(jsc2025m000040).webm). 9:16 crop of 0:54.75–1:14.15, captioned by our engine (Parakeet), no hand edits. | Public domain (US government work). NASA's media guidelines: don't imply endorsement (the footer says so). |
| `media/demo-hinglish-{bold,reveal}.mp4` (18 s) | "What is a Spoken Tutorial" (Hindi), [Spoken Tutorial Project, IIT Bombay](https://spoken-tutorial.org/watch/Spoken+Tutorial+Technology/What+is+a+Spoken+Tutorial/Hindi/). Reframed to 9:16 on a blurred background, captioned by our Hinglish mode, no hand edits. | CC BY-SA 4.0. Our derived clips are therefore CC BY-SA 4.0 too (stated in the Hinglish footer). |

Clips are muted (no audio track) to stay small. Regenerate with `node src/cli.mjs <clip> --style <s> [--lang hinglish] --out dir`, then `ffmpeg -i in.mp4 -an -vf scale=540:960 -c:v libx264 -preset slow -crf 27 -maxrate 1100k -bufsize 2200k -movflags +faststart out.mp4`.

App screenshots: `media/app-review.jpg` and `media/app-style-export.jpg` are from the pre-release desktop UI (`/workspace/work/ui-shots/03-review.png`, `04-style-export.png`, 17 Oct 2026), shown under the demo and labelled pre-release. Replace them when the UI changes.

## 5. Before going live: claims to re-check

- **Competitor facts**: all re-verified 17 Oct 2026 on the vendors' own pages (CapCut resource + help pages, submagic.co/pricing, autosubtitles.com, descript.com/pricing, aivideocaption.com, parismitaglobalsolutions.com). Re-check monthly; CapCut changed plans twice in 2026. Full list with quotes: `work/competitor-facts.md` in the project workspace.
- **Our claims** you must be able to stand behind at launch: Mac + Windows; fully offline; unlimited videos; no watermark; export at source resolution + SRT; batch; dictionary that learns corrections; yellow review words; filler removal; Hinglish mode in Roman script. Accuracy wording is limited to our own benchmark (7.6% vs 9.6% WER, 28 clips) and explicitly says the CapCut/Submagic head-to-head is pending. Hindi (Devanagari) and other Indian languages are described only as "coming".
- **Removed from the old page until decided**: the 30-day no-questions refund and "refundable any time before launch". Use `MONEY_BACK_DAYS` / `PREORDER_REFUND` to bring them back.
- Add an imprint / privacy page before selling from Germany/EU.
