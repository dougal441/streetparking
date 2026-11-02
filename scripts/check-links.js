// Check every source URL in the rules packs resolves. Run: npm run check-links
// Some government sites block bots (403) — those are reported as warnings, not failures.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const urls = new Map();
const packs = (await readdir('rules', { withFileTypes: true })).filter(d => d.isDirectory() && d.name !== 'schema').map(d => d.name);
for (const id of packs) {
  for (const f of ['rules.json', 'councils.json', 'public-holidays.json', 'sign-vocabulary.json']) {
    try {
      const txt = await readFile(path.join('rules', id, f), 'utf8');
      for (const m of txt.matchAll(/"(https:\/\/[^"]+)"/g)) urls.set(m[1], (urls.get(m[1]) ?? new Set()).add(`${id}/${f}`));
    } catch { /* optional file */ }
  }
}
let bad = 0;
for (const [url, where] of urls) {
  let status;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 CanIparkhere-link-check' } });
    if (res.status === 405 || res.status === 403) res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 CanIparkhere-link-check' } });
    clearTimeout(t); status = res.status;
  } catch (e) { status = `ERR ${e.cause?.code ?? e.name}`; }
  const ok = typeof status === 'number' && status < 400;
  const warn = status === 403 || status === 429;
  if (!ok && !warn) bad++;
  console.log(`${ok ? 'OK ' : warn ? 'WARN' : 'BAD'} ${status}  ${url}  [${[...where].join(', ')}]`);
}
console.log(`\n${urls.size} urls, ${bad} broken`);
process.exit(bad ? 1 : 0);
