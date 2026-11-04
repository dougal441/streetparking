#!/usr/bin/env python3
"""Generate the non-Victorian state packs from the Victorian one.

Every Australian state's parking rules derive from the national Australian Road Rules, so the rule *ids*,
plain-English effect and params carry over; what changes is the instrument (which document, which URL),
the rule numbers in a few places, and which Victoria-only rules do not exist. Everything generated here is
marked `needs_primary_check` with a per-state link: the job of verifying each pack against its own
legislation (the way au-vic was verified against the authorised text) is Phase 5 in docs/ROADMAP.md.

Run: python3 scripts/make-state-packs.py   (idempotent; never touches rules/au-vic)
"""
import json, copy, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'rules'
VIC = json.load(open(ROOT / 'au-vic' / 'rules.json'))
TODAY = datetime.date.today().isoformat()

STATES = {
    'au-nsw': {'name': 'New South Wales', 'timezone': 'Australia/Sydney',
               'instrument': {'title': 'Road Rules 2014 (NSW)', 'citation': 'Part 12 — Restrictions on stopping and parking; rules 316–318', 'url': 'https://legislation.nsw.gov.au/view/html/inforce/current/sl-2014-0758', 'altUrl': 'https://classic.austlii.edu.au/au/legis/nsw/consol_reg/rr2014104/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'NSW uses national numbering. Rule 206 (disability permit time extension) exists in NSW with the national wording (not Victoria\'s double-time scheme). NSW adds rule 207-1 (metered parking) and 207-2 (ticket parking).'},
    'au-qld': {'name': 'Queensland', 'timezone': 'Australia/Brisbane',
               'instrument': {'title': 'Transport Operations (Road Use Management—Road Rules) Regulation 2009 (Qld)', 'citation': 'Part 12 — Restrictions on stopping and parking; sections 316–318', 'url': 'https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2009-0194', 'altUrl': 'https://classic.austlii.edu.au/au/legis/qld/consol_reg/toumrr2009629/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'Queensland uses the national numbering as section numbers.'},
    'au-sa':  {'name': 'South Australia', 'timezone': 'Australia/Adelaide',
               'instrument': {'title': 'Australian Road Rules (as applied in SA under the Road Traffic Act 1961)', 'citation': 'Part 12 — Restrictions on stopping and parking; rules 316–318', 'url': 'https://www.legislation.sa.gov.au/lz?path=/c/r/australian%20road%20rules', 'altUrl': 'https://classic.austlii.edu.au/au/legis/sa/consol_reg/arr210/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'SA applies the Australian Road Rules directly.'},
    'au-wa':  {'name': 'Western Australia', 'timezone': 'Australia/Perth',
               'instrument': {'title': 'Road Traffic Code 2000 (WA)', 'citation': 'Part 12 — Stopping and parking (regulation numbers differ from the national rules)', 'url': 'https://www.legislation.wa.gov.au/legislation/statutes.nsf/law_s6218.html', 'altUrl': 'https://classic.austlii.edu.au/au/legis/wa/consol_reg/rtc2000148/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness', 'accessible-permit-double-time'], 'renumber': 'WA regulation numbers are NOT the national numbers; each rule below still carries the national number until verified.', 'notes': 'WA did not adopt the Australian Road Rules; its Road Traffic Code covers the same signs (AS 1742.11) with its own regulation numbers.'},
    'au-tas': {'name': 'Tasmania', 'timezone': 'Australia/Hobart',
               'instrument': {'title': 'Road Rules 2019 (Tas)', 'citation': 'Part 12 — Restrictions on stopping and parking; rules 316–318', 'url': 'https://www.legislation.tas.gov.au/view/html/inforce/current/sr-2019-078', 'altUrl': 'https://classic.austlii.edu.au/au/legis/tas/consol_reg/rr2019116/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'Tasmania uses the national numbering.'},
    'au-nt':  {'name': 'Northern Territory', 'timezone': 'Australia/Darwin',
               'instrument': {'title': 'Australian Road Rules (as applied in the NT under the Traffic Regulations 1999)', 'citation': 'Part 12 — Restrictions on stopping and parking; rules 316–318', 'url': 'https://legislation.nt.gov.au/Legislation/TRAFFIC-REGULATIONS-1999', 'altUrl': 'https://classic.austlii.edu.au/au/legis/nt/consol_reg/tr1999157/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'The NT applies the Australian Road Rules with local modifications.'},
    'au-act': {'name': 'Australian Capital Territory', 'timezone': 'Australia/Canberra',
               'instrument': {'title': 'Road Transport (Road Rules) Regulation 2017 (ACT)', 'citation': 'Part 12 — Restrictions on stopping and parking; sections 316–318', 'url': 'https://www.legislation.act.gov.au/sl/2017-43', 'altUrl': 'https://classic.austlii.edu.au/au/legis/act/consol_reg/rtrr2017391/'},
               'drop': ['parking-outside-times', 'ev-parking', 'sign-likeness'], 'notes': 'The ACT uses the national numbering as section numbers; it has its own 205A (parking outside times indicated) — verify.'},
}

for pid, st in STATES.items():
    pack = {'id': pid, 'name': st['name'], 'timezone': st['timezone'], 'instrument': st['instrument'], 'rules': []}
    for r in VIC['rules']:
        if r['id'] in st['drop']:
            continue
        rr = copy.deepcopy(r)
        rr['quote'] = None  # the Victorian wording is not this state's wording
        rr['sources'] = [{'url': st['instrument']['url'], 'kind': 'legislation', 'note': f"{st['instrument']['title']} — national rule {r['number']}; wording not yet checked"}]
        rr['verification'] = {'status': 'needs_primary_check', 'checkedOn': TODAY, 'checkedBy': 'scripts/make-state-packs.py (derived from au-vic / national rules)',
                              'notes': 'Generated from the Victorian pack because every state adopts the Australian Road Rules. Verify wording, numbering and any state modifications against the instrument above.' + (' ' + st['renumber'] if 'renumber' in st else '')}
        if rr['id'] == 'accessible-permit-double-time':
            rr['plain'] = 'National rule 206: a vehicle displaying a current disability parking permit may park longer than the signed time — in most states twice the period where the sign shows 30 minutes or more. Exact concession varies by state; verify.'
        pack['rules'].append(rr)
    d = ROOT / pid; d.mkdir(exist_ok=True)
    json.dump(pack, open(d / 'rules.json', 'w'), indent=2, ensure_ascii=False)
    json.dump({'jurisdiction': pid, 'councils': {}, 'default': {'publicHolidayPolicy': {'dayInLieu': 'unknown', 'note': 'No council policies recorded for this state yet.'}}, 'names': {}},
              open(d / 'councils.json', 'w'), indent=2)
    print(pid, len(pack['rules']), 'rules')
