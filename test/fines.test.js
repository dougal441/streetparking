import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignText } from '../src/sign/parse.js';
import { interpret } from '../src/engine/interpret.js';
import { fineFor, penaltyUnitValue } from '../src/engine/fines.js';
import { loadJurisdiction } from '../src/load-node.js';

const data = await loadJurisdiction('au-vic');
const at = new Date('2026-11-04T10:00:00+11:00');
const run = (text, council = 'melbourne') => interpret(parseSignText(text, { council }), { ...data, at, council });

test('penalty unit value by financial year', () => {
  assert.equal(penaltyUnitValue(data.penalties, at).value, 209.10);
  assert.equal(penaltyUnitValue(data.penalties, new Date('2026-03-01T00:00:00+11:00')).value, 203.51);
  assert.equal(penaltyUnitValue(data.penalties, new Date('2031-01-01T00:00:00+11:00')).known, false);
});

test('no stopping = 1 unit = $209; clearway and loading zone too', () => {
  assert.equal(run('NO STOPPING').sides.both.fine.amount, 209);
  assert.equal(run('CLEARWAY').sides.both.fine.amount, 209);
  assert.equal(run('LOADING ZONE').sides.both.fine.code, '0720');
});

test('overstay: schedule 0.2 units, Melbourne council fixes 0.5 → $105', () => {
  const melb = run('2P 8AM-6PM MON-FRI', 'melbourne').sides.both;
  assert.equal(melb.verdict, 'ok'); assert.equal(melb.fine.key, 'overstay'); assert.equal(melb.fine.units, 0.5); assert.equal(melb.fine.amount, 105);
  const unknown = fineFor(data.penalties, 'overstay', at, null);
  assert.equal(unknown.units, 0.2); assert.equal(unknown.amount, 42); assert.match(unknown.note, /0\.5 penalty units/);
});

test('no parking → $105 in Melbourne; permit zone 0.6 → $125; disabled bay $209', () => {
  assert.equal(run('NO PARKING').sides.both.fine.amount, 105);
  assert.equal(run('PERMIT ZONE AREA 1A').sides.both.fine.amount, 125);
  assert.equal(run('DISABLED').sides.both.fine.amount, 209);
});

test('fee panels carry the fail-to-pay fine beside the overstay fine', () => {
  const s = run('2P TICKET 8AM-6PM MON-FRI').sides.both;
  assert.equal(s.fine.key, 'overstay'); assert.equal(s.feeFine.key, 'fee'); assert.equal(s.feeFine.code, '0702');
});

test('nothing active → no fine', () => {
  assert.equal(run('NO STOPPING 7-9AM MON-FRI').sides.both.fine, null);
});
