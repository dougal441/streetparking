# Deploying — all on Cloudflare

One Cloudflare Worker (`worker/`) serves the app **and** the vision reader. No other hosting, no Anthropic account:
the reader bills Claude through Cloudflare **AI Gateway Unified Billing** (prepaid credits, 5% fee on top-up,
provider token prices passed through — about 1–3¢ per photo). Everything stays on your Cloudflare bill.

GitHub Pages (`https://dougal441.github.io/streetparking/`) keeps working as a free, OCR-only mirror.

## 1. One-time Cloudflare setup (dashboard, ~5 min)

1. **Credits**: dash → **AI** → **AI Gateway** → *Credits Available* → **Manage** → add payment method → **Top-up** (e.g. $10). Optional: auto top-up.
2. **Gateway**: AI Gateway → **Create gateway** → name `caniparkhere` (must match `AIG_GATEWAY_ID` in `worker/wrangler.toml`).
3. In that gateway's **Settings**: *Workers AI billing* → **Unified billing** (only matters for the Workers AI backend). Optional: a **spend limit**.

Nothing else. The Worker's AI binding is pre-authenticated; no tokens or keys to copy.

## 2. Deploy (laptop, ~3 min)

```bash
cd ~/Desktop/streetparking && git pull
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
`https://caniparkhere.<you>.workers.dev` — open `https://caniparkhere.<you>.workers.dev/streetparking/` on your
phone. The app auto-detects the reader next to it (`../api/read-sign`); the header says **vision reader on (unified)**.

Redeploy after any change: `npm run deploy` again. (Or merge to `main` and let CI do it — see §5.)

## 3. Put it on dougalhanson.com/streetparking

Your main site is a separate Worker on a custom domain. A **path route** sends just `/streetparking/*` to this Worker;
path routes are more specific than the custom-domain catch-all, so the main site is untouched.

Uncomment the `[[routes]]` block at the bottom of `worker/wrangler.toml`, then `npm run deploy`. Done:
`https://dougalhanson.com/streetparking/`.

If Cloudflare refuses the route because of the custom domain, fallback is a 10-line proxy in the main site Worker
(`src/index.js`): `if (pathname.startsWith('/streetparking')) return fetch('https://caniparkhere.<you>.workers.dev' + pathname, request)`.

## 3a. Use the vision model on your own Mac instead

`local-reader/` runs the same model your `life` project uses (mlx-vlm, Qwen2.5-VL-7B) plus Apple's text
recognition, and a Cloudflare tunnel lets the phone reach it. `cd local-reader && ./run.sh` prints the phone link.
Details and the Worker setting (`READER_BACKEND = "local"`) in [`local-reader/README.md`](../local-reader/README.md).

## 4. Choosing the reader backend

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

## 5. Automatic deploys from GitHub (optional)

Add two repository secrets (GitHub → Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN` (Cloudflare dash →
My Profile → API Tokens → template *Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID` (`npx wrangler whoami`).
Then `.github/workflows/cloudflare.yml` deploys the Worker on every merge to `main`. Until the secrets exist that
workflow is skipped.

## 6. Local development

```bash
npm run serve              # app only, OCR only: http://localhost:8787/web/
cd worker && npm run dev   # app + reader via wrangler dev (uses your Cloudflare login for the AI binding)
```

## 7. Keeping data fresh

- Public holidays: once a year, `rules/au-vic/public-holidays.json`.
- Legislation: `python3 scripts/extract-vic-rules.py <docx>` when legislation.vic.gov.au publishes a new version; review the diff; bump the citation.
- Redeploy after any rules change — the app reads the JSON at load.

## Cost and abuse

Per-IP rate limit (`RATE_LIMIT_PER_MIN`, default 10), 8 MB body cap, photos downscaled to 1600 px client-side.
Set a spend limit on the gateway. Credits can dip slightly negative; Cloudflare charges the card for the remainder.
