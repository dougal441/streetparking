// RET-02: the docs say the app is hosted privately at dougalhanson.com/caniparkhere; no doc points a reader at the
// retired Pages mirror, a phone-link, a ?reader= override or a token in a URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [p]);
const docs = ['README.md', 'docs', 'local-reader/README.md']
  .map((p) => join(root, p)).filter(existsSync).flatMap(walk).filter((f) => f.endsWith('.md'));

test('RET-02: the doc set is non-empty and names the private hosted address', () => {
  assert.ok(docs.length >= 2, 'found docs: ' + docs.length);
  const all = docs.map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.match(all, /dougalhanson\.com\/caniparkhere/);
});

for (const [label, re] of [
  ['the retired Pages mirror (github.io)', /github\.io/i],
  ['a phone-link', /phone-link/i],
  ['a ?reader= override', /\?reader=/],
  ['a token in a URL (token=)', /token=/],
]) {
  test(`RET-02: no doc mentions ${label}`, () => {
    for (const f of docs) assert.doesNotMatch(readFileSync(f, 'utf8'), re, f);
  });
}
