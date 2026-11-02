# Rules library — method

The engine never contains a legal fact; it reads them from `rules/<jurisdiction>/`. This document is the procedure for putting facts there so they can be trusted.

## Files

| File | Holds |
|---|---|
| `rules.json` | Rule records (schema: `rules/schema/rule.schema.json`) |
| `sign-vocabulary.json` | Sign tokens → meaning (documentation + parser reference) |
| `public-holidays.json` | Dates per year, with `substituteFor` and `tbc` flags |
| `councils.json` | Per-council policies and conventions, each with a source |
| `sources/` | Text extracts of the primary instrument used for verification |

## From sign to rule: the loop

1. **Collect the sign.** Photo or typed text, with location and date. Goes in a Sign report issue, then `test/fixtures/signs.json`.
2. **Tokenise.** Every token on the sign must map to something in `sign-vocabulary.json`. New token → add it, decide its semantics, cite where the meaning comes from (AS 1742.11 / the Road Rules / a council page).
3. **Find the governing rule.** Which rule makes that token binding? (e.g. TICKET → r 207; `2P` → r 204/205; MON-FRI on a holiday → r 318(3).) Add or update the rule record.
4. **Quote it.** Copy the operative subrule verbatim from the authorised text into `quote`. Put numbers into `params`. Write `plain` as advice text a driver would understand.
5. **Encode the test.** A fixture case: at this time, with this vehicle, the verdict is X and leave-by is Y. `npm test`.
6. **Mark verification.** `verified_primary` only if step 4 used the legislation itself. Record the date and the version you checked.

## Verification states

| status | Meaning | Allowed sources |
|---|---|---|
| `verified_primary` | Quote copied from the authorised instrument; `quote` and a `legislation` source are mandatory | legislation.vic.gov.au, AustLII (consolidated) |
| `verified_secondary` | Effect consistent across ≥2 official government/council pages; no verbatim quote | vic.gov.au, council sites, Legal Aid |
| `needs_primary_check` | Drafted from memory or a single secondary source. The app may use it but flags it. | anything |
| `disputed` | Sources conflict (e.g. councils disagree on day-in-lieu). The record's `notes` must say how. | — |

`npm run validate` enforces the mandatory fields. `npm run check-links` checks URLs still resolve (government CDNs sometimes 403 bots; that is a warning, not a failure).

## Updating when the law changes

The Victorian rules are amended several times a year (the version checked here is 027, 27 Oct 2026; S.R. 182/2026 renumbered the accessible-parking rules to 203/206).

```bash
python3 scripts/extract-vic-rules.py https://content.legislation.vic.gov.au/sites/default/files/<new>.docx
git diff rules/au-vic/sources/        # see what changed in Part 12
```

Then update affected records, bump `instrument.citation`, re-run tests.

## Adding a jurisdiction

1. Create `rules/<id>/` (`au-nsw`, `au-qld`…). `id` and `timezone` in `rules.json`.
2. Keep the same rule `id`s where the rule is the same (`no-stopping`, `time-limited`, `sign-times-days`…) — the engine looks rules up by id. Omit ids that don't exist there; the engine degrades gracefully (e.g. no double-time rule → no doubling).
3. Vocabulary differences (NSW "NO STANDING" is long gone; QLD "P 1/4"?) go in that pack's `sign-vocabulary.json` and, if parsing differs, behind a jurisdiction switch in the parser with fixtures.
4. Holidays and councils as for Vic.

## Known open questions (please help)

- **Rule 205A edge:** a stay that starts inside a signed window and runs past its end. Practice and r 205A say the limit stops at the window end; the engine assumes that. A ranger-confirmed example would be good.
- **Day in lieu:** r 318(3) says "a day that is a public holiday for the place" (Public Holidays Act 1993). Substitute days *are* appointed holidays, so the statute likely covers both the Saturday and the substitute Monday — Melbourne applies both, Yarra says holiday only. Modelled per council; default lowers confidence.
- **Accessible permit fee exemptions** differ by council. Not modelled; the app says "fee payable" regardless.
- **Car share / EV bays** are usually council permit zones with their own local laws; modelled as zones only.
