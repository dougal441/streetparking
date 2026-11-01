# CanIparkhere

**Photograph a Melbourne street parking sign. Get told whether you can park there right now, for how long, and when you must leave.**

Street parking signs in Melbourne stack three or four restrictions on one post, split left/right with arrows, switch off on public holidays, and change meaning by the hour. People get fined for misreading them. This project turns a photo (or typed sign text) into a plain answer, backed by a rules library that cites the actual legislation.

Live (soon): <https://dougalhanson.com/streetparking>

```
CLEARWAY 7-9AM MON-FRI                     Wed 10:00 →  ✅ Yes — up to 2 hours, fee payable.
2P TICKET 9AM-6.30PM MON-FRI                            ⏱ Leave by 12:00pm (2 hours limit)
9AM-12.30PM SAT                            Wed 17:30 →  ✅ Yes — 2P runs only until 6:30pm; next
AREA 7 RESIDENT PERMIT EXCEPTED                            restriction is the clearway at 7am Thu.
                                           Tue 3 Nov →  ✅ Melbourne Cup Day: MON-FRI signs don't apply.
```

## How it works

```
photo ──► reader ──► sign text ──► parser ──► structured sign ──► engine ──► advice per side
          (OCR on-device, or                 (rules/schema/sign.schema.json)   + "leave by"
           Claude vision via proxy)                                           + timeline
                                                                              + rules cited (with links)
```

| Piece | Where | What |
|---|---|---|
| Rules library | `rules/au-vic/` | Every rule the engine relies on, with plain-English effect, verbatim quote, source links and a verification status. 37 rules, all checked against the authorised *Road Safety Road Rules 2017* (Vic) text. |
| Sign grammar | `src/sign/parse.js`, `docs/SIGN_GRAMMAR.md` | Turns sign text (`2P TICKET 9AM-6.30PM MON-FRI ->`) into panels with kind, side, limit, fee, time windows, exceptions. |
| Engine | `src/engine/` | Pure functions. Given a sign, a moment and a vehicle profile, returns a verdict for each side of the post, a leave-by time and a timeline of what changes next. Handles rule 318 public-holiday logic, overnight windows, permit exceptions, accessible-permit double time. |
| Readers | `src/reader/` | `tesseract.js` (free, on-device, rough) or Claude vision through `server/` (accurate on split signs and arrows; needs an API key server-side). |
| Applet | `web/` | Single page, no build step, no framework. Embeds anywhere. |
| Tests | `test/` | Fixture signs with expected panels and expected verdicts at specific times. `npm test`. |

## Try it

```bash
git clone https://github.com/dougal441/streetparking && cd streetparking
npm test                 # engine + parser tests
npm run serve            # http://localhost:8787/web/  (on-device OCR only)
```

With the vision reader (optional, much better on real photos):

```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...     # or `ant auth login`
npm run reader           # same URL, plus POST /api/read-sign
```

Then set `readerUrl: '/api/read-sign'` in `web/index.html`. See [docs/DEPLOY.md](docs/DEPLOY.md) for putting it on a website.

Use it from code:

```js
import { parseSignText, interpret } from './src/index.js';
import { loadJurisdiction } from './src/load-node.js';

const data = await loadJurisdiction('au-vic');
const sign = parseSignText('NO STOPPING 7-9AM MON-FRI\n2P 9AM-6PM MON-SAT ->');
const advice = interpret(sign, { ...data, at: new Date(), vehicle: { type: 'car', permits: [] } });
console.log(advice.sides.right.headline, advice.sides.right.leaveBy);
```

## The rules library

Each entry in `rules/au-vic/rules.json` looks like:

```json
{
  "id": "no-parking", "number": "168", "title": "No parking signs",
  "plain": "... stop only to drop off or pick up ... within 2 minutes ... within 3 m of the vehicle ...",
  "quote": "(1) The driver of a vehicle must not stop ... unless the driver— (a) is dropping off, or picking up ...",
  "params": { "maxMinutes": 2, "maxDistanceMetres": 3 },
  "sources": [{ "url": "https://www.legislation.vic.gov.au/in-force/statutory-rules/road-safety-road-rules-2017/027", "kind": "legislation" }],
  "verification": { "status": "verified_primary", "checkedOn": "2026-11-01", "checkedBy": "authorised DOCX v027" }
}
```

`verification.status` is the honesty flag: `verified_primary` (quote checked against the legislation), `verified_secondary` (consistent across official council/government pages), `needs_primary_check` (drafted, not yet checked), `disputed`. `npm run validate` enforces the schema; `npm run check-links` checks every source URL. The text we checked against is kept in `rules/au-vic/sources/` so anyone can diff.

How the library is built, phase by phase, and how to add a council or another state: [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/RULES_LIBRARY.md](docs/RULES_LIBRARY.md).

## Status

- [x] Victoria rules pack (Road Safety Road Rules 2017, Part 12) — verified against authorised text, version 027 (27 Oct 2026)
- [x] Sign grammar + parser with OCR-noise tolerance
- [x] Engine: per-side verdicts, leave-by, timeline, public holidays (r 318), permits (r 185, 206), zones
- [x] Web applet with on-device OCR and optional Claude vision reader
- [x] City of Melbourne / Yarra / Bayside public-holiday policies
- [ ] Sign photo corpus with ground truth (please contribute — see `.github/ISSUE_TEMPLATE/sign-report.yml`)
- [ ] More councils' permit-area conventions and local laws
- [ ] Other states (NSW, QLD, SA… all derive from the Australian Road Rules, so the engine mostly carries over)

## Not legal advice

Signs, councils and OCR all make mistakes, and so can this. If the sign and the app disagree, the sign wins. Please report misreads — every report becomes a test fixture.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, fork it, improve it, run it for your community — but not commercially. Victorian legislation text in `rules/au-vic/sources/` is © State of Victoria, [CC BY 4.0](https://www.legislation.vic.gov.au/copyright).
