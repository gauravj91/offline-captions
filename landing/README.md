# Landing page: Offline Captions (working name)

A single static file: `index.html`. Inline CSS, a few lines of inline JS, no external fonts, images or build step. Works on any static host.

## 1. Fill in the constants

Open `index.html`. Near the top of `<head>` there is one block:

```js
window.SITE_CONFIG = {
  APP_NAME: "Offline Captions",   // product name, swapped in everywhere on the page
  CHECKOUT_URL: "#checkout",      // your pre-order checkout link
  WAITLIST_ACTION: "#waitlist",   // the POST endpoint for the email form
  PRICE_PREORDER: "$29",
  PRICE_FULL: "$39"
};
```

| Constant | What to put there |
|---|---|
| `APP_NAME` | The final product name. Every element marked `data-app-name` and the page title update from it. Also change the literal "Offline Captions" in `<title>`, `<meta name="description">` and the fallback text in the HTML if you want it right for visitors with JS off and for search snippets. |
| `CHECKOUT_URL` | A hosted checkout link, e.g. a Stripe Payment Link (`https://buy.stripe.com/...`), Lemon Squeezy, Paddle or Gumroad. All "Pre-order" buttons use it. Placeholder `#checkout` just scrolls to the final CTA. |
| `WAITLIST_ACTION` | Any service that accepts a form POST with an `email` field: Formspree (`https://formspree.io/f/xxxx`), Buttondown, ConvertKit, Tally, Getform. The form also has a hidden `_gotcha` honeypot field (Formspree uses it for spam filtering; harmless elsewhere). |
| `PRICE_PREORDER` / `PRICE_FULL` | Prices shown in the hero, table, FAQ and final CTA. |

## 2. Deploy

**Vercel**
- Dashboard: New Project → import the repo → set *Root Directory* to `captions-app/landing` → Framework preset "Other" → no build command, no output directory → Deploy.
- CLI: `cd captions-app/landing && npx vercel --prod`

**Cloudflare Pages**
- Dashboard: Workers & Pages → Create → Pages → connect the repo → *Build command* empty, *Build output directory* `captions-app/landing` → Deploy.
- Or drag-and-drop the `landing` folder under "Upload assets".
- CLI: `npx wrangler pages deploy captions-app/landing --project-name offline-captions`

Then add your custom domain in the host's dashboard.

## 3. Before going live

- Re-check the comparison table prices (last checked Oct 2026). Sources:
  - CapCut Pro $19.99/mo, $179.99/yr; auto captions are Pro-only: https://www.capcut.com/resource/capcut-standard-vs-pro
  - CapCut acknowledges the new pricing / old price no longer offered: https://www.capcut.com/help/adjusted-price and https://www.capcut.com/help/pricing-change (AI points 550 → 1,200)
  - CapCut's old annual price (~$77–78): https://www.newsweek.com/app-used-millions-nearly-doubles-subscription-price-overnight-11535999 and https://sonary.com/content/capcut-increases-price-in-latest-update/
  - Submagic plans, credits, 4K, custom vocabulary, filler words: https://www.submagic.co/pricing
- Product claims on the page you need to be able to stand behind at launch: Mac + Windows, fully offline transcription, unlimited videos, no watermark, 1080p/4K, .srt export, 30-day no-questions refund, pre-order refundable any time before launch.
- Add an imprint / privacy page if you sell from Germany or the EU.
