import { parseSignText, interpret, VERDICT, time } from '../src/index.js';
import { readWithTesseract, readWithClaude, pickReader } from '../src/reader/index.js';
import { downscaleImage } from '../src/reader/claude.js';

const cfg = Object.assign({ readerUrl: null, council: 'melbourne', jurisdiction: 'au-vic' }, globalThis.CANIPARKHERE ?? {});
// Reader URL can be set without redeploying: ?reader=https://... (persisted) or ?reader=off (clear).
try {
  const q = new URLSearchParams(location.search).get('reader');
  if (q === 'off') localStorage.removeItem('caniparkhere.readerUrl');
  else if (q) localStorage.setItem('caniparkhere.readerUrl', q);
  cfg.readerUrl = localStorage.getItem('caniparkhere.readerUrl') || cfg.readerUrl;
} catch { /* storage unavailable */ }

/** When served by the Cloudflare Worker, ../api/read-sign exists next to the app. Probe it once. */
async function detectReader() {
  if (cfg.readerUrl) return;
  try {
    const url = new URL('../api/read-sign', location.href);
    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j.service === 'caniparkhere-reader') { cfg.readerUrl = url.toString(); cfg.readerBackend = j.backend; } }
  } catch { /* no reader here (e.g. GitHub Pages) */ }
}
const TZ = 'Australia/Melbourne';
const $ = (id) => document.getElementById(id);

const data = { rulesPack: null, holidays: null, councils: null };
let currentSign = null;        // last parsed/read sign
let sideOverrides = {};        // panelId -> side
let currentFile = null;

