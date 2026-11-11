import test from 'node:test';
import assert from 'node:assert/strict';
import { jobUrl, reportUrl, readWithClaude, sendReport, MAX_UNREACHABLE, LIMIT_CODES } from '../src/reader/claude.js';

test('job url keeps host, prefix and token', () => {
  assert.equal(jobUrl('https://mac.ts.net/streetparking/api/read-sign?token=abc', 'deadbeef0001'), 'https://mac.ts.net/streetparking/api/read-sign/jobs/deadbeef0001?token=abc');
  assert.equal(jobUrl('http://127.0.0.1:8765/api/read-sign', 'x'), 'http://127.0.0.1:8765/api/read-sign/jobs/x');
});

test('report url keeps host, prefix and token', () => {
  assert.equal(reportUrl('https://mac.ts.net/streetparking/api/read-sign?token=abc'), 'https://mac.ts.net/streetparking/api/read-sign/reports?token=abc');
});

// ---------------------------------------------------------------- stubbed fetch + FileReader

const READER = 'https://dougalhanson.com/caniparkhere/api/read-sign';
const SIGN = { rawText: '2P 8AM-6PM', panels: [{ rawText: '2P 8AM-6PM' }] };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let realFetch, realFileReader;

/** Node has no FileReader; give the client the one call it makes (readAsDataURL), only when missing. */
class TestFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.();
    }, (err) => { this.error = err; this.onerror?.(); });
  }
}

/**
 * Install a fetch stub. `posts` answers each POST in turn; `polls` answers each job poll in turn (the last one
 * repeats). Returns the list of calls, so a test can count POSTs and read their bodies.
 */
function stubFetch({ posts, polls = [] }) {
  const calls = [];
  let p = 0; let q = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body });
    if (method === 'POST') { const a = posts[Math.min(p++, posts.length - 1)]; return typeof a === 'function' ? a() : a; }
    const a = polls[Math.min(q++, polls.length - 1)];
    return typeof a === 'function' ? a() : a;
  };
  return calls;
}

test.beforeEach(() => {
  realFetch = globalThis.fetch;
  realFileReader = globalThis.FileReader;
  if (typeof globalThis.FileReader !== 'function') globalThis.FileReader = TestFileReader;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = realFileReader;
});

const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const fast = (extra = {}) => ({ readerUrl: READER, readerBackend: 'site', pollMs: 1, jobTimeoutMs: 2000, ...extra });
const queued = () => jsonRes({ jobId: 'deadbeef0001', status: 'queued' }, 202);
const posts = (calls) => calls.filter(c => c.method === 'POST');

test('A: a Mac job error marked fallback is sent again once through the site, skipping the Mac', async () => {
  const calls = stubFetch({
    posts: [queued, () => jsonRes({ sign: SIGN, backend: 'cloudflare', rough: true, readId: 'r-cf', seconds: 6 })],
    polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })],
  });
  const stages = [];
  const { sign, meta } = await readWithClaude(photo(), fast(), (s) => stages.push(s));
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[0].body.skip, undefined);
  assert.equal(posts(calls)[1].body.skip, 'mac');
  assert.equal(posts(calls)[1].body.image, posts(calls)[0].body.image);
  assert.equal(posts(calls)[1].body.async, true);
  assert.equal(sign.rawText, SIGN.rawText);
  assert.equal(meta.backend, 'cloudflare');
  assert.equal(meta.rough, true);
  assert.equal(meta.readId, 'r-cf');
  assert.ok(stages.includes("Your Mac didn't finish, trying Cloudflare"));
});

test('B: a direct Mac link never sends a second POST', async () => {
  const calls = stubFetch({ posts: [queued], polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })] });
  await assert.rejects(readWithClaude(photo(), fast({ readerBackend: 'local-mlx' })), /x/);
  assert.equal(posts(calls).length, 1);
});

test('C: a Mac job that finds no sign is an answer, not a fallback', async () => {
  const calls = stubFetch({
    posts: [queued],
    polls: [() => jsonRes({ status: 'done', result: { sign: null, error: 'No parking sign found in the photo.', backend: 'mac', readId: 'r-mac' } })],
  });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.message === 'No parking sign found in the photo.' && e.readId === 'r-mac');
  assert.equal(posts(calls).length, 1);
});

