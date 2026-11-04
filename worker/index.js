// CanIparkhere Cloudflare Worker: static app (assets binding) + vision reader.
//   GET  /streetparking/            app (assets)
//   POST /streetparking/api/read-sign  { image: <base64>, mediaType, jurisdiction, council } → { sign }
//   GET  /streetparking/api/read-sign  { service, backend }   (the app uses this to auto-detect the reader)
// Both paths also work without the /streetparking prefix (workers.dev).
import { readSign, buildChatRequest, chatReplyText, extractJson, normaliseSign } from '../server/read-sign.js';

const MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_MODELS = {
  'local': 'local',
  'unified': 'anthropic/claude-opus-5.5',
  'workers-ai': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'gateway-sdk': 'claude-opus-5-5',
  'anthropic': 'claude-opus-5-5',
};

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map(s => s.trim()).filter(Boolean);
  const self = new URL(request.url).origin;
  const ok = !origin || origin === self || allowed.includes('*') || allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? (origin || '*') : (allowed[0] ?? self),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

const json = (data, status, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// Cache-API throttle: N requests per minute per IP. Fail-open if the Cache API is unavailable.
async function rateLimited(request, env) {
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const limit = Number(env.RATE_LIMIT_PER_MIN ?? 10);
    const minute = Math.floor(Date.now() / 60000);
    const key = new Request(`https://throttle.local/read/${encodeURIComponent(ip)}/${minute}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) : 0;
    if (count >= limit) return true;
    await cache.put(key, new Response(String(count + 1), { headers: { 'cache-control': 'max-age=60' } }));
    return false;
  } catch { return false; }
}

async function runReader(env, args) {
  const backend = (env.READER_BACKEND || 'unified').trim();
  const model = (env.READER_MODEL || '').trim() || DEFAULT_MODELS[backend];
  if (!model) throw new Error(`unknown READER_BACKEND "${backend}"`);

  if (backend === 'local') {
    // Forward to the reader running on Dougal's Mac (local-reader/server.py) through a Cloudflare tunnel.
    if (!env.LOCAL_READER_URL) throw new Error('local backend needs LOCAL_READER_URL (the tunnel address)');
    const target = new URL('/api/read-sign', env.LOCAL_READER_URL);
    const headers = { 'content-type': 'application/json' };
    if (env.LOCAL_READER_TOKEN) headers['x-reader-token'] = env.LOCAL_READER_TOKEN;
    const r = await fetch(target, { method: 'POST', headers, body: JSON.stringify({ image: args.imageBase64, mediaType: args.mediaType, jurisdiction: args.jurisdiction, council: args.council, async: true }) });
    let body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `local reader error (${r.status})`), { status: r.status, local: true });
    if (r.status === 202 && body.jobId) {
      const poll = new URL(`/api/read-sign/jobs/${body.jobId}`, env.LOCAL_READER_URL);
      const deadline = Date.now() + 4 * 60 * 1000;
      body = null;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 1500));
        const p = await fetch(poll, { headers });
        const j = await p.json().catch(() => ({}));
        if (!p.ok) throw Object.assign(new Error(j.error || `local reader lost the job (${p.status})`), { local: true });
        if (j.status === 'done') { body = j.result; break; }
        if (j.status === 'error') throw Object.assign(new Error(j.error || 'local reader failed'), { local: true });
      }
      if (!body) throw Object.assign(new Error('local reader took too long'), { local: true });
    }
    if (!body.sign) return { sign: null, error: body.error || 'local reader returned no sign', backend: 'local' };
    return { sign: normaliseSign(body.sign, args).sign, backend: 'local', model: body.model, ocrText: body.ocrText, seconds: body.seconds };
  }

  if (backend === 'unified' || backend === 'workers-ai') {
    if (!env.AI) throw new Error('AI binding missing: add [ai] binding = "AI" to wrangler.toml');
    const gateway = backend === 'unified' ? { gateway: { id: env.AIG_GATEWAY_ID || 'caniparkhere' } } : undefined;
    // First try with an OpenAI-style json_schema response_format; if the provider rejects it, ask for JSON in the prompt only.
    let resp;
    try { resp = await env.AI.run(model, buildChatRequest({ ...args, jsonSchema: true }), gateway); }
    catch (e) {
      if (!/response_format|json_schema|schema/i.test(String(e?.message))) throw e;
      resp = await env.AI.run(model, buildChatRequest({ ...args, jsonSchema: false }), gateway);
    }
    const out = normaliseSign(extractJson(chatReplyText(resp)), args);
    return { ...out, backend, model, usage: resp?.usage ?? null };
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (backend === 'gateway-sdk') {
    if (!env.CF_ACCOUNT_ID || !env.CF_AIG_TOKEN) throw new Error('gateway-sdk needs CF_ACCOUNT_ID (var) and CF_AIG_TOKEN (secret)');
    const client = new Anthropic({
      apiKey: 'unified-billing', // placeholder; the gateway supplies provider credentials
      baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AIG_GATEWAY_ID || 'caniparkhere'}/anthropic`,
      defaultHeaders: { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`, Authorization: null, 'x-api-key': null },
    });
    const out = await readSign({ ...args, client, model, fallbacks: false });
    return { ...out, backend };
  }
  if (backend === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('anthropic backend needs secret ANTHROPIC_API_KEY');
    const out = await readSign({ ...args, client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), model });
    return { ...out, backend };
  }
  throw new Error(`unknown READER_BACKEND "${backend}"`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/streetparking(?=\/|$)/, '') || '/';
    if (path === '/' && url.pathname === '/') return Response.redirect(new URL('/streetparking/', url).toString(), 302);
    if (path !== '/api/read-sign') return new Response('not found', { status: 404 });

    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ service: 'caniparkhere-reader', backend: env.READER_BACKEND || 'unified', model: (env.READER_MODEL || '') || DEFAULT_MODELS[env.READER_BACKEND || 'unified'] }, 200, cors);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'image too large' }, 413, cors);
    if (await rateLimited(request, env)) return json({ error: 'slow down — try again in a minute' }, 429, cors);

    const body = await request.json().catch(() => ({}));
    if (!body.image) return json({ error: 'image (base64) required' }, 400, cors);
    try {
      const out = await runReader(env, { imageBase64: body.image, mediaType: body.mediaType || 'image/jpeg', jurisdiction: body.jurisdiction || 'au-vic', council: body.council ?? null });
      return json(out, 200, cors);
    } catch (e) {
      console.error('read-sign:', e && e.stack ? e.stack : e);
      const msg = String(e?.message ?? 'reader failed');
      // Surface configuration problems plainly; hide upstream internals.
      const cfg = e?.local || /backend|binding|secret|CF_|gateway|credits|2044|unknown READER|LOCAL_READER/i.test(msg);
      return json({ error: cfg ? msg : (e?.status ? `reader upstream error (${e.status})` : 'reader failed') }, cfg ? 503 : 502, cors);
    }
  },
};
