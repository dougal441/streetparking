// web/app.js run for real against a small stand-in DOM (no jsdom in this repo): what a "Reader got it wrong" report
// sends after a read that worked and after a photo every reader failed on (02-REVIEW WR-02, IN-01).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSignText } from '../src/index.js';

const READER = 'https://dougalhanson.com/caniparkhere/api/read-sign';
const ID_A = '3f2b8c1a-9d4e-4f6a-8b2c-1e5d7a9c0b3f';
const ID_B = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- a stand-in DOM, just what app.js touches

const elements = new Map();   // id -> element currently in the page
const gone = new Set();       // ids an innerHTML write took out of the page

class El {
  constructor(id = null) {
    Object.assign(this, { id, value: '', textContent: '', hidden: false, href: '', src: '', className: '', checked: false, files: null });
    this.listeners = {}; this.owned = []; this._html = '';
    this.classList = { add() {}, remove() {} };
    this.selectedOptions = [];
  }
  get innerHTML() { return this._html; }
  // Writing HTML replaces the elements it held: each id="..." in the new HTML is a fresh element (fresh listeners).
  set innerHTML(html) {
    this._html = String(html);
    for (const id of this.owned) { elements.delete(id); gone.add(id); }
    this.owned = [...this._html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    for (const id of this.owned) { elements.set(id, new El(id)); gone.delete(id); }
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ target: this }); }
  insertAdjacentHTML() {}
  appendChild() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

globalThis.document = {
  getElementById(id) {
    if (elements.has(id)) return elements.get(id);
    if (gone.has(id)) return null;
    const el = new El(id); elements.set(id, el); return el;
  },
  createElement: () => new El(),
  body: new El(), head: new El(),
};
globalThis.location = { search: '', href: 'https://dougalhanson.com/caniparkhere/' };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.CANIPARKHERE = { readerUrl: READER, geolocate: false };
globalThis.FileReader ??= class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => { this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`; this.onload?.(); },
      (err) => { this.error = err; this.onerror?.(); });
  }
};

// The phone's OCR: `ocr` is what it reads next, or null for an OCR that fails.
let ocr = null;
globalThis.Tesseract = {
  async createWorker() {
    if (ocr === null) throw new Error('on-device OCR failed');
    const text = ocr;
    return { setParameters: async () => {}, recognize: async () => ({ data: { text, confidence: 90 } }), terminate: async () => {} };
  },
};

// fetch: the rules packs from disk, the site's reader (`readAnswer` answers the next photo), and the reports API.
let readAnswer = null;
const reports = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('file:')) {
    try { return new Response(await readFile(new URL(u)), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('', { status: 404 }); }
  }
  if (u === READER && (init.method ?? 'GET') === 'GET') return jsonRes({ service: 'caniparkhere-reader', backend: 'site', readers: ['mac', 'cloudflare'] });
  if (u === READER && init.method === 'POST') return readAnswer();
  if (u === READER + '/reports' && init.method === 'POST') { reports.push(JSON.parse(init.body)); return jsonRes({ saved: true, private: true }); }
  return new Response('', { status: 404 });
};

async function until(cond, what) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
}

const $ = (id) => document.getElementById(id);
async function takePhoto(bytes) {
  $('photo').files = [new File([new Uint8Array(bytes)], 'sign.jpg', { type: 'image/jpeg' })];
  $('status-line').textContent = '';
  $('photo').fire('change');
  await until(() => /Photograph the sign|Reader unavailable/.test($('status-line').textContent), 'the read to finish');
}
async function tapReport() {
  const n = reports.length;
  assert.ok($('btn-report'), 'the report button is shown');
  $('btn-report').fire('click');
  await until(() => reports.length > n, 'the report to be sent');
  return reports.at(-1);
}

const quiet = console.warn; console.warn = () => {}; // preprocess() has no canvas here and says so
await import('../web/app.js');
await until(() => $('photo').listeners.change?.length, 'the app to start');

test('WR-02: a report on a vision read sends the reader\'s own sign', async () => {
  const sign = parseSignText('2P 8AM-6PM MON-FRI');
  readAnswer = () => jsonRes({ sign, backend: 'cloudflare', readId: ID_A, model: 'm', seconds: 3 });
  await takePhoto([0xff, 0xd8, 0x01]);
  const r = await tapReport();
  assert.equal(r.readId, ID_A);
  assert.equal(r.reader, 'cloudflare');
  assert.deepEqual(r.read.sign, JSON.parse(JSON.stringify(sign)));
  assert.ok(r.app.sign && r.app.verdicts, 'the app showed a sign and an answer');
});

test('WR-02: when every reader fails on the next photo, its report carries nothing from the previous one', async () => {
  readAnswer = () => jsonRes({ sign: null, error: "Cloudflare couldn't read the sign.", backend: 'cloudflare', readId: ID_B });
  ocr = null;
  await takePhoto([0xff, 0xd8, 0x02]);
  assert.equal($('status-line').textContent, 'Reader unavailable.');
  const r = await tapReport();
  assert.equal(r.readId, ID_B);              // the failed read's id, filed under the reader that made it (CR-01)
  assert.equal(r.reader, 'cloudflare');
  assert.equal(r.read.backend, 'cloudflare');
  assert.equal(r.read.sign, null);           // not the previous photo's sign
  assert.equal(r.app.sign, null);
  assert.deepEqual(r.app.sideOverrides, {});
  assert.equal(r.app.verdicts, null);
  assert.equal(r.photo, Buffer.from([0xff, 0xd8, 0x02]).toString('base64')); // this photo
});

test('WR-02: an on-device read after a failed vision read sends the sign the phone parsed', async () => {
  readAnswer = () => jsonRes({ error: 'boom' }, 502);
  ocr = '2P 8AM-6PM MON-FRI';
  await takePhoto([0xff, 0xd8, 0x03]);
  const r = await tapReport();
  assert.equal(r.reader, 'on-device');
  assert.equal(r.read.ocrText, '2P 8AM-6PM MON-FRI');
  assert.ok(r.read.sign?.panels?.length, 'the parsed sign goes with the report');
  assert.equal(r.read.sign.rawText, '2P 8AM-6PM MON-FRI');
  console.warn = quiet;
});
