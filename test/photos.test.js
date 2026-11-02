// Photo corpus: each test/fixtures/photos/<id>.json holds the ground-truth structured sign for <id>.webp/.jpg,
// the typed text equivalent, and expected verdicts. Readers are scored against `sign`; the parser against `text`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parseSignText } from '../src/sign/parse.js';
import { interpret } from '../src/engine/interpret.js';
import { loadJurisdiction } from '../src/load-node.js';

const dir = 'test/fixtures/photos';
const data = await loadJurisdiction('au-vic');
const files = (await readdir(dir)).filter(f => f.endsWith('.json'));

for (const f of files) {
  const fx = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
  test(`photo fixture ${fx.id}: photo file exists`, async () => { await access(path.join(dir, fx.photo)); });

  test(`photo fixture ${fx.id}: typed text parses to the ground-truth sign`, () => {
    const parsed = parseSignText(fx.text, { council: fx.sign.council ?? null });
    assert.equal(parsed.panels.length, fx.sign.panels.length);
    fx.sign.panels.forEach((exp, i) => {
      assert.equal(parsed.panels[i].kind, exp.kind, `panel ${i} kind`);
      assert.equal(parsed.panels[i].side, exp.side, `panel ${i} side`);
      assert.deepEqual(parsed.panels[i].windows, exp.windows, `panel ${i} windows`);
      if ('limitMinutes' in exp) assert.equal(parsed.panels[i].limitMinutes, exp.limitMinutes);
    });
  });

  for (const c of fx.cases) {
    test(`photo fixture ${fx.id} @ ${c.at}${c.note ? ' — ' + c.note : ''}`, () => {
      const res = interpret(fx.sign, { ...data, at: new Date(c.at), vehicle: c.vehicle, council: fx.sign.council ?? null });
      const side = res.sides[c.side] ?? res.sides.both;
      assert.equal(side.verdict, c.verdict, side.headline);
      if ('maxStayMinutes' in c) assert.equal(side.maxStayMinutes, c.maxStayMinutes);
      if ('leaveBy' in c) assert.equal(side.leaveBy?.toISOString(), new Date(c.leaveBy).toISOString(), side.leaveByReason);
      if ('holiday' in c) assert.equal(res.holiday.isHoliday, c.holiday);
    });
  }
}
