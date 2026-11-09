# CanIparkhere: notes for Claude

Photograph a parking sign, get told if you can park. Owner: Dougal (Melbourne). He wants minimal interaction:
fix, test, merge to `main` yourself, then give him ONE command to run on the Mac if the reader changed.

## Layout
- `src/` engine + sign text parser (pure ES modules, runs in Node and the browser). `rules/` legislation data.
- `web/` the app (GitHub Pages + Cloudflare Worker deploy from `main`).
- `local-reader/server.py` the vision reader on Dougal's Mac (Qwen2.5-VL via mlx + Apple Vision OCR), a launchd
  service. Code there only takes effect after he pulls and re-runs `./install-service.sh`.
- Mac checkout: `/Users/dougalhanson/Documents/Claude/Projects/streetparking`.

## "Check reports"
Misreads reported from the app land on the `reader-reports` branch. Follow `docs/REPORTS.md`:
`python3 scripts/reports.py list`, look at each photo, add a replay case in `local-reader/cases/`, fix the class
of mistake structurally, prove it with tests, merge.

## Rules of thumb
- A wrong "yes you can park" is the worst outcome. When unsure, guards must make the answer stricter.
- The small model copies from its prompt and from neighbouring panels. Trust Apple Vision for what is printed,
  the model for symbols, arrows and structure.
- `SYSTEM` in `local-reader/server.py` must stay byte-identical with `server/read-sign.js` (a test checks).
- Tests: `npm test`, `npm run validate`, `npm run build`, `npm run test:local-reader`.
- Never commit the reader token (`local-reader/state/`), `reads/` or `reports/`.
