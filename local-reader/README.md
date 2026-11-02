# Local reader — run the sign reader on your own Mac

Uses the vision model you already have for the `life` project (`mlx-community/Qwen2.5-VL-7B-Instruct-4bit`
through `mlx-vlm`) plus Apple's built-in text recognition. Nothing leaves the Mac except the answer. Your
phone reaches it through a Cloudflare tunnel (a temporary public address that forwards to this Mac).

Borrowed from `life`: the model is loaded on first use and dropped after 10 idle minutes; while loaded it
holds life's model lock (`~/life/state/local/model.lock`) so the nightly jobs and this server never load the
model at the same time on the 16 GB Air; output stuck in a repeat loop is rejected.

## Run it

```bash
brew install cloudflared          # once
cd ~/Desktop/streetparking/local-reader
./run.sh --fake                   # first: canned answers, proves the tunnel + app in 30 s
```

It prints a link like `https://dougal441.github.io/streetparking/web/?reader=https://xxxx.trycloudflare.com/api/read-sign`.
Open it on your phone. Header says **vision reader on (local-fake)**. Take a photo → a canned sign comes back.

Then the real thing:

```bash
./run.sh
```

First run makes a `.venv` here and installs the same packages life uses (a few minutes; the weights are
already on disk from life). First photo takes ~20–40 s (model load); later ones a few seconds.

Stop with Ctrl-C. The tunnel address changes each run, so open the printed link again next time.

## Options

| | |
|---|---|
| `READER_TOKEN=secret ./run.sh` | require a shared secret (the printed link includes it) |
| `PORT=9000 ./run.sh` | different port |
| `./run.sh --preload` | load the model at start, not on first photo |
| `./run.sh --idle-minutes 30` | keep the model loaded longer |
| `python3 server.py --help` | everything else |

## Through the Cloudflare Worker instead of the `?reader=` link

Set in `worker/wrangler.toml`: `READER_BACKEND = "local"`, `LOCAL_READER_URL = "https://xxxx.trycloudflare.com"`,
and (if you set a token) `npx wrangler secret put LOCAL_READER_TOKEN`. Then `npm run deploy`. The app then finds
the reader by itself, with no link to remember — but a quick tunnel's address changes every run, so this is
better with a named tunnel on a fixed hostname (`cloudflared tunnel create caniparkhere`, route it to
`reader.dougalhanson.com`, then `cloudflared tunnel run`). Only worth doing once the local model proves itself.

## Why not a permanent service

This is a server that must be alive — exactly the pattern `life` forbids for unattended jobs. It is fine here
because a human is holding the phone: if the Mac is asleep, the app falls back to on-device OCR and says so.
