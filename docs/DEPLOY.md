# Deploying — dougalhanson.com/streetparking

The applet is static. The vision reader is an optional tiny API that holds the Anthropic key.

## 1. Static applet (no backend)

```bash
npm run build        # → web/dist/
```

Upload the contents of `web/dist/` to `/streetparking/` on your site. That's it. `index.html` loads `app.js`, `src/`, and `rules/` relatively, and tesseract.js from cdnjs for OCR.

Embedding inside an existing page: either iframe `/streetparking/index.html`, or copy the `<main class="app">` block + `style.css` + the module script into your page, keeping `src/` and `rules/` alongside.

## 2. Vision reader (recommended for real photos)

The browser POSTs `{image: <base64>, mediaType, jurisdiction, council}` to `readerUrl` and gets back `{sign}` in the sign schema. `server/read-sign.js` does the model call (Claude Opus 5.5, structured JSON output, server-side refusal fallback enabled).

### Option A — Cloudflare Worker (recommended; you already have a Cloudflare account)

`worker/` is a self-contained Worker. One-time, on your laptop:

```bash
cd worker
npm install
npx wrangler login                              # opens browser, authorise Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY       # paste key from https://console.anthropic.com/settings/keys
npx wrangler deploy
```

It prints a URL like `https://caniparkhere-reader.<you>.workers.dev`. Then either:

- set `readerUrl: 'https://caniparkhere-reader.<you>.workers.dev/api/read-sign'` in `web/index.html` and merge, or
- for a quick test without redeploying, open the app once as
  `https://dougal441.github.io/streetparking/web/?reader=https://caniparkhere-reader.<you>.workers.dev/api/read-sign`
  (remembered on that phone; `?reader=off` forgets it).

`worker/wrangler.toml` holds `ALLOWED_ORIGINS` (CORS) and `RATE_LIMIT_PER_MIN` (per-IP, Cache API). Free tier covers it.

### Option B — Node anywhere (Fly.io, Railway, a VPS)

```bash
npm install @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-ant-... CANIPARKHERE_ALLOWED_ORIGINS=https://dougalhanson.com PORT=8787 node server/index.js
```

Point `readerUrl` in `web/index.html` at `https://<your-host>/api/read-sign`.

### Option C — Other serverless (Vercel / Netlify)

`server/read-sign.js` exports `readSign({ imageBase64, mediaType, jurisdiction, council })` and has no Node-specific code, so wrap it in the platform's handler:

```js
// api/read-sign.js (Vercel)
import { readSign } from '../server/read-sign.js';
export default async function handler(req, res) {
  const { image, mediaType, jurisdiction, council } = req.body;
  res.json(await readSign({ imageBase64: image, mediaType, jurisdiction, council }));
}
```

Set `ANTHROPIC_API_KEY` in the platform's secrets. Keep CORS to your origin.

### Cost and abuse

One read ≈ one image + ~1k tokens out on Opus 5.5 — a few cents per photo. The Worker rate-limits per IP (10/min) and caps bodies at 8 MB; the Node server caps at 12 MB. Photos are downscaled to 1600 px client-side before upload. Set a monthly spend limit on the Anthropic console key.

### Model note

`CANIPARKHERE_MODEL` overrides the model id. Keep `fallbacks: 'default'` so a refused image gets retried on a fallback model automatically rather than failing.

## 3. Keeping data fresh

- Public holidays: once a year, `rules/au-vic/public-holidays.json`.
- Legislation: `python3 scripts/extract-vic-rules.py <docx>` when legislation.vic.gov.au publishes a new version; review the diff; bump the citation.
- Rebuild (`npm run build`) and re-upload after any rules change — the applet reads the JSON at load.