test('D: the deadline passing sends exactly one resend, skipping the Mac', async () => {
  const calls = stubFetch({
    posts: [queued, () => jsonRes({ sign: SIGN, backend: 'cloudflare', readId: 'r-cf' })],
    polls: [() => jsonRes({ status: 'running', stage: 'loading the model' })],
  });
  const { meta } = await readWithClaude(photo(), fast({ jobTimeoutMs: 60, pollMs: 5 }));
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[1].body.skip, 'mac');
  assert.equal(meta.backend, 'cloudflare');
  assert.equal(meta.rough, false);
});

test('E: while the Mac job runs the app keeps polling and never asks for Cloudflare', async () => {
  const calls = stubFetch({
    posts: [queued],
    polls: [
      () => jsonRes({ status: 'queued', stage: 'waiting for the model', queued_ahead: 1 }),
      () => jsonRes({ status: 'running', stage: 'reading the sign' }),
      () => jsonRes({ status: 'done', result: { sign: SIGN, backend: 'mac', readId: 'r-mac', seconds: 4 } }),
    ],
  });
  const stages = [];
  const { meta } = await readWithClaude(photo(), fast(), (s) => stages.push(s));
  assert.equal(posts(calls).length, 1);
  assert.equal(calls.filter(c => c.method === 'GET').length, 3);
  assert.ok(calls.filter(c => c.method === 'GET').every(c => c.url === READER + '/jobs/deadbeef0001'));
  assert.ok(stages.includes('waiting for the model (1 ahead of you)'));
  assert.ok(stages.includes('reading the sign'));
  assert.equal(meta.backend, 'mac');
  assert.equal(meta.seconds, 4);
});

test('F: a lost job (404 poll) through the site is sent again once', async () => {
  const calls = stubFetch({
    posts: [queued, () => jsonRes({ sign: SIGN, backend: 'cloudflare', readId: 'r-cf' })],
    polls: [() => jsonRes({ error: 'no such job' }, 404)],
  });
  const { meta } = await readWithClaude(photo(), fast());
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[1].body.skip, 'mac');
  assert.equal(meta.backend, 'cloudflare');
});

// WR-04: one failed poll never drops a Mac read (D-01); only a 4xx or MAX_UNREACHABLE failed polls in a row end it.
test('WR-04: a blip while the Mac works (throw, 502, the site saying unreachable) keeps waiting for the Mac', async () => {
  const calls = stubFetch({
    posts: [queued],
    polls: [
      () => { throw new TypeError('Load failed'); },
      () => jsonRes({ error: 'bad gateway' }, 502),
      () => jsonRes({ status: 'unreachable', stage: 'waiting for your Mac' }),
      () => jsonRes({ status: 'running', stage: 'reading the sign' }),
      () => { throw new TypeError('Load failed'); },
      () => jsonRes({ status: 'done', result: { sign: SIGN, backend: 'mac', readId: 'r-mac', seconds: 30 } }),
    ],
  });
  const { meta } = await readWithClaude(photo(), fast());
  assert.equal(posts(calls).length, 1, 'no resend: the Mac read is kept');
  assert.equal(meta.backend, 'mac');
  assert.equal(meta.readId, 'r-mac');
});

test('WR-04: MAX_UNREACHABLE failed polls in a row fall through once, skipping the Mac', async () => {
  assert.equal(MAX_UNREACHABLE, 4);
  const calls = stubFetch({
    posts: [queued, () => jsonRes({ sign: SIGN, backend: 'cloudflare', readId: 'r-cf' })],
    polls: [() => jsonRes({ status: 'unreachable', stage: 'waiting for your Mac' }), () => jsonRes({}, 503), () => { throw new TypeError('x'); }, () => jsonRes({ status: 'unreachable' })],
  });
  const { meta } = await readWithClaude(photo(), fast());
  assert.equal(calls.filter(c => c.method === 'GET').length, MAX_UNREACHABLE);
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[1].body.skip, 'mac');
  assert.equal(meta.backend, 'cloudflare');
});

test('WR-04: a direct Mac link that stops answering throws, with no second POST', async () => {
  const calls = stubFetch({ posts: [queued], polls: [() => { throw new TypeError('x'); }] });
  await assert.rejects(readWithClaude(photo(), fast({ readerBackend: 'local-mlx' })), /Reader stopped answering/);
  assert.equal(posts(calls).length, 1);
});

test('G: a resend that no reader can take throws, so the app reads on the phone', async () => {
  const calls = stubFetch({
    posts: [queued, () => jsonRes({ error: 'No vision reader is free right now.', reader: 'none' }, 503)],
    polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })],
  });
  await assert.rejects(readWithClaude(photo(), fast()), /Reader failed: 503/);
  assert.equal(posts(calls).length, 2);
});

// ---------------------------------------------------------------- the site's limit answers (D-14)

