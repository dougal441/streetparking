// Pluggable sign readers: turn an image into either raw text (OCR) or a structured sign (vision model).
// The engine never depends on which reader produced the sign.
export { readWithTesseract } from './tesseract.js';
export { readWithClaude } from './claude.js';

/**
 * Pick a reader: a configured vision endpoint wins; otherwise on-device OCR.
 * @returns {'claude'|'tesseract'}
 */
export function pickReader(config = {}) {
  return config.readerUrl ? 'claude' : 'tesseract';
}
