# Sign grammar

How `src/sign/parse.js` turns sign text into the structured sign model (`rules/schema/sign.schema.json`). Also the contract the vision reader must produce.

## Input conventions

One **panel** per line (or block of lines). A panel starts at a line containing a *kind* token; following lines without a kind token belong to it.

```
CLEARWAY 7-9AM MON-FRI TOW AWAY            ← panel 1 (clearway)
2P TICKET                                  ← panel 2 (time_limited, fee)
9AM-6.30PM MON-FRI                         ←   window 1
9AM-12.30PM SAT                            ←   window 2
AREA 7 RESIDENT PERMIT EXCEPTED            ←   exception on panel 2
```

Split signs: `LEFT:` / `RIGHT:` section lines, or arrows on the panel (`<-`, `->`, `<->`, `←`, `→`, `↔`).

Input is case-insensitive; `l`/`I` before `P` are read as `1`; `8,30` as `8.30`; `½`/`¼` as `1/2`/`1/4`; `|` as a line break.

## Kind tokens

| On the sign | kind | Rule |
|---|---|---|
| NO STOPPING, NO STANDING | `no_stopping` | 167 |
| NO PARKING | `no_parking` | 168 |
| CLEARWAY | `clearway` | 176 |
| LOADING ZONE | `loading_zone` | 179 |
| TRUCK ZONE / WORKS ZONE / TAXI ZONE / BUS ZONE / MINIBUS ZONE / MAIL ZONE | `truck_zone` … `mail_zone` | 180–186 |
| PERMIT ZONE | `permit_zone` | 185 |
| DISABLED / ACCESSIBLE / ♿ | `disabled` | 203 |
| MOTOR BIKES ONLY / MOTORCYCLE | `motorbike` | 202 |
| CAR SHARE | `car_share` | council |
| EV CHARGING / ELECTRIC VEHICLE … CHARGING | `ev_charging` | 203B/C |
| BICYCLE PARKING | `bicycle` | 201 |
| `2P`, `1/2P`, `1/4P`, `P 10 MINUTE`, `15 MIN` | `time_limited` (+ `limitMinutes`) | 204, 205 |
| `P` alone | `unrestricted` | 205(1A) |

A zone token followed on the next line by a bare limit (`DISABLED` / `2P`) is one panel with that limit.

## Modifiers

| Token | Field |
|---|---|
| TICKET, METER, METERED, PAY, PAY BY PHONE, PAYSTAY | `fee: true` (r 207) |
| AREA (not part of `AREA 7 … PERMIT`) | `area: true` |
| TOW AWAY | `towAway: true` |
| AREA 7 RESIDENT PERMIT EXCEPTED, PERMIT HOLDERS EXCEPTED, EXCEPT PERMIT HOLDERS | `exceptions: [{type: resident_permit, area: "7"}]` |
| PERMIT ZONE AREA 1A | exception with `area: "1A"` (defines which permit) |
| EXCEPT BUSES / TAXIS | `exceptions: [{type: buses|taxis}]` |
| PUBLIC HOLIDAYS, PUB HOLS, P.H. | `window.publicHolidays: include` |
| EXCEPT PUBLIC HOLIDAYS | `window.publicHolidays: exclude` |
| 24 HOURS / AT ALL TIMES | no windows (always) |

## Time windows

`windows: []` = applies at all times. Otherwise each `{days, start, end, publicHolidays}`.

- Times: `8AM-6PM`, `8.30AM-12.30PM`, `7-9AM` (shared suffix), `4-6.30PM`, `11.30-1PM` (suffix inferred so start < end), `6PM-MIDNIGHT` (end `24:00`), `10PM-6AM` (overnight, end < start).
- Days: `MON-FRI`, `MON-SAT`, `SAT`, `SAT SUN`, `SAT-SUN`, `MON TO FRI`, `WEEKDAYS`, `FRI-MON` (wraps). ISO numbers 1=Mon…7=Sun. `days: null` = no days printed.
- A day spec attaches to the time range before it; a sign with `8AM-6PM MON-FRI / 8AM-1PM SAT` yields two windows.

## Sides

`side` is the arrow direction *as you face the sign*: `left`, `right`, or `both` (double-headed arrow or no arrow). The engine evaluates each side with the panels whose side is that side or `both`. If no panel has a single-sided arrow the result has one entry, `both`.

## Precedence inside the engine (per side, at one instant)

1. Active `no_stopping` / `clearway` → **NO**.
2. Active zone the vehicle isn't entitled to → **NO** (loading zone: goods vehicles get the signed or 30-minute limit).
3. Active `no_parking` → **STOP ONLY** (2 min; 5 min with accessible permit; sign may state a time).
4. Active `time_limited` → **OK** with the shortest limit (×2 with accessible permit); `fee` if any active panel charges.
5. Active `unrestricted` → **OK**, no limit.
6. Nothing active → **OK**, no restriction from this sign (general rules still apply).

A panel whose window names days is inactive on a public holiday unless it says PUBLIC HOLIDAYS (r 318(3)). A panel listing an exception that matches the vehicle profile is skipped for that user.