// The Worker's 429 bodies, byte for byte (caniparkhere Phase 3, 03-02).
const DAILY_LIMIT = '{"error":"You\'ve used today\'s 30 photo reads, so this one\'s read on your phone. It\'s back to normal after midnight.","code":"daily-limit","limit":30}';
const SLOW_DOWN = '{"error":"That\'s a lot of photos at once. Reading this one on your phone.","code":"slow-down"}';
const limited = (body) => () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });

test('L1: a photo over today\'s cap throws the site\'s line and number after one POST', async () => {
  assert.deepEqual(LIMIT_CODES, ['daily-limit', 'slow-down', 'report-limit']);
  const calls = stubFetch({ posts: [limited(DAILY_LIMIT)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === 'daily-limit' && e.line === JSON.parse(DAILY_LIMIT).error && e.limit === 30 && /^Reader failed: 429 /.test(e.message));
  assert.equal(posts(calls).length, 1);
});

test('L2: photos sent too fast throw the slow-down line with no number', async () => {
  const calls = stubFetch({ posts: [limited(SLOW_DOWN)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === 'slow-down' && e.line === JSON.parse(SLOW_DOWN).error && e.limit === null);
  assert.equal(posts(calls).length, 1);
});

test('L3: a resend skipping the Mac answered over the cap throws that code after two POSTs', async () => {
  const calls = stubFetch({ posts: [queued, limited(DAILY_LIMIT)], polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === 'daily-limit' && e.limit === 30);
  assert.equal(posts(calls).length, 2);
  assert.equal(posts(calls)[1].body.skip, 'mac');
});

test('L4: no reader free (503 none) still throws with no limit code; a bad limit or line is dropped', async () => {
  stubFetch({ posts: [() => jsonRes({ error: 'No vision reader is free right now.', reader: 'none' }, 503)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === undefined && e.line === undefined && /Reader failed: 503/.test(e.message));
  stubFetch({ posts: [() => jsonRes({ code: 'daily-limit', limit: -3, error: '' }, 429)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === 'daily-limit' && e.line === null && e.limit === null);
  stubFetch({ posts: [() => jsonRes({ code: 'daily-limit', limit: 30, error: 'x'.repeat(500) }, 429)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.line.length === 200);
  stubFetch({ posts: [() => jsonRes({ code: 'report-limit', limit: 10, error: 'y' }, 429)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.code === undefined); // not a photo limit
});

test('a job error without fallback throws as before, with no resend', async () => {
  const calls = stubFetch({ posts: [queued], polls: [() => jsonRes({ status: 'error', error: 'bad photo', readId: 'r1' })] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.message === 'bad photo' && e.readId === 'r1');
  assert.equal(posts(calls).length, 1);
});

test('a resend answered with a job is never polled', async () => {
  const calls = stubFetch({ posts: [queued, queued], polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })] });
  await assert.rejects(readWithClaude(photo(), fast()), /resend with a job/);
  assert.equal(posts(calls).length, 2);
  assert.equal(calls.filter(c => c.method === 'GET').length, 1);
});

// WR-07: a failed read names the reader that made it, so its report is filed under that reader, not 'on-device'.
test('WR-07: a no-sign answer carries its backend (the Mac through a job, Cloudflare on the resend)', async () => {
  stubFetch({ posts: [queued], polls: [() => jsonRes({ status: 'done', result: { sign: null, error: 'No parking sign found in the photo.', backend: 'mac', readId: '20261111-093015-a1b2c3' } })] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.backend === 'mac' && e.readId === '20261111-093015-a1b2c3');
  stubFetch({
    posts: [queued, () => jsonRes({ sign: null, error: "Cloudflare couldn't read the sign.", backend: 'cloudflare', readId: '3f2b8c1a-9d4e-4f6a-8b2c-1e5d7a9c0b3f' })],
    polls: [() => jsonRes({ status: 'error', error: 'x', fallback: true })],
  });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.backend === 'cloudflare' && e.readId === '3f2b8c1a-9d4e-4f6a-8b2c-1e5d7a9c0b3f');
});

test('WR-07: a Mac job error and a failed answer carry their backend; no read id means no backend', async () => {
  stubFetch({ posts: [queued], polls: [() => jsonRes({ status: 'error', error: 'bad photo', readId: 'r1' })] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.backend === 'mac' && e.readId === 'r1');
  stubFetch({ posts: [() => jsonRes({ error: 'boom', readId: 'r2', backend: 'local-mlx' }, 502)] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.backend === 'local-mlx' && e.readId === 'r2');
  stubFetch({ posts: [() => new Response('<html>bad gateway</html>', { status: 502 })] });
  await assert.rejects(readWithClaude(photo(), fast()), (e) => e.backend === null && e.readId === null);
});

test('WR-07: when every reader fails, the app keeps the error\'s backend, clears the old result and shows the report box', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  // The catch that runs when the vision read and the on-device read both failed (inside readPhoto).
  const start = app.indexOf("$('status-line').textContent = 'Reader unavailable.';");
  assert.ok(start > 0, 'the both-readers-fail branch is where the test expects it');
  const block = app.slice(start, app.indexOf('} finally', start));
  // Drop line comments, so a statement that ended up inside a comment no longer counts (CR-01: a `//` placed
  // mid-line once swallowed `lastResult = null; renderReport();` and the old prefix-only regex still passed).
  const live = block.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const steps = [
    'lastReader = e.readId ? { readId: e.readId, backend: e.backend ?? null, error: e.message } : null;',
    'lastResult = null;',
    'currentSign = null;', // WR-02: the previous photo's sign and arrows go too
    'sideOverrides = {};',
    'renderReport();',
  ];
  let at = 0;
  for (const s of steps) {
    const i = live.indexOf(s, at);
    assert.ok(i >= 0, `live code in the both-readers-fail branch runs: ${s}`);
    at = i + s.length;
  }
});

// ---------------------------------------------------------------- private reports

test('H: a non-Mac report carries the photo as base64 (no data: prefix) and what the reader saw', async () => {
  const calls = stubFetch({ posts: [() => jsonRes({ saved: true, private: true })] });
  const r = await sendReport(READER, { readId: 'r-dev', reader: 'on-device', note: 'n', app: {}, read: { raw: 'x' }, photo: photo() });
  assert.deepEqual(r, { saved: true, private: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, READER + '/reports');
  assert.equal(calls[0].method, 'POST');
  const b = calls[0].body;
  assert.equal(b.photo, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.ok(!b.photo.startsWith('data:'));
  assert.equal(b.readId, 'r-dev');
  assert.equal(b.reader, 'on-device');
  assert.equal(b.note, 'n');
  assert.deepEqual(b.app, {});
  assert.deepEqual(b.read, { raw: 'x' });
});

test('I: a Mac report carries no photo and no read', async () => {
  const calls = stubFetch({ posts: [() => jsonRes({ saved: true, private: true })] });
  await sendReport(READER, { readId: 'r-mac', reader: 'mac', note: '', app: null });
  const b = calls[0].body;
  assert.equal(b.reader, 'mac');
  assert.equal('photo' in b, false);
  assert.equal('read' in b, false);
});

test('J: a report the site refuses throws its error text', async () => {
  stubFetch({ posts: [() => jsonRes({ error: 'Photo too large.' }, 413)] });
  await assert.rejects(sendReport(READER, { readId: 'r', reader: 'cloudflare', photo: photo() }), /Photo too large\./);
});

// The Worker's report 429 bodies, byte for byte (caniparkhere Phase 3, 03-02).
const REPORT_LIMIT = '{"error":"You\'ve sent today\'s 10 reports, so this one wasn\'t sent. You can send more after midnight.","code":"report-limit","limit":10}';
const REPORT_SLOW_DOWN = '{"error":"That\'s a lot of reports at once. Wait a minute, then try again.","code":"slow-down"}';

test('L5: a report over today\'s cap throws the site\'s line with code report-limit and limit 10', async () => {
  const calls = stubFetch({ posts: [limited(REPORT_LIMIT)] });
  await assert.rejects(sendReport(READER, { readId: 'r', reader: 'cloudflare', photo: photo() }),
    (e) => e.code === 'report-limit' && e.limit === 10 && e.line === JSON.parse(REPORT_LIMIT).error && e.message === JSON.parse(REPORT_LIMIT).error);
  assert.equal(calls.length, 1);
});

test('L6: reports sent too fast throw the report throttle line with code slow-down', async () => {
  stubFetch({ posts: [limited(REPORT_SLOW_DOWN)] });
  await assert.rejects(sendReport(READER, { readId: 'r', reader: 'mac' }), (e) => e.code === 'slow-down' && e.limit === null && e.line === JSON.parse(REPORT_SLOW_DOWN).error);
  stubFetch({ posts: [() => jsonRes({ error: 'Photo too large.' }, 413)] });
  await assert.rejects(sendReport(READER, { readId: 'r', reader: 'mac' }), (e) => e.code === undefined && e.message === 'Photo too large.');
});
