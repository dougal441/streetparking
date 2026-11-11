# Local reader — run the sign reader on your own Mac

Uses the vision model you already have for the `life` project (`mlx-community/Qwen2.5-VL-7B-Instruct-4bit`
through `mlx-vlm`) plus Apple's built-in text recognition. Nothing leaves the Mac except the answer.

In production the app lives at <https://dougalhanson.com/caniparkhere> (private, friends by invite). The phone
never talks to this Mac directly: it sends the photo to the dougalhanson.com Worker, and that Worker is the only
client of this reader. It sends the reader's password in the `x-reader-token` header, never in a link. See
[docs/DEPLOY.md](../docs/DEPLOY.md).

Borrowed from `life`: the model is loaded on first use and dropped after 10 idle minutes; while loaded it
holds life's model lock (`~/life/state/local/model.lock`) so the nightly jobs and this server never load the
model at the same time on the 16 GB Air; output stuck in a repeat loop is rejected.

## Try it by hand (local experiments)

```bash
brew install cloudflared          # once
cd ~/Documents/Claude/Projects/streetparking/local-reader
./run.sh --fake                   # first: canned answers, proves the reader + tunnel in 30 s
```

It starts the reader and a temporary Cloudflare quick tunnel, then prints the address the reader answers on
(`https://xxxx.trycloudflare.com/api/read-sign`). Nothing it prints carries a password. Point a local experiment
at that address; the live site does not use it.

Then the real model:

```bash
./run.sh
```

First run makes a `.venv` here and installs the same packages life uses (a few minutes; the weights are
already on disk from life). First photo takes ~20–40 s (model load); later ones a few seconds.

Stop with Ctrl-C. The tunnel address changes each run.

## Options

| | |
|---|---|
| `READER_TOKEN=secret ./run.sh` | require a password in the `x-reader-token` header (handed to the reader through a private temporary file, never printed) |
| `PORT=9000 ./run.sh` | different port |
| `./run.sh --preload` | load the model at start, not on first photo |
| `./run.sh --idle-minutes 30` | keep the model loaded longer |
| `python3 server.py --help` | everything else |

## The permanent service (what the live site uses)

```bash
./install-service.sh
```

What it does, once:
- installs a launchd service `com.dougal.caniparkhere-reader` (always running; the model loads on the first photo and is dropped after 10 idle minutes, so it does not sit in memory beside `life`'s jobs);
- publishes it through **Tailscale Funnel** on this Mac's fixed name under the path `/streetparking` — the same
  mechanism `life` uses for its `/mail-capture` endpoint, and the two coexist;
- keeps the reader's password in one file, `state/token`. It is made once with private permissions (only your
  user can read it, mode 600) and is never saved in git. The service settings name the file, never the password,
  and no link carries it. The reader accepts the password only in the `x-reader-token` header;
- prints the fixed reader address. The dougalhanson.com Worker is the only client, so there is nothing to open or
  bookmark on a phone.

After the password in `state/token` changes, copy it to the site so the Worker can keep reaching the Mac. The steps
are in the dougalhanson-com repo, `caniparkhere/README.md`, section 8a.

If the Mac is asleep, the site says the Mac didn't answer and reads the photo another way.

Tailnet-only instead of public: `TS_MODE=serve ./install-service.sh` (only tailnet devices can reach it then).

Keep the Mac awake when you're out: System Settings → Battery → Options → *Prevent automatic sleeping on power
adapter when the display is off* on, and leave it plugged in. A closed lid on battery = asleep = no reader.

Remove it all: `./uninstall-service.sh`. Logs: `~/Library/Logs/caniparkhere-reader/reader.stderr.log` (outside
Documents, so the background service can open them; the folder and files are private to your user).

### Why not the `life` capture Shortcut?

That path is one-way: the phone sends a photo, the Mac files a note minutes later. Parking needs an answer back
within seconds, on the same screen. So this is a request-and-reply web address instead — but it reuses the
same Tailscale Funnel and the same model, so nothing new has to be kept alive.

## Why a server that must stay alive is fine here

This is a server that must be alive — exactly the pattern `life` forbids for unattended jobs. It is fine here
because a human is holding the phone: if the Mac is asleep, the site reads the photo another way and says so.

## Logs and reports

- Every read is kept in `reads/<readId>/` (photo + everything the reader saw and said; newest 200). Never saved in git.
- **Reader got it wrong** in the app files that read privately. The service runs with `--no-upload`, so the Mac's
  reports stay on this Mac under `reports/` (never saved in git, never pushed anywhere). Reports made on the site
  stay on the site, and only Dougal can open them.
- List and look at them: `python3 scripts/reports.py list` from the repo root. How reports become fixes:
  [docs/REPORTS.md](../docs/REPORTS.md).
