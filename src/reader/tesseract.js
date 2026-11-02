// On-device OCR via tesseract.js (loaded lazily from a CDN in the browser). Free, private, no backend.
// Output quality on real signs is mediocre — always let the user edit the text before interpreting.
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
 * @param {Blob|string} image  File/Blob or data URL
 * @param {(status:string, progress:number)=>void} [onProgress]
 * @returns {Promise<{text:string, confidence:number}>}
 */
export async function readWithTesseract(image, onProgress) {
  const T = await loadTesseract();
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => onProgress?.(m.status, m.progress ?? 0),
  });
  try {
    // Signs are block capitals; restrict the character set to cut noise.
    await worker.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/-.:←→↔ ', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(image);
    return { text: data.text ?? '', confidence: (data.confidence ?? 0) / 100 };
  } finally {
    await worker.terminate();
  }
}
