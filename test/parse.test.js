import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignText, extractTimeRanges, extractDays } from '../src/sign/parse.js';
import fixtures from './fixtures/signs.json' with { type: 'json' };

test('time ranges', () => {
  const t = (s) => extractTimeRanges(s.toUpperCase()).map(r => `${r.start}-${r.end}`);
  assert.deepEqual(t('8AM-6PM'), ['08:00-18:00']);
  assert.deepEqual(t('7-9AM'), ['07:00-09:00']);
  assert.deepEqual(t('4-6.30PM'), ['16:00-18:30']);
  assert.deepEqual(t('11.30-1PM'), ['11:30-13:00']);
  assert.deepEqual(t('6PM-MIDNIGHT'), ['18:00-24:00']);
  assert.deepEqual(t('MIDNIGHT-6AM'), ['00:00-06:00']);
  assert.deepEqual(t('10PM-6AM'), ['22:00-06:00']);
  assert.deepEqual(t('12-2PM'), ['12:00-14:00']);
  assert.deepEqual(t('9AM TO 5PM'), ['09:00-17:00']);
  assert.deepEqual(t('8AM-6PM MON-FRI 8AM-1PM SAT'), ['08:00-18:00', '08:00-13:00']);
});

test('days', () => {
  const d = (s) => extractDays(s.toUpperCase()).map(x => x.days);
  assert.deepEqual(d('MON-FRI'), [[1, 2, 3, 4, 5]]);
  assert.deepEqual(d('SAT-SUN'), [[6, 7]]);
  assert.deepEqual(d('SAT SUN'), [[6], [7]]);
  assert.deepEqual(d('MON TO SAT'), [[1, 2, 3, 4, 5, 6]]);
  assert.deepEqual(d('FRI-MON'), [[5, 6, 7, 1]]);
  assert.deepEqual(d('WEEKDAYS'), [[1, 2, 3, 4, 5]]);
});

test('limits', () => {
  assert.equal(parseSignText('2P').panels[0].limitMinutes, 120);
  assert.equal(parseSignText('1/2P').panels[0].limitMinutes, 30);
  assert.equal(parseSignText('¼P').panels[0].limitMinutes, 15);
  assert.equal(parseSignText('P 10 MINUTE').panels[0].limitMinutes, 10);
  assert.equal(parseSignText('15 MIN').panels[0].limitMinutes, 15);
  assert.equal(parseSignText('P').panels[0].kind, 'unrestricted');
  assert.equal(parseSignText('4P METER').panels[0].fee, true);
  assert.equal(parseSignText('2P AREA').panels[0].area, true);
  assert.equal(parseSignText('LOADING ZONE 15 MINS').panels[0].limitMinutes, 15);
});

for (const f of fixtures.filter(x => x.expectPanels)) {
  test(`fixture panels: ${f.id}`, () => {
    const sign = parseSignText(f.text, { council: f.council ?? null });
    assert.equal(sign.panels.length, f.expectPanels.length, `panel count for ${f.id}: got ${JSON.stringify(sign.panels.map(p => p.kind))}`);
    f.expectPanels.forEach((exp, i) => {
      const got = sign.panels[i];
      for (const [k, v] of Object.entries(exp)) {
        if (k === 'windows') {
          assert.equal(got.windows.length, v.length, `${f.id} panel ${i} window count`);
          v.forEach((w, j) => { for (const [wk, wv] of Object.entries(w)) assert.deepEqual(got.windows[j][wk], wv, `${f.id} panel ${i} window ${j} ${wk}`); });
        } else if (k === 'exceptions') {
          v.forEach((e, j) => { for (const [ek, ev] of Object.entries(e)) assert.deepEqual(got.exceptions[j]?.[ek], ev, `${f.id} panel ${i} exception ${j} ${ek}`); });
        } else assert.deepEqual(got[k], v, `${f.id} panel ${i} ${k}`);
      }
    });
  });
}
