import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// matchCouncil lives in web/app.js (browser module); pull it out by regex so the same code is tested.
const src = await readFile('web/app.js', 'utf8');
const m = /const STRIP = [\s\S]*?\nexport function matchCouncil[\s\S]*?\n}\n/.exec(src);
assert.ok(m, 'matchCouncil not found in web/app.js');
const mod = await import('data:text/javascript,' + encodeURIComponent(m[0]));
const names = JSON.parse(await readFile('rules/au-vic/councils.json', 'utf8')).names;

test('council matching from reverse-geocode addresses', () => {
  assert.equal(mod.matchCouncil({ city: 'City of Melbourne' }, names), 'melbourne');
  assert.equal(mod.matchCouncil({ municipality: 'Yarra City Council' }, names), 'yarra');
  assert.equal(mod.matchCouncil({ county: 'Merri-bek' }, names), 'merri-bek');
  assert.equal(mod.matchCouncil({ city: 'Port Phillip' }, names), 'port-phillip');
  assert.equal(mod.matchCouncil({ city: 'Sydney' }, names), null);
  assert.equal(mod.matchCouncil({}, names), null);
});
