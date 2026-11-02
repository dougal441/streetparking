// CanIparkhere vision reader as a Cloudflare Worker.
// POST /api/read-sign  { image: <base64>, mediaType, jurisdiction, council }  →  { sign }
// The engine and parser never run here; this only turns a photo into the structured sign.
import Anthropic from '@anthropic-ai/sdk';
import { readSign } from '../server/read-sign.js';

const MAX_BODY = 8 * 1024 * 1024;

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? (origin || '*') : allowed[0],
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

const json = (data, status, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== '/api/read-sign') return json({ ok: true, service: 'caniparkhere-reader', use: 'POST /api/read-sign' }, 200, cors);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'reader not configured: set ANTHROPIC_API_KEY secret' }, 503, cors);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'image too large' }, 413, cors);
    if (await rateLimited(request, env)) return json({ error: 'slow down — try again in a minute' }, 429, cors);

    const body = await request.json().catch(() => ({}));
    if (!body.image) return json({ error: 'image (base64) required' }, 400, cors);
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const out = await readSign({ imageBase64: body.image, mediaType: body.mediaType, jurisdiction: body.jurisdiction, council: body.council, client });
      return json(out, 200, cors);
    } catch (e) {
      console.error('read-sign:', e && e.stack ? e.stack : e);
      return json({ error: e.status ? `reader upstream error (${e.status})` : 'reader failed' }, 502, cors);
    }
  },
};
