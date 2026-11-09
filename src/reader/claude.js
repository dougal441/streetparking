// Vision reader: sends the photo to a small proxy (server/index.js) which calls Claude and returns a
// structured sign (rules/schema/sign.schema.json). Handles split signs and arrows far better than OCR.
// The proxy holds the API key; the browser never sees it.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** /api/read-sign?token=x  →  /api/read-sign/jobs/<id>?token=x */
export function jobUrl(readerUrl, jobId) {
  const u = new URL(readerUrl);
  u.pathname = u.pathname.replace(/\/api\/read-sign\/?$/, `/api/read-sign/jobs/${jobId}`);
  return u.toString();
}

/** /api/read-sign?token=x  →  /api/read-sign/reports?token=x */
export function reportUrl(readerUrl) {
  const u = new URL(readerUrl);
  u.pathname = u.pathname.replace(/\/api\/read-sign\/?$/, '/api/read-sign/reports');
  return u.toString();
}

/**
 * Tell the reader a read was wrong. It keeps the photo and its full log and uploads them for study.
 * @returns {Promise<{saved:boolean, uploaded:boolean, uploadNote?:string}>}
 */
export async function sendReport(readerUrl, { readId, note = '', app = null }) {
  const res = await fetch(reportUrl(readerUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readId, note, app }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `report failed (${res.status})`);
  return body;
}

const failed = (message, readId) => Object.assign(new Error(message), { readId: readId ?? null });

/**
 * @param {Blob} image
 * @param {{readerUrl:string, council?:string|null, jurisdiction?:string}} config
 * @param {(stage:string)=>void} [onProgress]
 * @returns {Promise<{sign:object, text:string, meta:object}>}
 */
export async function readWithClaude(image, config, onProgress) {
  const dataUrl = await blobToDataUrl(image);
  const [meta, data] = dataUrl.split(',');
  const mediaType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  onProgress?.('sending the photo');
  const res = await fetch(config.readerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: data, mediaType, jurisdiction: config.jurisdiction ?? 'au-vic', council: config.council ?? null, async: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let readId = null; try { readId = JSON.parse(text).readId; } catch { /* not JSON */ }
    throw failed(`Reader failed: ${res.status} ${text}`, readId);
  }
  let body = await res.json();
  // Slow readers (a laptop loading a 5 GB model) answer 202 + a job id; poll until done. Phones give up on
  // a single request after ~60 s, so this is the only way a first photo gets through.
  if (res.status === 202 && body.jobId) {
    const url = jobUrl(config.readerUrl, body.jobId);
    const deadline = Date.now() + (config.jobTimeoutMs ?? 5 * 60 * 1000);
    let lastStage = '';
    while (Date.now() < deadline) {
      await sleep(1500);
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Reader lost the job (${r.status})`);
      const j = await r.json();
      if (j.stage && j.stage !== lastStage) { lastStage = j.stage; onProgress?.(j.stage + (j.queued_ahead ? ` (${j.queued_ahead} ahead of you)` : '')); }
      if (j.status === 'done') { body = j.result; break; }
      if (j.status === 'error') throw failed(j.error ?? 'reader failed', j.readId);
    }
    if (!body.sign && !body.error) throw new Error('Reader took too long (5 min). Is the Mac busy?');
  }
  if (!body.sign) throw failed(body.error ?? 'Reader returned no sign', body.readId);
  return { sign: body.sign, text: body.sign.rawText ?? '', meta: { readId: body.readId ?? null, backend: body.backend, model: body.model, seconds: body.seconds, ocrText: body.ocrText, raw: body.raw, sideFixes: body.sideFixes } };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Downscale large photos before upload (keeps requests small; signs are high-contrast). */
export async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  if (typeof createImageBitmap !== 'function') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  if (scale === 1) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(b => res(b ?? file), 'image/jpeg', quality));
}
