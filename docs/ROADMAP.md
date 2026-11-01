# Roadmap — how the library gets built

The product is only as good as the rules library and the sign corpus behind it. This is the build order, with what "done" means for each phase. Phases 0–2 are done for Victoria; 3 onward are open.

## Phase 0 — Schema (done)

- `rules/schema/sign.schema.json`: the structured sign (panels → kind, side, limit, fee, windows, exceptions).
- `rules/schema/rule.schema.json`: the rule record (plain-English effect, verbatim quote, params, sources, verification status).
- Rule: nothing enters the engine unless it can be expressed in these two schemas. If a sign can't be represented, extend the schema first, with a fixture.

## Phase 1 — Core statute (done for Vic)

Source of truth: *Road Safety Road Rules 2017* (Vic), Part 12, rules 316–318, Schedule 1.

1. Download the authorised DOCX from legislation.vic.gov.au (`scripts/extract-vic-rules.py`), commit the extract to `rules/au-vic/sources/`.
2. For each rule the engine needs: id, number, title, plain-English effect, verbatim quote, machine params, source URL, `verification.status = verified_primary`.
3. `npm run validate` fails if a `verified_primary` rule lacks a quote or a legislation source.
4. Re-run when the instrument changes (the citation records the version number).

## Phase 2 — Sign grammar + council conventions (done for Melbourne, extendable)

- `rules/au-vic/sign-vocabulary.json`: every token that appears on signs → semantics. Based on AS 1742.11 as adopted in the VicRoads Traffic Engineering Manual.
- `rules/au-vic/councils.json`: per-council facts the statute leaves open — day-in-lieu treatment of public holidays, permit-area naming, paid-parking conventions. Each with a council source URL.
- `rules/au-vic/public-holidays.json`: dates per year, flagged `tbc` where not yet gazetted (AFL Grand Final Friday).

**Add a council:** one entry in `councils.json` with `publicHolidayPolicy.dayInLieu` and `parkingRulesUrl`. Add a fixture if the council has an unusual sign convention.

## Phase 3 — Sign corpus (open, needs photos)

The parser and vision reader are tested on typed text. Real photos are the gap.

- `test/fixtures/photos/<id>.jpg` + `<id>.json` (ground-truth structured sign + expected advice at 2–3 times).
- Target: 100 Melbourne signs covering every kind in the vocabulary, split signs, faded/angled/backlit photos.
- Sources: contributors via the Sign report issue template; a walk through the CBD, Carlton, Fitzroy, St Kilda, Richmond.
- Metric: per-panel kind/side/window accuracy for each reader; the dashboard is a script, not a service.
- Privacy: crop number plates and faces before committing.

## Phase 4 — Reader quality (open)

- Tesseract path: pre-processing (deskew, threshold), panel segmentation by colour (red vs green), arrow detection heuristics.
- Claude vision path: prompt tuned on the corpus; eval script in `scripts/eval-reader.js` scoring against fixtures; cost per read tracked.
- Both readers must output the same schema so the engine stays reader-agnostic.

## Phase 5 — Expansion (open)

Every Australian state's parking rules derive from the Australian Road Rules, so the engine and most of the vocabulary carry over. Per jurisdiction:

1. `rules/<id>/rules.json` from that state's instrument (NSW: Road Rules 2014; QLD: Transport Operations (Road Use Management—Road Rules) Regulation 2009; SA: Australian Road Rules; WA: Road Traffic Code 2000 — different numbering).
2. Public holidays + council policies.
3. Engine deltas behind data, not code: e.g. a jurisdiction without rule 206 double time just omits `accessible-permit-double-time`.
4. Timezone in the pack (`timezone` field) drives everything.

## Phase 6 — Product polish (open)

- Location: pick council automatically from GPS (council boundaries GeoJSON from data.gov.au).
- "Remind me" notification before leave-by time (Web Push or calendar file).
- Share result as image.
- Offline: rules JSON is small; cache with a service worker.

## Non-goals

- Live enforcement data, parking availability, payments.
- Anything that needs a user account.
