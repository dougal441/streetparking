import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignText } from '../src/sign/parse.js';
import { interpret, VERDICT } from '../src/engine/interpret.js';
import { holidayStatus } from '../src/engine/holidays.js';
import { loadJurisdiction } from '../src/load-node.js';
import fixtures from './fixtures/signs.json' with { type: 'json' };

const data = await loadJurisdiction('au-vic');
const run = (text, at, extra = {}) => interpret(parseSignText(text, { council: extra.council ?? null }), { ...data, at: new Date(at), ...extra });

test('holiday lookup', () => {
  assert.equal(holidayStatus('2026-11-03', data.holidays, { dayInLieu: 'both' }).isHoliday, true);
  assert.equal(holidayStatus('2026-11-04', data.holidays, { dayInLieu: 'both' }).isHoliday, false);
  assert.equal(holidayStatus('2026-12-28', data.holidays, { dayInLieu: 'holiday_only' }).isHoliday, false);
  assert.equal(holidayStatus('2026-12-28', data.holidays, { dayInLieu: 'both' }).isHoliday, true);
  assert.equal(holidayStatus('2030-01-01', data.holidays, {}).confidence, 'low');
});

for (const f of fixtures) {
  for (const c of f.cases) {
    test(`${f.id} @ ${c.at}${c.note ? ' — ' + c.note : ''}`, () => {
      const res = run(f.text, c.at, { vehicle: c.vehicle, council: f.council ?? null });
      const side = res.sides[c.side] ?? res.sides.both;
      assert.ok(side, `side ${c.side} missing; have ${Object.keys(res.sides)}`);
      assert.equal(side.verdict, c.verdict, `verdict: ${side.headline}`);
      if ('maxStayMinutes' in c) assert.equal(side.maxStayMinutes, c.maxStayMinutes, `maxStay: ${side.headline}`);
      if ('fee' in c) assert.equal(side.fee, c.fee);
      if ('leaveBy' in c) assert.equal(side.leaveBy?.toISOString(), new Date(c.leaveBy).toISOString(), `leaveBy (${side.leaveByReason})`);
      if ('holiday' in c) assert.equal(res.holiday.isHoliday, c.holiday);
    });
  }
}

test('split sign yields left and right', () => {
  const res = run('LEFT:\n2P 8AM-6PM MON-FRI\nRIGHT:\nNO STOPPING', '2026-11-04T10:00:00+11:00');
  assert.equal(res.split, true);
  assert.equal(res.sides.left.verdict, VERDICT.OK);
  assert.equal(res.sides.right.verdict, VERDICT.NO);
});

test('timeline is contiguous and starts now', () => {
  const at = '2026-11-04T10:00:00+11:00';
  const res = run('CLEARWAY 7-9AM MON-FRI\n2P 9AM-6PM MON-FRI', at);
  const tl = res.sides.both.timeline;
  assert.equal(tl[0].from.toISOString(), new Date(at).toISOString());
  for (let i = 1; i < tl.length; i++) assert.equal(tl[i].from.getTime(), tl[i - 1].to.getTime());
  assert.equal(tl.at(-1).to, null);
  const verdicts = tl.map(s => `${s.verdict}:${s.maxStayMinutes}`);
  assert.deepEqual(verdicts.slice(0, 4), ['ok:120', 'ok:null', 'no:0', 'ok:120']);
});

test('rules referenced carry source links', () => {
  const res = run('NO STOPPING', '2026-11-04T10:00:00+11:00');
  assert.ok(res.rules.length >= 1);
  for (const r of [...res.rules, ...res.generalRules]) assert.match(r.url, /^https:\/\//);
});
