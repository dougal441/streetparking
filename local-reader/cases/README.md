# Replay cases

One file per read that was reported wrong (the app's "Reader got it wrong" button). Made with
`python3 scripts/reports.py case <readId>`, then completed by hand. See docs/REPORTS.md.

```json
{
  "id": "20261110-070712-ab12cd",
  "status": "fixed",
  "note": "what the person said, and what was actually wrong",
  "jurisdiction": "au-vic", "council": "melbourne",
  "ocrLines": [],
  "raw": "the model's reply, verbatim",
  "expected": {"panels": []}
}
```

- `ocrLines` and `raw` come straight from the report's `read.json`.
- `expected` is the sign as printed, checked against the photo.
- `status: "fixed"`: `server.postprocess(raw, ocrLines)` must produce `expected`. Asserted by `test_server.py` on every push.
- `status: "model"`: post-processing cannot recover it (the model missed or misread something). Not asserted;
  it is the list to re-run when the prompt or model changes.
