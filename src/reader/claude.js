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
 * Tell the reader a read was wrong. The report is private: only Dougal can list and open it.
 * A Mac read is already in the Mac's own log, so it needs only the read id. A Cloudflare or on-device read was
 * never kept, so its first report brings the photo (`photo`, a Blob, sent as base64) and what the reader saw (`read`).
 * @returns {Promise<{saved:boolean, private?:boolean}>}
 */
export async function sendReport(readerUrl, { readId, note = '', app = null, reader, read, photo }) {
  const payload = { readId, reader, note, app };
  if (read !== undefined) payload.read = read;
  if (typeof Blob !== 'undefined' && photo instanceof Blob) payload.photo = (await blobToDataUrl(photo)).split(',')[1];
  const res = await fetch(reportUrl(readerUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `report failed (${res.status})`);
  return body;
}

/** An error carrying the read id and the reader that made it, so a report is filed under the right reader (WR-07). */
const failed = (message, readId, backend) => Object.assign(new Error(message), { readId: readId ?? null, backend: backend ?? null });

/** How long the phone waits on a Mac job once the Mac has taken it (D-02). `config.jobTimeoutMs` wins. */
export const JOB_TIMEOUT_MS = 3 * 60 * 1000;
/** How often the phone asks how the job is going. `config.pollMs` wins. */
export const POLL_MS = 1500;
/**
 * How many polls in a row may fail in a way that can pass (no network, a 5xx, the site's `unreachable` while the Mac
 * restarts) before the phone stops waiting: about 6 s at POLL_MS. One blip never drops a Mac read (D-01).
 * `config.maxUnreachable` wins.
 */
export const MAX_UNREACHABLE = 4;

/** A reader answer that is not OK becomes one error, with the read id when the body carries one. */
async function failedAnswer(res) {
  const text = await res.text().catch(() => '');
  let readId = null; let backend = null; try { ({ readId = null, backend = null } = JSON.parse(text) ?? {}); } catch { /* not JSON */ }
  return failed(`Reader failed: ${res.status} ${text}`, readId, backend);
}

/**
 * Poll a Mac job until it ends. Returns `{ result }` when the job is done (even with no sign: that is an answer),
 * or `{ fellThrough }` (a message, plus the read id) when the job errored with `fallback`, was lost (a 4xx poll), stopped
 * answering for MAX_UNREACHABLE polls in a row, or ran out of time.
 * A job error without `fallback` throws.
 */
async function pollJob(url, config, onProgress) {
  const deadline = Date.now() + (config.jobTimeoutMs ?? JOB_TIMEOUT_MS);
  const pollMs = config.pollMs ?? POLL_MS;
  const maxUnreachable = config.maxUnreachable ?? MAX_UNREACHABLE;
  let lastStage = '';
  let unreachable = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const r = await fetch(url, { cache: 'no-store' }).catch(() => null);
    // Only a 404 or another 4xx means the job is gone. A poll that failed in a way that can pass is counted instead.
    if (r && !r.ok && r.status < 500 && r.status !== 429) return { fellThrough: `Reader lost the job (${r.status})`, readId: null };
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j || j.status === 'unreachable') {
      if (++unreachable >= maxUnreachable) return { fellThrough: 'Reader stopped answering', readId: null };
      if (j?.stage && j.stage !== lastStage) { lastStage = j.stage; onProgress?.(j.stage); }
      continue;
    }
    unreachable = 0;
    if (j.stage && j.stage !== lastStage) { lastStage = j.stage; onProgress?.(j.stage + (j.queued_ahead ? ` (${j.queued_ahead} ahead of you)` : '')); }
    if (j.status === 'done') return { result: j.result ?? {} };
    if (j.status === 'error') {
      if (j.fallback === true) return { fellThrough: j.error ?? 'reader failed', readId: j.readId };
      throw failed(j.error ?? 'reader failed', j.readId, j.readId ? 'mac' : null); // only the Mac runs jobs
    }
  }
  return { fellThrough: 'Reader took too long (3 min). Is the Mac busy?', readId: null };
}

/**
 * @param {Blob} image
 * @param {{readerUrl:string, readerBackend?:string, council?:string|null, jurisdiction?:string, jobTimeoutMs?:number, pollMs?:number}} config
 * @param {(stage:string)=>void} [onProgress]
 * @returns {Promise<{sign:object, text:string, meta:object}>}
 */
export async function readWithClaude(image, config, onProgress) {
  const dataUrl = await blobToDataUrl(image);
  const [meta, data] = dataUrl.split(',');
  const mediaType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  const post = (extra = {}) => fetch(config.readerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: data, mediaType, jurisdiction: config.jurisdiction ?? 'au-vic', council: config.council ?? null, async: true, ...extra }),
  });
  onProgress?.('sending the photo');
  let res = await post();
  if (!res.ok) throw await failedAnswer(res);
  let body = await res.json();
  // Slow readers (a laptop loading a 5 GB model) answer 202 + a job id; poll until done. Phones give up on
  // a single request after ~60 s, so this is the only way a first photo gets through.
  if (res.status === 202 && body.jobId) {
    const job = await pollJob(jobUrl(config.readerUrl, body.jobId), config, onProgress);
    if (job.result) body = job.result;
    else if (config.readerBackend === 'site') {
      // Only the site can read without the Mac: it is sent the photo once more, told to skip the Mac (D-04).
      onProgress?.("Your Mac didn't finish, trying Cloudflare");
      res = await post({ skip: 'mac' });
      if (!res.ok) throw await failedAnswer(res);
      if (res.status === 202) throw failed('Reader answered the resend with a job');
      body = await res.json();
    } else {
      // A direct Mac link would only start a second Mac job, so it stops here.
      throw failed(job.fellThrough, job.readId, job.readId ? 'mac' : null);
    }
  }
  if (!body.sign) throw failed(body.error ?? 'Reader returned no sign', body.readId, body.backend);
  return { sign: body.sign, text: body.sign.rawText ?? '', meta: { readId: body.readId ?? null, backend: body.backend, model: body.model, seconds: body.seconds, ocrText: body.ocrText, raw: body.raw, sideFixes: body.sideFixes, rough: body.rough === true } };
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
