# Deploying

## Production: dougalhanson.com/caniparkhere (private)

The live app is <https://dougalhanson.com/caniparkhere>. It is private: friends get in by invite only.

- **Who serves it:** the dougalhanson.com Worker (a separate repo, `dougalhanson-com`), from Cloudflare R2. This
  repo does not deploy anything itself.
- **Which version is live:** a pinned commit of this repo. In the dougalhanson-com repo,
  `scripts/put-caniparkhere-build.sh <commit> --remote` builds that commit and uploads it to R2, and the live
  version is the `CANIPARKHERE_COMMIT` value in that repo's `src/caniparkhere.js`. The full steps (upload, check,
  save, deploy, and rolling back) are that repo's `caniparkhere/README.md`, sections 2 and 3.
- **Who reads the photos:** Dougal's Mac first ([`local-reader/`](../local-reader/README.md)), reached only through
  the site Worker, which sends the reader's password in a header. If the Mac doesn't answer, Cloudflare's free
  Workers AI reads it, and if that fails too, the phone reads it on-device.
- **Who can use it:** sign-in is the site's email code, and Dougal adds friends on the site.

Merging to `main` here changes nothing live. A new version goes live only when it is uploaded and pinned as above.

## GitHub Pages mirror: off

The old public GitHub Pages copy is switched off, and its workflow is gone. There is no public copy of the app.

## Not used in production: the separate `worker/` (kept for local experiments only)

Everything below describes the old all-Cloudflare setup: a separate Worker in `worker/`, its billed AI setup, and
a `dougalhanson.com/streetparking/*` path route. **None of it is used in production.** It is kept for local
experiments only. Its GitHub workflow (`.github/workflows/cloudflare.yml`) runs only by hand, never on a push.

The separate Worker serves the app **and** the vision reader, and can bill Claude through Cloudflare **AI Gateway
Unified Billing** (prepaid credits, 5% fee on top-up, provider token prices passed through — about 1–3¢ per photo).

### 1. One-time Cloudflare setup (dashboard, ~5 min)

1. **Credits**: dash → **AI** → **AI Gateway** → *Credits Available* → **Manage** → add payment method → **Top-up** (e.g. $10). Optional: auto top-up.
2. **Gateway**: AI Gateway → **Create gateway** → name `caniparkhere` (must match `AIG_GATEWAY_ID` in `worker/wrangler.toml`).
3. In that gateway's **Settings**: *Workers AI billing* → **Unified billing** (only matters for the Workers AI backend). Optional: a **spend limit**.

Nothing else. The Worker's AI binding is pre-authenticated; no tokens or keys to copy.

### 2. Deploy for an experiment (laptop, ~3 min)

```bash
cd ~/Documents/Claude/Projects/streetparking && git pull
```
```bash
cd worker && npm install
```
```bash
npx wrangler login
```
```bash
npm run deploy
```

`npm run deploy` builds the static app into `worker/public/streetparking/` and uploads it with the Worker. It prints
`https://caniparkhere.<you>.workers.dev` — open `https://caniparkhere.<you>.workers.dev/streetparking/`. The app
auto-detects the reader next to it (`../api/read-sign`); the header says **vision reader on (unified)**.

Redeploy after any change: `npm run deploy` again.

### 3. The old `dougalhanson.com/streetparking` path route (not used)

This was the plan before the private hosting: a **path route** sending `/streetparking/*` on dougalhanson.com to
this separate Worker (the commented-out `[[routes]]` block at the bottom of `worker/wrangler.toml`). It is not used
in production; don't uncomment it. The app lives at `dougalhanson.com/caniparkhere`, served by the main site Worker.

### 3a. The vision model on your own Mac

`local-reader/` runs the same model your `life` project uses (mlx-vlm, Qwen2.5-VL-7B) plus Apple's text
recognition. In production the dougalhanson.com Worker reaches it. For an experiment with this separate Worker,
`cd local-reader && ./run.sh` prints the reader's temporary address. Details in
[`local-reader/README.md`](../local-reader/README.md).

### 4. Choosing the reader backend (separate Worker only)

`READER_BACKEND` in `worker/wrangler.toml`:

| value | model | needs | notes |
|---|---|---|---|
| `unified` (default) | Claude Opus 5.5 via AI Gateway | credits + gateway | best accuracy; OpenAI-shaped request through the AI binding |
| `workers-ai` | Llama 4 Scout (`@cf/meta/llama-4-scout-17b-16e-instruct`) | nothing (10k free neurons/day) | cheapest; accuracy on dense signs unproven — score it against `test/fixtures/photos` |
| `gateway-sdk` | Claude via gateway provider endpoint + Anthropic SDK | `CF_ACCOUNT_ID` var, `CF_AIG_TOKEN` secret | uses Anthropic's native structured outputs; use if `unified` misbehaves with JSON |
| `anthropic` | Claude with your own key | `ANTHROPIC_API_KEY` secret | bypasses Cloudflare billing |
| `local` | Qwen2.5-VL on your Mac via `local-reader/` + Cloudflare tunnel | `LOCAL_READER_URL` var (+ `LOCAL_READER_TOKEN` secret) | free, private; only while the Mac is awake |

`READER_MODEL` overrides the model id for any backend. `GET /streetparking/api/read-sign` shows the active backend.

Change a var → `npm run deploy`. Secrets: `npx wrangler secret put NAME`.

### 5. Deploys from GitHub (by hand only)

"Automatic deploys from GitHub" are off. `.github/workflows/cloudflare.yml` no longer runs on merges to `main`; it
runs only when started by hand (GitHub → Actions → *Deploy Worker to Cloudflare* → *Run workflow*), and even then it
skips the deploy unless the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist. Neither is
set, and production doesn't need them.

### Cost and abuse (separate Worker)

Per-IP rate limit (`RATE_LIMIT_PER_MIN`, default 10), 8 MB body cap, photos downscaled to 1600 px client-side.
Set a spend limit on the gateway. Credits can dip slightly negative; Cloudflare charges the card for the remainder.

## Local development

```bash
npm run serve              # app only, OCR only: http://localhost:8787/web/
cd worker && npm run dev   # app + reader via wrangler dev (uses your Cloudflare login for the AI binding)
```

To try the app exactly as the live site serves it, use the dougalhanson-com repo's `caniparkhere/README.md`,
section 4.

## Keeping data fresh

- Public holidays: once a year, `rules/au-vic/public-holidays.json`.
- Legislation: `python3 scripts/extract-vic-rules.py <docx>` when legislation.vic.gov.au publishes a new version; review the diff; bump the citation.
- After any rules change, ship a new app version (upload and pin it, as in the production section above); the app
  reads the JSON at load.
