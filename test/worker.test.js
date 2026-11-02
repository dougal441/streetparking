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