async function loadData() {
  const base = new URL('../rules/' + cfg.jurisdiction + '/', import.meta.url);
  const get = (f) => fetch(new URL(f, base)).then(r => r.ok ? r.json() : null);
  [data.rulesPack, data.holidays, data.councils] = await Promise.all([get('rules.json'), get('public-holidays.json'), get('councils.json')]);
  $('instrument-link').href = data.rulesPack.instrument.url;
  $('general-rules').innerHTML = data.rulesPack.rules.filter(r => r.appliesTo?.includes('general') && r.id !== 'sign-times-days' && r.id !== 'sign-likeness')
    .map(r => `<li><a href="${r.sources[0].url}" target="_blank" rel="noopener">r ${r.number}</a> — ${esc(r.plain)}</li>`).join('');
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function nowLocalInput() {
  const p = time.localParts(new Date(), TZ);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
function whenDate() {
  const v = $('when').value;
  if (!v) return new Date();
  const [d, t] = v.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mi] = t.split(':').map(Number);
  return time.fromLocal(y, m, dd, hh, mi, TZ);
}
function vehicle() {
  const permits = [];
  if ($('accessible').checked) permits.push('accessible_permit');
  const area = $('permit-area').value.trim().toUpperCase();
  if (area) permits.push(`resident_permit:${area}`);
  return { type: $('vehicle').value, permits };
}

function renderPanels(sign) {
  const list = $('panel-list'); list.innerHTML = '';
  for (const p of sign.panels) {
    const side = sideOverrides[p.id] ?? p.side;
    const el = document.createElement('div'); el.className = 'panel';
    const limit = p.limitMinutes ? ` · ${time.durationLabel(p.limitMinutes)}` : '';
    const wins = (p.windows ?? []).map(w => `${w.start ? time.minutesToLabel(time.hhmmToMinutes(w.start)) : 'midnight'}–${w.end ? time.minutesToLabel(time.hhmmToMinutes(w.end)) : 'midnight'}${w.days ? ' ' + w.days.map(d => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(',') : ' every day'}`).join(' / ') || 'at all times';
    el.innerHTML = `<div><div class="kind">${esc(p.kind.replace(/_/g, ' '))}${esc(limit)}${p.fee ? ' · fee' : ''}${p.towAway ? ' · tow away' : ''}</div>
      <div class="muted small">${esc(wins)}${(p.exceptions ?? []).length ? ' · except ' + esc(p.exceptions.map(e => e.text ?? e.type).join(', ')) : ''}</div>
      <div class="raw muted">${esc(p.rawText ?? '')}</div></div>
      <div class="side" role="group" aria-label="Which side of the post">
        ${['left', 'both', 'right'].map(s => `<button class="btn" data-pid="${p.id}" data-side="${s}" aria-pressed="${s === side}">${{ left: '←', both: '↔', right: '→' }[s]}</button>`).join('')}
      </div>`;
    list.appendChild(el);
  }
  list.querySelectorAll('button[data-side]').forEach(b => b.addEventListener('click', () => { sideOverrides[b.dataset.pid] = b.dataset.side; runInterpret(); }));
  $('panels').hidden = sign.panels.length === 0;
}

function fmtT(d) { return d ? time.formatDateTime(d, TZ) : ''; }

function renderResult(res) {
  const out = $('results'); out.hidden = false;
  const sides = Object.entries(res.sides);
  let html = '';
  if (res.holiday?.isHoliday) html += `<div class="banner">🎉 ${esc(res.holiday.name)} — public holiday. Signs that name days of the week don't apply today (rule 318(3)).${res.holiday.note ? ' ' + esc(res.holiday.note) : ''}</div>`;
  else if (res.holiday?.confidence === 'low') html += `<div class="banner">⚠️ ${esc(res.holiday.note ?? 'Public holiday data uncertain for this date.')}</div>`;
  html += `<div class="sides ${res.split ? 'split' : ''}">`;
  for (const [key, s] of sides) {
    const label = key === 'both' ? 'This side of the post' : key === 'left' ? '← Left of the sign' : 'Right of the sign →';
    const leave = s.leaveBy ? `<div class="leave">⏱ Leave by <strong>${esc(fmtT(s.leaveBy))}</strong> <span class="muted">(${esc(s.leaveByReason)})</span></div>` : (s.verdict === VERDICT.OK ? `<div class="leave">⏱ No restriction found in the next 2 days.</div>` : '');
    const tl = s.timeline.slice(0, 6).map(seg => `<div><span class="t">${esc(seg.from.getTime() === new Date(res.at).getTime() ? 'now' : fmtT(seg.from))}</span><span><span class="dot ${seg.verdict}"></span>${esc(seg.headline)}</span></div>`).join('');
    html += `<div class="verdict ${s.verdict}">
      <div class="side-label">${label}</div>
      <div class="big">${esc(s.headline)}</div>
      ${s.detail ? `<div class="small">${esc(s.detail)}</div>` : ''}
      ${leave}
      ${s.notes.length ? `<ul>${s.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <details class="timeline"><summary>What happens next</summary>${tl}</details>
    </div>`;
  }
  html += '</div>';
  const rules = res.rules;
  if (rules.length) html += `<div class="card rules"><strong>Rules applied</strong><ul>${rules.map(r => `<li><a href="${r.url}" target="_blank" rel="noopener">Rule ${esc(r.number)} — ${esc(r.title)}</a>: ${esc(r.plain)}</li>`).join('')}</ul>
    <div class="muted small">Source: ${esc(res.instrument?.title ?? '')} (${esc(res.instrument?.citation ?? '')})</div></div>`;
  out.innerHTML = html;
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyOverrides(sign) {
  return { ...sign, panels: sign.panels.map(p => sideOverrides[p.id] ? { ...p, side: sideOverrides[p.id] } : p) };
}

function runInterpret() {
  try {
    const text = $('sign-text').value;
    if (!currentSign || currentSign.rawText !== text) { currentSign = parseSignText(text, { jurisdiction: cfg.jurisdiction, council: $('council').value || null }); }
    const sign = applyOverrides({ ...currentSign, council: $('council').value || null });
    renderPanels(sign);
    if (!sign.panels.length) { $('results').hidden = false; $('results').innerHTML = '<div class="card err">Nothing recognisable yet — type or photograph the sign.</div>'; return; }
    const res = interpret(sign, { ...data, at: whenDate(), vehicle: vehicle(), council: sign.council, tz: TZ });
    renderResult(res);
    $('report-link').href = `https://github.com/dougal441/streetparking/issues/new?template=sign-report.yml&title=${encodeURIComponent('Sign misread: ' + text.split('\n')[0].slice(0, 40))}&sign-text=${encodeURIComponent(text)}`;
  } catch (e) {
    $('results').hidden = false; $('results').innerHTML = `<div class="card err">Something went wrong: ${esc(e.message)}</div>`;
    console.error(e);
  }
}

async function readPhoto() {
  if (!currentFile) return;
  const btn = $('btn-read'); btn.disabled = true; const prog = $('ocr-progress'); prog.hidden = false; prog.value = 0;
  try {
    const mode = pickReader(cfg);
    if (mode === 'claude') {
      btn.textContent = 'Reading (vision)…';
      const small = await downscaleImage(currentFile);
      const { sign } = await readWithClaude(small, { ...cfg, council: $('council').value || null });
      currentSign = { ...sign, rawText: sign.rawText ?? '' };
      sideOverrides = {};
      $('sign-text').value = sign.rawText ?? sign.panels.map(p => p.rawText).join('\n');
      // Vision output is already structured: bypass the text parser for this run.
      const res = interpret(applyOverrides({ ...currentSign, council: $('council').value || null }), { ...data, at: whenDate(), vehicle: vehicle(), tz: TZ });
      renderPanels(currentSign); renderResult(res);
    } else {
      btn.textContent = 'Reading (OCR)…';
      const { text, confidence } = await readWithTesseract(currentFile, (status, p) => { prog.value = status === 'recognizing text' ? p : 0.05; });
      $('sign-text').value = text.trim();
      currentSign = null; sideOverrides = {};
      runInterpret();
      const parsed = parseSignText(text);
      const weak = !parsed.panels.length || parsed.confidence < 0.5 || confidence < 0.5;
      if (weak) {
        $('results').hidden = false;
        $('results').insertAdjacentHTML('afterbegin', `<div class="banner">🔍 On-device OCR only read <em>${esc(text.trim().slice(0, 60) || 'nothing')}</em>. It reads printed words, not the red Ⓢ / Ⓟ symbols or arrows. Fix the text box above (e.g. <code>NO STOPPING &lt;-</code>) and tap <strong>Can I park here?</strong> — or enable the vision reader (see docs/DEPLOY.md).</div>`);
      }
    }
  } catch (e) {
    $('results').hidden = false; $('results').innerHTML = `<div class="card err">Could not read the photo: ${esc(e.message)}. Type the sign text instead.</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Read sign'; prog.hidden = true; }
}

function init() {
  $('when').value = nowLocalInput();
  $('now-note').textContent = `Times are Australia/Melbourne. Now: ${fmtT(new Date())}.`;
  $('reader-mode').textContent = pickReader(cfg) === 'claude' ? `vision reader on${cfg.readerBackend ? ' (' + cfg.readerBackend + ')' : ''}` : 'on-device OCR (edit the text if it misreads)';
  $('council').value = cfg.council ?? '';
  $('photo').addEventListener('change', (e) => {
    currentFile = e.target.files?.[0] ?? null;
    if (currentFile) { const img = $('preview'); img.src = URL.createObjectURL(currentFile); img.hidden = false; $('btn-read').disabled = false; }
  });
  $('btn-read').addEventListener('click', readPhoto);
  $('btn-interpret').addEventListener('click', () => { currentSign = null; sideOverrides = {}; runInterpret(); });
  $('btn-example').addEventListener('click', () => { $('sign-text').value = 'CLEARWAY 7-9AM MON-FRI TOW AWAY\n2P TICKET 9AM-6.30PM MON-FRI\n9AM-12.30PM SAT\nAREA 7 RESIDENT PERMIT EXCEPTED'; currentSign = null; sideOverrides = {}; runInterpret(); });
  for (const id of ['when', 'council', 'vehicle', 'accessible', 'permit-area']) $(id).addEventListener('change', () => { if (currentSign) runInterpret(); });
  $('sign-text').addEventListener('input', () => { currentSign = null; });
}

Promise.all([loadData(), detectReader()]).then(init).catch(e => { document.body.insertAdjacentHTML('afterbegin', `<p class="err">Failed to load rules: ${esc(e.message)}</p>`); });
