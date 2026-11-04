import { parseSignText, interpret, VERDICT, time } from '../src/index.js';
import { readWithTesseract, readWithClaude, pickReader } from '../src/reader/index.js';
import { downscaleImage } from '../src/reader/claude.js';

const cfg = Object.assign({ readerUrl: null, council: 'melbourne', jurisdiction: 'au-vic', geolocate: true }, globalThis.CANIPARKHERE ?? {});
// Reader URL can be set without redeploying: ?reader=https://... (persisted) or ?reader=off (clear).
try {
  const q = new URLSearchParams(location.search).get('reader');
  if (q === 'off') localStorage.removeItem('caniparkhere.readerUrl');
  else if (q) localStorage.setItem('caniparkhere.readerUrl', q);
  cfg.readerUrl = localStorage.getItem('caniparkhere.readerUrl') || cfg.readerUrl;
} catch { /* storage unavailable */ }

let TZ = 'Australia/Melbourne';
const $ = (id) => document.getElementById(id);
const data = { rulesPack: null, holidays: null, councils: null, penalties: null, jurisdiction: null, lgas: null, jurisdictions: null };
let lastReader = null;    // what the vision reader returned (raw text, OCR lines, side fixes)
let currentSign = null;   // last parsed/read sign
let sideOverrides = {};   // panelId -> side
let currentFile = null;
let councilSource = 'default';

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtT(d) { return d ? time.formatDateTime(d, TZ) : ''; }

// ---------------------------------------------------------------- data + reader + location
const rulesBase = new URL('../rules/', import.meta.url);
const getJson = (p) => fetch(new URL(p, rulesBase)).then(r => r.ok ? r.json() : null).catch(() => null);

/** Load one state's pack (rules, holidays, councils, penalties) and rebuild the council list for it. */
async function loadPack(id) {
  const [rulesPack, holidays, councils, penalties] = await Promise.all([getJson(`${id}/rules.json`), getJson(`${id}/public-holidays.json`), getJson(`${id}/councils.json`), getJson(`${id}/penalties.json`)]);
  if (!rulesPack) throw new Error(`no rules pack for ${id}`);
  Object.assign(data, { rulesPack, holidays: holidays ?? { holidays: [] }, councils: councils ?? { councils: {}, default: {} }, penalties, jurisdiction: id });
  TZ = rulesPack.timezone || TZ;
  $('instrument-link').href = rulesPack.instrument.url;
  $('general-rules').innerHTML = rulesPack.rules.filter(r => r.appliesTo?.includes('general') && r.id !== 'sign-times-days' && r.id !== 'sign-likeness')
    .map(r => `<li><a href="${r.sources[0].url}" target="_blank" rel="noopener">r ${esc(r.number)}</a> — ${esc(r.plain)}</li>`).join('');
  // Council list: this state's councils from the national ABS list.
  const names = councilNames(id);
  const sel = $('council');
  sel.innerHTML = Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([cid, name]) => `<option value="${cid}">${esc(name)}</option>`).join('') + '<option value="">Other / unsure</option>';
  $('state').value = id;
}

/** {id: display name} for one state: the pack's own names (with policies) plus the ABS list. */
function councilNames(jurisdiction) {
  const out = {};
  for (const l of data.lgas?.lgas ?? []) if (l.jurisdiction === jurisdiction) out[l.id] = l.name;
  for (const [cid, name] of Object.entries(data.councils?.names ?? {})) out[cid] = name;
  return out;
}

async function loadData() {
  [data.jurisdictions, data.lgas] = await Promise.all([getJson('au/jurisdictions.json'), getJson('au/lgas.json')]);
  const js = data.jurisdictions?.jurisdictions ?? { [cfg.jurisdiction]: { name: cfg.jurisdiction } };
  $('state').innerHTML = Object.entries(js).map(([id, j]) => `<option value="${id}">${esc(j.name)}${j.status === 'verified_primary' ? '' : ' (rules not yet verified)'}</option>`).join('');
  let start = cfg.jurisdiction;
  try { const saved = localStorage.getItem('caniparkhere.jurisdiction'); if (saved && js[saved]) start = saved; } catch { /* ignore */ }
  await loadPack(start);
  try { const saved = localStorage.getItem('caniparkhere.council'); if (saved !== null && (saved === '' || $('council').querySelector(`option[value="${saved}"]`))) { $('council').value = saved; councilSource = 'saved'; } else $('council').value = cfg.council ?? ''; } catch { $('council').value = cfg.council ?? ''; }
  if (!$('council').value && $('council').querySelector(`option[value="${cfg.council}"]`)) $('council').value = cfg.council;
}

