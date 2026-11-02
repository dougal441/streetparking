// On-device OCR via tesseract.js (loaded lazily from a CDN in the browser). Free, private, no backend.
//
// Honest limits: it reads printed words and numbers only. The red Ⓢ (no stopping) and Ⓟ (no parking)
// symbols, arrows and the wheelchair symbol are NOT text, so this reader can never produce them —
// the user must add them, or the vision reader (src/reader/claude.js) must be used.
// Before OCR we crop to the sign-coloured region (white panel with red/green ink), upscale and
// threshold, which turns "EE 1 / 1 NE SONS" noise into something usable on a typical photo.
const TESSERACT_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';

let loading = null;
async function loadTesseract() {
  if (globalThis.Tesseract) return globalThis.Tesseract;
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_CDN; s.async = true;
    s.onload = () => resolve(globalThis.Tesseract);
    s.onerror = () => reject(new Error('Could not load tesseract.js from CDN'));
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Find the sign by its ink: saturated red (prohibitions, arrows, zone headers) or green (permissive P).
 * The white panel is found by padding out from the ink's bounding box. Returns null when there is
 * too little ink to trust (then we OCR the whole frame).
 */
export function findSignBox(img, w, h) {
  const d = img.data;
  const cols = new Uint32Array(w), rows = new Uint32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      // Sign red is saturated (≈200,30,40); rust and brick (≈140,80,60) are not.
      const red = r > 140 && g < 95 && b < 95 && r > 1.8 * g;
      const green = g > 90 && g > 1.5 * r && g > b + 30;
      if (red || green) { cols[x]++; rows[y]++; total++; }
    }
  }
  if (total < w * h * 0.0005) return null;
  // Trim stray ink: keep columns/rows holding at least 8% of the ink's peak density.
  let peakC = 0, peakR = 0;
  for (let x = 0; x < w; x++) if (cols[x] > peakC) peakC = cols[x];
  for (let y = 0; y < h; y++) if (rows[y] > peakR) peakR = rows[y];
  const cut = (arr, len, thr) => { let a = 0, b = len - 1; while (a < len && arr[a] < thr) a++; while (b > a && arr[b] < thr) b--; return [a, b]; };
  const [x0, x1] = cut(cols, w, Math.max(3, peakC * 0.08));
  const [y0, y1] = cut(rows, h, Math.max(3, peakR * 0.08));
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 20 || bh < 20) return null;
  // Ink sits inside the white panel; pad 18% horizontally, 12% vertically to take in the panel edge.
  const px = Math.round(bw * 0.18), py = Math.round(bh * 0.12);
  const X = Math.max(0, x0 - px), Y = Math.max(0, y0 - py);
  return { x: X, y: Y, w: Math.min(w, x1 + px) - X, h: Math.min(h, y1 + py) - Y };
}

/** Otsu threshold over a grayscale array. */
export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let p = 0; p < gray.length; p++) hist[gray[p]]++;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128; const n = gray.length;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Crop to the sign, upscale so text is ≥ ~30px tall, grayscale + threshold. Returns { canvas, box, scale }. */
export async function preprocess(image) {
  const bmp = await createImageBitmap(image);
  const c0 = document.createElement('canvas'); c0.width = bmp.width; c0.height = bmp.height;
  const ctx0 = c0.getContext('2d', { willReadFrequently: true }); ctx0.drawImage(bmp, 0, 0);
  const box = findSignBox(ctx0.getImageData(0, 0, c0.width, c0.height), c0.width, c0.height) ?? { x: 0, y: 0, w: c0.width, h: c0.height };
  const scale = Math.min(4, Math.max(1, 1400 / box.w));
  const c = document.createElement('canvas'); c.width = Math.round(box.w * scale); c.height = Math.round(box.h * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c0, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height); const d = img.data;
  // "Darkness of ink": min(r,g,b) makes red and green ink both dark against the white panel.
  const gray = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = Math.min(d[i], d[i + 1], d[i + 2]);
  const thr = otsu(gray);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) { const v = gray[p] > thr ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, box, scale };
}

/**
 * @param {Blob|string} image  File/Blob or data URL
 * @param {(status:string, progress:number)=>void} [onProgress]
 * @returns {Promise<{text:string, confidence:number, preview?:HTMLCanvasElement}>}
 */
export async function readWithTesseract(image, onProgress) {
  const T = await loadTesseract();
  let source = image, preview;
  try { ({ canvas: source } = await preprocess(image)); preview = source; } catch (e) { console.warn('preprocess failed, using raw image', e); }
  const worker = await T.createWorker('eng', 1, { logger: (m) => onProgress?.(m.status, m.progress ?? 0) });
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/-.: ',
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6', // one uniform block of text; mode 4 and 11 read less on real signs
    });
    const { data } = await worker.recognize(source);
    const text = (data.text ?? '').split('\n')
      .map(l => l.replace(/[^0-9A-Z/.:\- ]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(l => /[A-Z0-9]{2,}/.test(l)).join('\n');
    return { text, confidence: (data.confidence ?? 0) / 100, preview };
  } finally {
    await worker.terminate();
  }
}
