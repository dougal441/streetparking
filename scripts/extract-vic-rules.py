#!/usr/bin/env python3
"""Download the authorised Road Safety Road Rules 2017 (Vic) DOCX and write a text extract of
Part 12 (stopping and parking), rules 316-318 and Schedule 1 to rules/au-vic/sources/.

Usage: python3 scripts/extract-vic-rules.py [docx-url]
Find the current URL on https://www.legislation.vic.gov.au/in-force/statutory-rules/road-safety-road-rules-2017
(click the latest version, then the Word download).
"""
import html, os, re, sys, urllib.request, zipfile, io, datetime

URL = sys.argv[1] if len(sys.argv) > 1 else 'https://content.legislation.vic.gov.au/sites/default/files/2026-10/17-41sr027.docx'
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'rules', 'au-vic', 'sources')

def docx_paragraphs(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    x = z.read('word/document.xml').decode('utf8')
    out = []
    for p in re.findall(r'<w:p[ >].*?</w:p>', x, flags=re.S):
        t = html.unescape(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p)))
        if t.strip():
            out.append(t)
    return out

def find(lines, num):
    pat = re.compile(r'^\s*' + re.escape(num) + r'(?=[A-Z][a-z])')
    idx = [i for i, l in enumerate(lines) if pat.match(l)]
    return idx[-1] if idx else None

def main():
    req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (CanIparkhere rules extractor)'})
    data = urllib.request.urlopen(req, timeout=120).read()
    lines = docx_paragraphs(data)
    version = next((l for l in lines[:5] if l.startswith('Version No.')), 'Version ?')
    asat = next((l for l in lines[:8] if 'amendments as at' in l), '')
    txt = '\n'.join(lines)
    seg1 = '\n'.join(lines[find(lines, '165'):find(lines, '214')])
    seg2 = '\n'.join(lines[find(lines, '316'):find(lines, '319')])
    i = txt.rfind('Schedule 1—Abbreviations and symbols'); j = txt.find('Schedule 2—Standard', i)
    seg3 = txt[i:j]
    segs = []
    for term in ['accessible parking permit', 'parking control sign means', 'permissive parking sign', 'public holiday, for a place', 'truck means', 'motor bike means', 'taxi means', 'with, for', 'park means', 'stop, for']:
        k = txt.rfind(term)
        if k >= 0:
            segs.append(txt[k:k + 700])
    hdr = f"""EXTRACT — Road Safety Road Rules 2017 (Vic), S.R. No. 41/2017, {version}
({asat})
Source: https://www.legislation.vic.gov.au/in-force/statutory-rules/road-safety-road-rules-2017
Document: {URL}
Extracted: {datetime.date.today().isoformat()} by scripts/extract-vic-rules.py (text only; diagrams omitted)
© State of Victoria. Victorian legislation on legislation.vic.gov.au is published under a Creative Commons Attribution 4.0 licence — see https://www.legislation.vic.gov.au/copyright
This extract is reference material for cross-checking rules/au-vic/rules.json. It is NOT the authorised version.
=====================================================================
"""
    os.makedirs(OUT_DIR, exist_ok=True)
    vnum = re.sub(r'\D', '', version) or 'latest'
    out = os.path.join(OUT_DIR, f'rsrr2017-v{vnum}-part12-extract.txt')
    with open(out, 'w') as f:
        f.write(hdr + "\n\n=== PART 12 — RESTRICTIONS ON STOPPING AND PARKING (rules 165–213) ===\n" + seg1
                + "\n\n=== RULES 316–318 (traffic control devices: likeness, times/days, public holidays) ===\n" + seg2
                + "\n\n=== SCHEDULE 1 — ABBREVIATIONS ===\n" + seg3
                + "\n\n=== DICTIONARY (selected) ===\n" + '\n---\n'.join(segs))
    print('wrote', out)

if __name__ == '__main__':
    main()
