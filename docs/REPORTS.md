# Reader reports: how misreads become fixes

The vision reader gets signs wrong. This is the loop that makes each mistake happen once.

## 1. In the app (the person)

After a photo is read, the result shows **👎 Reader got it wrong**.

1. If you can, fix it first: the ← ↔ → buttons or the sign text under **Show my working**.
2. Tap the button. Optionally add a note.

That is all. The same button appears when a read fails outright.

## 2. On the Mac (automatic)

- Every read is logged in `local-reader/reads/<readId>/` (newest 200 kept):
  - `photo.jpg`: the photo as the model saw it.
  - `read.json`: Apple Vision lines with positions, the model's raw reply, the sign sent to the app, corrections made, timings, any error.
- A report copies that folder to `local-reader/reports/<readId>/` and adds `report.json`: notes, plus what the app
  showed (sign text, panels after hand fixes, side overrides, time, vehicle, verdicts).
- The report is pushed to the **`reader-reports`** branch of this repository. That branch holds only reports: no
  code, no CI. The repository is public, so reported photos are public.
- If the push fails the report stays on the Mac and goes with the next one. To push by hand:
  `cd local-reader && .venv/bin/python server.py --sync-reports`

## 3. Triage (Claude, when asked to "check reports")

```bash
python3 scripts/reports.py list            # fetches reader-reports into .reports/, lists what is waiting
python3 scripts/reports.py show <readId>   # printed lines, model reply, sign sent, what the app showed
python3 scripts/reports.py case <readId>   # starts local-reader/cases/<readId>.json
```

For each waiting report:

1. **Look at the photo** (`.reports/reports/<readId>/photo.jpg`) and write down what the sign says, panel by panel.
   The photo is the truth. The person's fixes and notes are evidence, not the answer.
2. **Find the stage that failed.** In order:
   - Apple Vision (`ocrLines`): words missing, wrong, or in the wrong place?
   - Model (`raw`): wrong kind, side, times, invented or copied content, bad JSON?
   - Post-processing (`result` vs `raw`): did a guard remove something real or miss something invented?
   - Engine (`app.verdicts` vs `app.sign`): right sign, wrong answer? Then it is a rules bug: add a fixture to
     `test/fixtures/signs.json`.
   - App: was the right answer shown badly?
3. **Write the case.** Complete `local-reader/cases/<readId>.json`: `expected` checked against the photo, and
   `status` `fixed` (post-processing can produce `expected` from `raw` + `ocrLines`) or `model` (it cannot).
4. **Fix the class of mistake, not the sign.** Prefer, in this order:
   - a guard in `postprocess` that uses what Apple Vision printed to catch what the model invented or misplaced
     (must only ever make the answer stricter when unsure);
   - a prompt change (test it against every `model` case: it must not break `fixed` ones);
   - a parser or engine change with a fixture.
   A special case for one sign is the last resort.
5. **Prove it.** `npm test && npm run test:local-reader` must pass with the new case. Every earlier case replays too,
   so a fix cannot undo an old one.
6. Merge to `main`, then tell the person the one command to update the Mac
   (`cd <repo> && git checkout main && git pull && cd local-reader && ./install-service.sh`).

If several reports share a cause, say so and fix it once. If a report is not a reader mistake (the person misread
the sign, or the photo is unreadable), record the case with a note saying so and `status: "model"`.
