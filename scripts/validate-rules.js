// Dependency-free validation of the rules packs + fixtures. Run: npm run validate
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const errors = [];
const err = (m) => errors.push(m);
const isUrl = (u) => /^https:\/\/[^ ]+$/.test(u);
const STATUS = ['verified_primary', 'verified_secondary', 'needs_primary_check', 'disputed'];
const KINDS = ['time_limited', 'unrestricted', 'no_stopping', 'no_parking', 'clearway', 'loading_zone', 'bus_zone', 'taxi_zone', 'works_zone', 'mail_zone', 'truck_zone', 'minibus_zone', 'permit_zone', 'disabled', 'motorbike', 'car_share', 'ev_charging', 'bicycle', 'unknown'];

const packs = (await readdir('rules', { withFileTypes: true })).filter(d => d.isDirectory() && d.name !== 'schema').map(d => d.name);
for (const id of packs) {
  const pack = JSON.parse(await readFile(path.join('rules', id, 'rules.json'), 'utf8'));
  if (pack.id !== id) err(`${id}: pack id mismatch`);
  if (!isUrl(pack.instrument?.url)) err(`${id}: instrument url`);
  const ids = new Set();
  for (const r of pack.rules) {
    const tag = `${id}/${r.id}`;
    if (!/^[a-z0-9-]+$/.test(r.id ?? '')) err(`${tag}: bad id`);
    if (ids.has(r.id)) err(`${tag}: duplicate id`); ids.add(r.id);
    for (const k of ['number', 'title', 'plain']) if (!r[k]) err(`${tag}: missing ${k}`);
    if (!Array.isArray(r.sources) || !r.sources.length) err(`${tag}: needs at least one source`);
    for (const s of r.sources ?? []) { if (!isUrl(s.url)) err(`${tag}: bad source url ${s.url}`); if (!['legislation', 'government', 'council', 'secondary'].includes(s.kind)) err(`${tag}: bad source kind`); }
    if (!STATUS.includes(r.verification?.status)) err(`${tag}: bad verification.status`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.verification?.checkedOn ?? '')) err(`${tag}: bad checkedOn`);
    if (r.verification?.status === 'verified_primary') {
      if (!r.quote) err(`${tag}: verified_primary requires a verbatim quote`);
      if (!(r.sources ?? []).some(s => s.kind === 'legislation')) err(`${tag}: verified_primary requires a legislation source`);
    }
    for (const a of r.appliesTo ?? []) if (a !== 'general' && !KINDS.includes(a)) err(`${tag}: appliesTo unknown kind ${a}`);
  }
  try {
    const hol = JSON.parse(await readFile(path.join('rules', id, 'public-holidays.json'), 'utf8'));
    const seen = new Set();
    for (const h of hol.holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) err(`${id} holidays: bad date ${h.date}`);
      if (seen.has(h.date)) err(`${id} holidays: duplicate ${h.date}`); seen.add(h.date);
      if (!h.name) err(`${id} holidays: missing name for ${h.date}`);
    }
  } catch (e) { if (e.code !== 'ENOENT') err(`${id} holidays: ${e.message}`); }
  console.log(`${id}: ${pack.rules.length} rules, ${pack.rules.filter(r => r.verification.status === 'verified_primary').length} verified_primary, ${pack.rules.filter(r => r.verification.status === 'needs_primary_check').length} need primary check`);
}

const fixtures = JSON.parse(await readFile('test/fixtures/signs.json', 'utf8'));
for (const f of fixtures) {
  if (!f.id || !f.text || !Array.isArray(f.cases)) err(`fixture ${f.id}: id/text/cases required`);
  for (const p of f.expectPanels ?? []) if (p.kind && !KINDS.includes(p.kind)) err(`fixture ${f.id}: unknown kind ${p.kind}`);
}
console.log(`${fixtures.length} fixtures`);

if (errors.length) { console.error('\nVALIDATION FAILED'); for (const e of errors) console.error(' -', e); process.exit(1); }
console.log('validate: OK');
