// Minimal Node server: serves the web app for local dev and exposes POST /api/read-sign.
// Run: ANTHROPIC_API_KEY=... node server/index.js   (or `ant auth login` first)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 12 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

let readSign = null, client = null;
if (!process.env.CANIPARKHERE_NO_READER) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    ({ readSign } = await import('./read-sign.js'));
    client = new Anthropic();
  } catch (e) { console.warn('Vision reader disabled (npm install @anthropic-ai/sdk to enable):', e.message); readSign = null; }
}

function cors(res, origin) {
  const allowed = (process.env.CANIPARKHERE_ALLOWED_ORIGINS ?? '*').split(',').map(s => s.trim());
  res.setHeader('access-control-allow-origin', allowed.includes('*') || allowed.includes(origin) ? (origin ?? '*') : allowed[0]);
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
}

async function handleRead(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!readSign) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'vision reader not configured' })); }
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413); return res.end(); } chunks.push(c); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body.image) throw new Error('image (base64) required');
    const out = await readSign({ imageBase64: body.image, mediaType: body.mediaType, jurisdiction: body.jurisdiction, council: body.council, client, model: process.env.CANIPARKHERE_MODEL });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    console.error(e);
    res.writeHead(e.status ?? 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { location: '/web/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/read-sign')) return handleRead(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => console.log(`CanIparkhere dev server: http://localhost:${PORT}/  (reader ${readSign ? 'on' : 'off'})`));