/** When served by the Cloudflare Worker or the Mac reader, ../api/read-sign exists next to the app. */
async function detectReader() {
  if (cfg.readerUrl) {
    try { const r = await fetch(cfg.readerUrl, { cache: 'no-store' }); if (r.ok) cfg.readerBackend = (await r.json()).backend; } catch { cfg.readerDown = true; }
    return;
  }
  try {
    const url = new URL('../api/read-sign', location.href);
    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j.service === 'caniparkhere-reader') { cfg.readerUrl = url.toString(); cfg.readerBackend = j.backend; } }
  } catch { /* no reader here (e.g. GitHub Pages) */ }
}

const STRIP = /\b(city of|shire of|shire|city council|city|council|rural|borough of|borough)\b/gi;
const norm = (s) => String(s ?? '').toLowerCase().replace(STRIP, ' ').replace(/[^a-z]+/g, ' ').trim();
export function matchState(address, jurisdictions) {
  const st = norm(address?.state ?? '');
  for (const [id, j] of Object.entries(jurisdictions ?? {})) if (st && norm(j.state) === st) return id;
  return null;
}
export function matchCouncil(address, names) {
  const candidates = [address?.municipality, address?.city, address?.county, address?.city_district, address?.town, address?.state_district].filter(Boolean);
  for (const c of candidates) {
    const n = norm(c);
    if (!n) continue;
    for (const [id, name] of Object.entries(names)) if (norm(name) === n) return id;
  }
  for (const c of candidates) { const n = norm(c); for (const [id, name] of Object.entries(names)) if (n && (norm(name).includes(n) || n.includes(norm(name)))) return id; }
  return null;
}

async function locate(manual = false) {
  const note = $('locate-note');
  if (!navigator.geolocation) { note.textContent = 'No location on this device.'; return; }
  note.textContent = 'Finding your council…';
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }));
    const { latitude: lat, longitude: lon } = pos.coords;
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { headers: { accept: 'application/json' } });
    const j = await r.json();
    const stateId = matchState(j.address ?? {}, data.jurisdictions?.jurisdictions);
    if (stateId && stateId !== data.jurisdiction) { await loadPack(stateId); try { localStorage.setItem('caniparkhere.jurisdiction', stateId); } catch { /* ignore */ } }
    const names = councilNames(data.jurisdiction);
    const id = matchCouncil(j.address ?? {}, names);
    const label = j.address?.municipality || j.address?.city || j.address?.county || 'unknown area';
    const stateName = data.jurisdictions?.jurisdictions?.[data.jurisdiction]?.name ?? '';
    if (id) { $('council').value = id; councilSource = 'location'; note.textContent = `📍 ${names[id]}, ${stateName} (from your location)`; try { localStorage.setItem('caniparkhere.council', id); } catch { /* ignore */ } }
    else { $('council').value = ''; councilSource = 'location'; note.textContent = `📍 ${label}, ${stateName} — council not matched; using state rules.`; }
    if (currentSign) runInterpret();
  } catch (e) {
    note.textContent = manual ? `Could not get location (${e.message || e.code || 'denied'}).` : '';
  }
}

// ---------------------------------------------------------------- inputs
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
function applyOverrides(sign) {
  return { ...sign, panels: sign.panels.map(p => sideOverrides[p.id] ? { ...p, side: sideOverrides[p.id] } : p) };
}

// ---------------------------------------------------------------- rendering
function renderPanels(sign) {
  const list = $('panel-list'); list.innerHTML = '';
  if (!sign.panels.length) { list.innerHTML = '<p class="muted small">Nothing recognisable yet.</p>'; return; }
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
}

