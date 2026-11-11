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
  insertAdjacentHTML(where, html) { this._html = where === 'afterbegin' ? String(html) + this._html : this._html + String(html); }
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
// The app opens from an old reader link, with that reader already stored from before (D-07a): neither may be used.
const EVIL = 'https://evil.example/api/read-sign';
globalThis.location = { search: `?reader=${encodeURIComponent(EVIL)}`, href: `https://dougalhanson.com/caniparkhere/?reader=${encodeURIComponent(EVIL)}` };
const store = new Map([['caniparkhere.readerUrl', EVIL]]);
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
let reportAnswer = null; // the next report's answer; null files it
const reports = [];
const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  fetched.push(u);
  if (u.startsWith('file:')) {
    try { return new Response(await readFile(new URL(u)), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('', { status: 404 }); }
  }
  if (u === READER && (init.method ?? 'GET') === 'GET') return jsonRes({ service: 'caniparkhere-reader', backend: 'site', readers: ['mac', 'cloudflare'] });
  if (u === READER && init.method === 'POST') return readAnswer();
  if (u === READER + '/reports' && init.method === 'POST') { reports.push(JSON.parse(init.body)); const a = reportAnswer; reportAnswer = null; return a ? a() : jsonRes({ saved: true, private: true }); }
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
  await until(() => !$('report-box').innerHTML.includes('Sending…'), 'the report box to show the answer');
  return reports.at(-1);
}

const quiet = console.warn; console.warn = () => {}; // preprocess() has no canvas here and says so
await import('../web/app.js');
await until(() => $('photo').listeners.change?.length, 'the app to start');

test('D-07a: a reader link is ignored and a stored reader is cleared on load', () => {
  assert.equal(fetched.filter(u => u.includes('evil.example')).length, 0, 'no request to the linked reader');
  assert.equal(store.has('caniparkhere.readerUrl'), false, 'nothing stored under caniparkhere.readerUrl');
  assert.ok(fetched.includes(READER), 'the page\'s own reader (window.CANIPARKHERE) is still used');
});

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
});

// ---------------------------------------------------------------- the site's limit answers (D-14)

// The Worker's 429 bodies, byte for byte (caniparkhere Phase 3, 03-02).
const DAILY_LIMIT = '{"error":"You\'ve used today\'s 30 photo reads, so this one\'s read on your phone. It\'s back to normal after midnight.","code":"daily-limit","limit":30}';
const SLOW_DOWN = '{"error":"That\'s a lot of photos at once. Reading this one on your phone.","code":"slow-down"}';
const limited = (body) => () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });
const banners = () => [...$('results').innerHTML.matchAll(/<div class="banner">([\s\S]*?)<\/div>/g)].map(m => m[1]);

async function limitedPhoto(answer, bytes) {
  readAnswer = answer;
  ocr = '2P 8AM-6PM MON-FRI';
  $('when').value = '2026-11-11T10:00'; // a Wednesday that is not a public holiday, so no holiday banner
  await takePhoto(bytes);
  assert.equal($('status-line').textContent, 'Photograph the sign. Get a straight answer.');
  assert.equal($('reader-mode').textContent, 'Read on this phone (words only, not symbols)');
  assert.match($('results').innerHTML, /class="verdict /, 'a verdict from the phone\'s own read');
  const b = banners();
  assert.equal(b.length, 1, 'exactly one banner');
  assert.ok(!b[0].includes('This phone read the words instead.'));
  return b[0];
}

test('D-14: a photo over today\'s cap shows the site\'s line alone and the phone reads it', async () => {
  assert.equal(await limitedPhoto(limited(DAILY_LIMIT), [0xff, 0xd8, 0x11]), JSON.parse(DAILY_LIMIT).error);
});

test('D-14: photos sent too fast show the slow-down line alone and the phone reads it', async () => {
  assert.equal(await limitedPhoto(limited(SLOW_DOWN), [0xff, 0xd8, 0x12]), JSON.parse(SLOW_DOWN).error);
});

test('D-14: an over-cap answer with no line and no number shows the app\'s no-number line', async () => {
  const line = await limitedPhoto(limited('{"code":"daily-limit"}'), [0xff, 0xd8, 0x13]);
  assert.equal(line, "You've used today's photo reads, so this one's read on your phone. It's back to normal after midnight.");
});

test('D-14: an over-cap answer with a number and no line shows the app\'s line with that number', async () => {
  const line = await limitedPhoto(limited('{"code":"daily-limit","limit":30}'), [0xff, 0xd8, 0x14]);
  assert.equal(line, "You've used today's 30 photo reads, so this one's read on your phone. It's back to normal after midnight.");
});

test('D-14: any other failed read keeps the two-sentence banner', async () => {
  readAnswer = () => jsonRes({ error: 'boom' }, 502);
  ocr = '2P 8AM-6PM MON-FRI';
  await takePhoto([0xff, 0xd8, 0x15]);
  assert.deepEqual(banners(), ["The vision readers couldn't answer. This phone read the words instead."]);
});

// ---------------------------------------------------------------- the site's report limits (D-13a)

const REPORT_LIMIT = '{"error":"You\'ve sent today\'s 10 reports, so this one wasn\'t sent. You can send more after midnight.","code":"report-limit","limit":10}';
const REPORT_SLOW_DOWN = '{"error":"That\'s a lot of reports at once. Wait a minute, then try again.","code":"slow-down"}';
const visionRead = async (id, bytes) => {
  readAnswer = () => jsonRes({ sign: parseSignText('2P 8AM-6PM MON-FRI'), backend: 'cloudflare', readId: id, model: 'm', seconds: 3 });
  await takePhoto(bytes);
};

test('D-13a: a report over today\'s cap shows the line alone, with no note field and no retry', async () => {
  await visionRead('8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', [0xff, 0xd8, 0x21]);
  const n = reports.length;
  reportAnswer = limited(REPORT_LIMIT);
  await tapReport();
  const box = $('report-box').innerHTML;
  assert.equal(box, `<p class="small">${JSON.parse(REPORT_LIMIT).error}</p>`);
  assert.ok(!box.includes('id="btn-report"') && !box.includes('id="report-note"'), 'no button and no note field');
  assert.equal($('btn-report'), null);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(reports.length, n + 1, 'exactly one POST, nothing sent again');
});

test('D-13a: a report over today\'s cap with no line uses the app\'s line and that number', async () => {
  await visionRead('9b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', [0xff, 0xd8, 0x22]);
  reportAnswer = limited('{"code":"report-limit","limit":10}');
  await tapReport();
  assert.equal($('report-box').innerHTML, '<p class="small">You\'ve sent today\'s 10 reports, so this one wasn\'t sent. You can send more after midnight.</p>');
});

test('D-13a: reports sent too fast show the throttle line and keep Try again', async () => {
  await visionRead('0c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', [0xff, 0xd8, 0x23]);
  reportAnswer = limited(REPORT_SLOW_DOWN);
  await tapReport();
  const box = $('report-box').innerHTML;
  assert.ok(box.startsWith(`<p class="small">${JSON.parse(REPORT_SLOW_DOWN).error}</p>`), box);
  assert.ok(!box.includes('Could not send the report:'));
  assert.match(box, /<button class="btn" id="btn-report">Try again<\/button>/);
  const r = await tapReport(); // Try again files it
  assert.equal(r.readId, '0c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f');
  assert.match($('report-box').innerHTML, /Reported privately\. Only Dougal sees it\./);
  console.warn = quiet;
});
