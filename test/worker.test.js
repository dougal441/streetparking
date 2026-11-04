// Exercises the Worker's routing and backend plumbing with a fake AI binding (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const sample = { isParkingSign: true, rawText: 'NO STOPPING', confidence: 0.9, panels: [{ kind: 'no_stopping', side: 'both', limitMinutes: null, fee: false, area: false, towAway: false, windows: [], exceptions: [], rawText: 'NO STOPPING' }] };
const calls = [];
const env = {
  READER_BACKEND: 'unified', AIG_GATEWAY_ID: 'caniparkhere', ALLOWED_ORIGINS: 'https://dougal441.github.io',
  AI: { async run(model, req, opts) { calls.push({ model, req, opts }); return { response: '```json\n' + JSON.stringify(sample) + '\n```' }; } },
};
const post = (path, body, origin = 'https://dougal441.github.io') => worker.fetch(new Request('https://caniparkhere.x.workers.dev' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }), env);

test('GET /api/read-sign reports the backend (with and without /streetparking prefix)', async () => {
  for (const p of ['/api/read-sign', '/streetparking/api/read-sign']) {
    const r = await worker.fetch(new Request('https://caniparkhere.x.workers.dev' + p), env);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.service, 'caniparkhere-reader'); assert.equal(j.backend, 'unified'); assert.equal(j.model, 'anthropic/claude-opus-5.5');
  }
});

test('root redirects to /streetparking/', async () => {
  const r = await worker.fetch(new Request('https://caniparkhere.x.workers.dev/'), env);
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /\/streetparking\/$/);
});

test('POST runs the unified backend through the gateway and returns a normalised sign', async () => {
  const r = await post('/streetparking/api/read-sign', { image: 'AAAA', mediaType: 'image/jpeg', council: 'melbourne' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.sign.panels[0].kind, 'no_stopping'); assert.equal(j.sign.council, 'melbourne'); assert.equal(j.backend, 'unified');
  assert.equal(calls.at(-1).model, 'anthropic/claude-opus-5.5');
  assert.deepEqual(calls.at(-1).opts, { gateway: { id: 'caniparkhere' } });
  assert.equal(calls.at(-1).req.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://dougal441.github.io');
});

test('workers-ai backend skips the gateway and falls back when json_schema is rejected', async () => {
  let n = 0;
  const env2 = { ...env, READER_BACKEND: 'workers-ai', AI: { async run(model, req, opts) { n++; if (req.response_format) throw new Error('response_format not supported'); assert.equal(opts, undefined); assert.equal(model, '@cf/meta/llama-4-scout-17b-16e-instruct'); return { response: sample }; } } };
  const r = await worker.fetch(new Request('https://x/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'A' }) }), env2);
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(n, 2);
});

test('missing image and unknown backend are reported', async () => {
  assert.equal((await post('/api/read-sign', {})).status, 400);
  const r = await worker.fetch(new Request('https://x/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'A' }) }), { ...env, READER_BACKEND: 'nope' });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /unknown READER_BACKEND/);
});

test('disallowed origin gets a non-matching CORS header', async () => {
  const r = await post('/api/read-sign', { image: 'AAAA' }, 'https://evil.example');
  assert.notEqual(r.headers.get('access-control-allow-origin'), 'https://evil.example');
});

test('local backend forwards to the Mac reader with the token and normalises its answer', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify({ sign: { panels: [{ kind: 'no_stopping', side: 'left', windows: [] }] }, model: 'qwen', ocrText: 'NO STOPPING', seconds: 3.2 }), { status: 200 }); };
  try {
    const env3 = { ...env, READER_BACKEND: 'local', LOCAL_READER_URL: 'https://abc.trycloudflare.com', LOCAL_READER_TOKEN: 's3cret' };
    const r = await worker.fetch(new Request('https://x/streetparking/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'AAAA', council: 'melbourne' }) }), env3);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.backend, 'local'); assert.equal(j.sign.panels[0].id, 'p1'); assert.equal(j.sign.council, 'melbourne'); assert.equal(j.ocrText, 'NO STOPPING');
    assert.equal(seen[0].url, 'https://abc.trycloudflare.com/api/read-sign');
    assert.equal(seen[0].init.headers['x-reader-token'], 's3cret');
    assert.equal(JSON.parse(seen[0].init.body).image, 'AAAA');
    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    const r2 = await worker.fetch(new Request('https://x/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'A' }) }), env3);
    assert.equal(r2.status, 502);
    const r3 = await worker.fetch(new Request('https://x/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'A' }) }), { ...env, READER_BACKEND: 'local' });
    assert.equal(r3.status, 503); assert.match((await r3.json()).error, /LOCAL_READER_URL/);
  } finally { globalThis.fetch = realFetch; }
});

test('local backend polls a slow Mac reader until the job is done', async () => {
  const realFetch = globalThis.fetch; let n = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/read-sign')) return new Response(JSON.stringify({ jobId: 'abcdefabcdef', status: 'queued' }), { status: 202 });
    n++;
    if (n < 3) return new Response(JSON.stringify({ status: 'running', stage: 'loading the model' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'done', result: { sign: { panels: [{ kind: 'clearway', side: 'both', windows: [] }] }, model: 'qwen' } }), { status: 200 });
  };
  try {
    const env3 = { ...env, READER_BACKEND: 'local', LOCAL_READER_URL: 'https://mac.ts.net' };
    const r = await worker.fetch(new Request('https://x/api/read-sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'A' }) }), env3);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.sign.panels[0].kind, 'clearway'); assert.ok(n >= 3);
  } finally { globalThis.fetch = realFetch; }
});