function dayStrip(s, at) {
  // 24 hours from now as a coloured strip, plus the schedule underneath.
  const start = new Date(at).getTime(), end = start + 24 * 3600 * 1000;
  const segs = s.timeline.filter(seg => (seg.to ? seg.to.getTime() : Infinity) > start && seg.from.getTime() < end);
  const bar = segs.map(seg => { const a = Math.max(seg.from.getTime(), start), b = Math.min(seg.to ? seg.to.getTime() : end, end); return `<span class="${seg.verdict}" style="width:${((b - a) / (end - start) * 100).toFixed(1)}%" title="${esc(seg.headline)}"></span>`; }).join('');
  const rows = segs.slice(0, 8).map(seg => `<div><span class="t">${esc(seg.from.getTime() <= start ? 'now' : fmtT(seg.from).replace(/^\w+, /, ''))}</span><span><span class="dot ${seg.verdict}"></span>${esc(seg.headline)}</span></div>`).join('');
  const nowP = time.localParts(new Date(at), TZ);
  return `<div class="strip">${bar}</div><div class="strip-labels"><span>now (${esc(time.minutesToLabel(nowP.minutesOfDay))})</span><span>+12h</span><span>+24h</span></div><details class="sched"><summary>Full schedule</summary>${rows}</details>`;
}

function fineHtml(s) {
  const f = s.fine;
  if (!f) {
    if (!data.penalties && s.verdict !== 'unknown' && s.verdict !== 'ok') return `<div class="fine soft"><span class="lbl">fine amount not loaded for this state yet</span></div>`;
    return '';
  }
  const soft = s.verdict === VERDICT.OK;
  const label = s.verdict === VERDICT.OK ? (f.key === 'fee' ? 'fine if you don\'t pay' : 'fine if you overstay') : s.verdict === VERDICT.STOP_ONLY ? 'fine if you park' : 'fine if you stop here';
  const extra = s.feeFine ? ` · +$${s.feeFine.amount} if you don't pay` : '';
  return `<div class="fine ${soft ? 'soft' : ''}"><span class="amt">$${f.amount}${f.approx ? '' : ''}</span><span class="lbl">${esc(label)}</span><span class="why">${esc(f.summary)} (code ${esc(f.code)}, ${f.units} × $${f.unitValue})${esc(extra)}${f.note ? ' · ' + esc(f.note) : ''}</span></div>`;
}

