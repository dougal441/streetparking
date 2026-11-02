# Contributing to CanIparkhere

Thanks. Three kinds of help are especially valuable, in order:

## 1. Signs that were read wrong (no coding needed)

Open an issue with the **Sign report** template: what the sign says, where it is, what the app said, what you think is right. Photos help. Each confirmed report becomes a fixture in `test/fixtures/signs.json`, so the mistake can't come back.

## 2. Rules and councils

- Every rule entry must have at least one source URL and a `verification.status`. Do not mark `verified_primary` unless you have the legislation text open and copied the quote from it.
- Prefer `legislation.vic.gov.au` (authorised) over AustLII; prefer council pages over news articles.
- Re-run `python3 scripts/extract-vic-rules.py <docx-url>` when a new version of the Road Safety Road Rules is published, commit the new extract, and bump `instrument.citation`.
- Public holidays: update `rules/au-vic/public-holidays.json` each year from business.vic.gov.au.
- Council policies (day-in-lieu, permit area naming, paid parking): `rules/au-vic/councils.json`. Cite the council page.

## 3. Code

- Plain ES modules, no build step, no dependencies in the engine. It must run identically in Node and the browser.
- `npm test` and `npm run validate` must pass. Add a fixture for any behaviour change.
- The engine is pure: same sign + same time + same vehicle = same output. Put I/O in readers/UI only.
- Keep rule *numbers* in advice text so users can look things up.

Run everything:

```bash
npm test && npm run validate && npm run check-links
```

By contributing you agree your contribution is licensed under the project's PolyForm Noncommercial 1.0.0 licence.
