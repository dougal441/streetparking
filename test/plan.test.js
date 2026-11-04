import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignText } from '../src/sign/parse.js';
import { interpret } from '../src/engine/interpret.js';
import { loadJurisdiction } from '../src/load-node.js';

const data = await loadJurisdiction('au-vic');
const run = (text, at) => interpret(parseSignText(text, { council: 'melbourne' }), { ...data, at: new Date(at), council: 'melbourne' });

test('plain sentences for a stacked sign through the day', () => {
  const sign = 'CLEARWAY 7-9.30AM MON-FRI\n1P METER 9.30AM-3.30PM MON-FRI\nLOADING ZONE 3.30PM-4.30PM MON-FRI\nNO STOPPING 4.30-6.30PM MON-FRI\n2P 6.30PM-MIDNIGHT MON-FRI';
  const morning = run(sign, '2026-11-04T08:00:00+11:00').sides.both;
  assert.match(morning.plan[0], /cannot park/);
  assert.match(morning.plan[1], /From 9:30am \(in 1h 30m\) you can park here for up to 1 hour, fee payable until 3:30pm/);
  const noon = run(sign, '2026-11-04T12:00:00+11:00').sides.both;
  assert.match(noon.plan[0], /up to 1 hour \(pay first\)/);
  assert.match(noon.plan[1], /Be gone by 1pm/);
  const late = run(sign, '2026-11-04T17:00:00+11:00').sides.both;
  assert.match(late.plan[1], /From 6:30pm \(in 1h 30m\) you can park here for up to 2 hours until 7am tomorrow/);
  assert.equal(late.nextOk.maxStayMinutes, 120);
});

test('reader put every panel on one side → unknown with guidance, no fine', () => {
  const r = interpret({ jurisdiction: 'au-vic', panels: [{ kind: 'no_stopping', side: 'left' }, { kind: 'works_zone', side: 'left' }] }, { ...data, at: new Date('2026-11-04T13:00:00+11:00') });
  assert.equal(r.sides.right.verdict, 'unknown'); assert.equal(r.sides.right.fine, null); assert.deepEqual(r.sides.right.plan, []);
});