function renderResult(res) {
  const out = $('results'); out.hidden = false;
  const sides = Object.entries(res.sides);
  let html = '';
  if (res.holiday?.isHoliday) html += `<div class="banner">🎉 ${esc(res.holiday.name)} — public holiday. Signs that name days of the week don't apply today (rule 318(3)).${res.holiday.note ? ' ' + esc(res.holiday.note) : ''}</div>`;
  else if (res.holiday?.confidence === 'low') html += `<div class="banner">⚠️ ${esc(res.holiday.note ?? 'Public holiday data uncertain for this date.')}</div>`;
  html += `<div class="signboard ${res.split ? 'split' : ''}">`;
  for (const [key, s] of sides) {
    const arrow = key === 'left' ? '←' : key === 'right' ? '→' : '↔';
    const label = key === 'both' ? 'this side of the post' : key === 'left' ? 'left of the sign' : 'right of the sign';
    const leave = s.leaveBy ? `<div class="leave">⏱ Leave by <strong>${esc(fmtT(s.leaveBy))}</strong><br><span class="muted small">${esc(s.leaveByReason)}</span></div>` : (s.verdict === VERDICT.OK ? `<div class="leave">⏱ No restriction found in the next 2 days.</div>` : '');
    html += `<div class="verdict ${s.verdict} ${key}">
      <span class="arrow">${arrow}</span>
      <div class="side-label">${label}</div>
      <div class="big">${esc(s.headline)}</div>
      ${s.detail ? `<div class="small">${esc(s.detail)}</div>` : ''}
      ${leave}
      ${fineHtml(s)}
      ${s.plan?.length ? `<ul class="plan">${s.plan.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${s.notes.length ? `<ul>${s.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${s.verdict !== 'unknown' ? dayStrip(s, res.at) : ''}
    </div>`;
  }
  html += '</div>';
  const councilName = res.council ? (councilNames(data.jurisdiction)[res.council] ?? res.council) : 'council unknown';
  const jur = data.jurisdictions?.jurisdictions?.[data.jurisdiction];
  html += `<p class="meta">${esc(councilName)}, ${esc(jur?.name ?? data.jurisdiction)}${councilSource === 'location' ? ' (from your location)' : ''} · ${esc(fmtT(new Date(res.at)))} · ${esc($('vehicle').selectedOptions[0]?.textContent ?? '')}${jur && jur.status !== 'verified_primary' ? ' · <strong>rules for this state not yet verified against its legislation</strong>' : ''}</p>`;
  out.innerHTML = html;
  $('rules-applied').innerHTML = res.rules.length ? `<ul>${res.rules.map(r => `<li><a href="${r.url}" target="_blank" rel="noopener">Rule ${esc(r.number)} — ${esc(r.title)}</a>: ${esc(r.plain)}</li>`).join('')}</ul><div class="muted small">Source: ${esc(res.instrument?.title ?? '')} (${esc(res.instrument?.citation ?? '')})</div>` : '<p class="muted small">None yet.</p>';
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReaderSaid(sign, meta) {
  const parts = [];
  if (meta?.backend) parts.push(`<div>Reader: <strong>${esc(meta.backend)}</strong>${meta.model ? ' · ' + esc(meta.model) : ''}${meta.seconds ? ' · ' + meta.seconds + 's' : ''}</div>`);
  if (meta?.sideFixes?.length) parts.push(`<div>Side corrections from word positions: ${esc(meta.sideFixes.join('; '))}</div>`);
  if (meta?.ocrText) parts.push(`<div>Apple Vision read:</div><pre class="raw">${esc(meta.ocrText)}</pre>`);
  if (meta?.raw) parts.push(`<div>Model output:</div><pre class="raw">${esc(meta.raw)}</pre>`);
  $('reader-said').innerHTML = parts.join('') || 'Nothing yet.';
}

function showError(msg) { $('results').hidden = false; $('results').innerHTML = `<div class="card err">${esc(msg)}</div>`; }

// ---------------------------------------------------------------- flow
function runInterpret(signOverride) {
  try {
    const text = $('sign-text').value;
    if (signOverride) currentSign = signOverride;
    else if (!currentSign || currentSign.rawText !== text) currentSign = parseSignText(text, { jurisdiction: cfg.jurisdiction, council: $('council').value || null });
    const council = $('council').value || null;
    const sign = applyOverrides({ ...currentSign, council });
    renderPanels(sign);
    if (!sign.panels.length) { showError('Nothing recognisable yet — photograph the sign, or open "Show my working" and type it.'); return; }
    const res = interpret(sign, { ...data, at: whenDate(), vehicle: vehicle(), council, tz: TZ });
    renderResult(res);
    $('report-link').href = `https://github.com/dougal441/streetparking/issues/new?template=sign-report.yml&title=${encodeURIComponent('Sign misread: ' + (text.split('\n')[0] || '').slice(0, 40))}&sign-text=${encodeURIComponent(text)}`;
  } catch (e) { showError('Something went wrong: ' + e.message); console.error(e); }
}

async function readPhoto() {
  if (!currentFile) return;
  const btn = $('photo-btn'); const prog = $('ocr-progress'); prog.hidden = false; prog.value = 0;
  btn.classList.add('busy');
  try {
    const mode = pickReader(cfg);
    if (mode === 'claude') {
      $('status-line').textContent = 'Reading the sign…';
      const small = await downscaleImage(currentFile);
      const t0 = Date.now();
      const { sign, meta } = await readWithClaude(small, { ...cfg, council: $('council').value || null, jurisdiction: data.jurisdiction }, (stage) => { $('status-line').textContent = `${stage}… ${Math.round((Date.now() - t0) / 1000)}s`; });
      if (meta?.seconds) $('reader-mode').textContent = `vision reader on (${meta.backend ?? ''}) · last read ${meta.seconds}s`;
      lastReader = meta; renderReaderSaid(sign, meta);
      sideOverrides = {};
      $('sign-text').value = sign.rawText ?? sign.panels.map(p => p.rawText).join('\n');
      runInterpret({ ...sign, rawText: $('sign-text').value });
    } else {
      $('status-line').textContent = 'Reading the sign (on-device OCR)…';
      const { text, confidence } = await readWithTesseract(currentFile, (status, p) => { prog.value = status === 'recognizing text' ? p : 0.05; });
      $('sign-text').value = text.trim();
      currentSign = null; sideOverrides = {};
      runInterpret();
      const parsed = parseSignText(text);
      if (!parsed.panels.length || parsed.confidence < 0.5 || confidence < 0.5) {
        $('results').hidden = false;
        $('results').insertAdjacentHTML('afterbegin', `<div class="banner">🔍 On-device OCR only read <em>${esc(text.trim().slice(0, 60) || 'nothing')}</em>. It reads printed words, not the red Ⓢ / Ⓟ symbols or arrows. Open <strong>Show my working</strong>, fix the sign text (e.g. <code>NO STOPPING &lt;-</code>) and tap <strong>Can I park here?</strong> — or turn on the vision reader (docs/DEPLOY.md).</div>`);
      }
    }
    $('status-line').textContent = 'Photograph the sign. Get a straight answer.';
  } catch (e) {
    showError(`Could not read the photo: ${e.message}. ${cfg.readerUrl ? 'Is the reader (your Mac) awake? ' : ''}Open "Show my working" and type the sign instead.`);
    $('status-line').textContent = 'Reader unavailable.';
  } finally { btn.classList.remove('busy'); prog.hidden = true; }
}

function init() {
  $('when').value = nowLocalInput();
  $('now-note').textContent = `Times are Australia/Melbourne. Now: ${fmtT(new Date())}.`;
  const modeLine = pickReader(cfg) === 'claude' ? `vision reader on${cfg.readerBackend ? ' (' + cfg.readerBackend + ')' : ''}${cfg.readerDown ? ' — not answering right now' : ''}` : 'on-device OCR only (words, not symbols) — a vision reader is much better';
  $('reader-mode').textContent = modeLine;
  $('photo').addEventListener('change', (e) => {
    currentFile = e.target.files?.[0] ?? null;
    if (currentFile) { const img = $('preview'); img.src = URL.createObjectURL(currentFile); img.hidden = false; readPhoto(); }
  });
  $('btn-interpret').addEventListener('click', () => { currentSign = null; sideOverrides = {}; runInterpret(); });
  $('btn-example').addEventListener('click', () => { $('sign-text').value = 'CLEARWAY 7-9AM MON-FRI TOW AWAY\n2P TICKET 9AM-6.30PM MON-FRI\n9AM-12.30PM SAT\nAREA 7 RESIDENT PERMIT EXCEPTED'; currentSign = null; sideOverrides = {}; runInterpret(); });
  $('btn-locate').addEventListener('click', () => locate(true));
  for (const id of ['when', 'vehicle', 'accessible', 'permit-area']) $(id).addEventListener('change', () => { if (currentSign) runInterpret(); });
  $('council').addEventListener('change', () => { councilSource = 'manual'; try { localStorage.setItem('caniparkhere.council', $('council').value); } catch { /* ignore */ } if (currentSign) runInterpret(); });
  $('state').addEventListener('change', async () => { await loadPack($('state').value); $('council').value = ''; councilSource = 'manual'; try { localStorage.setItem('caniparkhere.jurisdiction', $('state').value); localStorage.setItem('caniparkhere.council', ''); } catch { /* ignore */ } $('now-note').textContent = `Times are ${data.rulesPack.timezone}. Now: ${fmtT(new Date())}.`; if (currentSign) runInterpret(); });
  $('sign-text').addEventListener('input', () => { currentSign = null; });
  if (cfg.geolocate && councilSource !== 'saved') locate(false);
}

Promise.all([loadData(), detectReader()]).then(init).catch(e => { document.body.insertAdjacentHTML('afterbegin', `<p class="err">Failed to load rules: ${esc(e.message)}</p>`); });
