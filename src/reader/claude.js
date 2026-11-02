// Vision reader: sends the photo to a small proxy (server/index.js) which calls Claude and returns a
// structured sign (rules/schema/sign.schema.json). Handles split signs and arrows far better than OCR.
// The proxy holds the API key; the browser never sees it.

/**
 * @param {Blob} image
 * @param {{readerUrl:string, council?:string|null, jurisdiction?:string}} config
 * @returns {Promise<{sign:object, text:string}>}
 */
export async function readWithClaude(image, config) {
  const dataUrl = await blobToDataUrl(image);
  const [meta, data] = dataUrl.split(',');
  const mediaType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/jpeg';
  const res = await fetch(config.readerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: data, mediaType, jurisdiction: config.jurisdiction ?? 'au-vic', council: config.council ?? null }),
  });
  if (!res.ok) throw new Error(`Reader failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = await res.json();
  if (!body.sign) throw new Error(body.error ?? 'Reader returned no sign');
  return { sign: body.sign, text: body.sign.rawText ?? '' };
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
