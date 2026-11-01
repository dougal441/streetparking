// Text → structured sign. Accepts OCR output or hand-typed sign text, one panel per block.
// Robust to the usual OCR noise (I/l for 1, stray punctuation, missing spaces).
//
// Conventions for hand-typed input:
//   NO STOPPING 7-9AM MON-FRI
//   2P TICKET 9AM-6PM MON-SAT ->
//   LEFT: / RIGHT:   (section markers for split signs; arrows <- -> <-> also work)

const DAY_INDEX = { MON: 1, TUE: 2, TUES: 2, WED: 3, THU: 4, THUR: 4, THURS: 4, FRI: 5, SAT: 6, SUN: 7 };
const DAY_RE = '(MON|TUES?|WED|THURS?|THU|FRI|SAT|SUN)(?:DAYS?)?';
const TIME_TOK = '(?:(\\d{1,2})(?:[.:](\\d{2}))?\\s*(AM|PM|A\\.M\\.|P\\.M\\.)?|(MIDNIGHT|NOON|MIDDAY))';
const TIME_RANGE_RE = new RegExp(`(?<![\\d/])${TIME_TOK}\\s*(?:-|–|—|TO)\\s*${TIME_TOK}(?![\\d/])`, 'g');

const KIND_PATTERNS = [
  ['no_stopping', /\bNO\s*(STOPPING|STANDING)\b/],
  ['no_parking', /\bNO\s*PARKING\b/],
  ['clearway', /\bCLEAR\s*WAY\b/],
  ['loading_zone', /\bLOADING\s*ZONE\b/],
  ['truck_zone', /\bTRUCK\s*ZONE\b/],
  ['works_zone', /\bWORKS?\s*ZONE\b/],
  ['taxi_zone', /\bTAXI\s*ZONE\b/],
  ['minibus_zone', /\bMINI\s*BUS\s*ZONE\b/],
  ['bus_zone', /\bBUS\s*ZONE\b/],
  ['mail_zone', /\bMAIL\s*ZONE\b/],
  ['permit_zone', /\bPERMIT\s*ZONE\b/],
  ['disabled', /\b(DISABLED|ACCESSIBLE|DISABILITY)\b|♿/],
  ['motorbike', /\bMOTOR\s*(BIKE|CYCLE)S?\b/],
  ['car_share', /\bCAR\s*SHARE\b/],
  ['ev_charging', /\b(ELECTRIC\s*VEHICLE|EV)\b.*\bCHARG/],
  ['bicycle', /\bBICYCLES?\s*(ONLY|PARKING)\b/],
];
const LIMIT_P_RE = /(?:^|[^A-Z0-9])((?:\d{1,2})|1\/2|1\/4|½|¼)\s*P(?![A-Z])/;
const LIMIT_MIN_RE = /(?:^|[^A-Z0-9])P?\s*(\d{1,3})\s*MIN(?:UTE)?S?\b/;
const BARE_P_RE = /(?:^|[^A-Z0-9])P(?![A-Z0-9])/;
const ZONE_WITH_LIMIT = new Set(['disabled', 'motorbike', 'loading_zone', 'ev_charging', 'car_share', 'permit_zone', 'bicycle']);

export function normaliseText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/<\s*-\s*>|<=>|⟷|⇔/g, ' ↔ ')
    .replace(/<\s*-+|⇐|◄|◀|<=/g, ' ← ')
    .replace(/-+\s*>|⇒|►|▶|=>/g, ' → ')
    .replace(/½/g, '1/2').replace(/¼/g, '1/4')
    .replace(/[|¦]/g, '\n')
    .toUpperCase()
    .replace(/(?<=\s|^)[IL|](?=P\b)/g, '1')          // "IP" / "lP" → "1P"
    .replace(/(?<=\d)[,;](?=\d{2}\b)/g, '.')           // 8,30 → 8.30
    .replace(/[ \t]+/g, ' ');
}

function parseTimeToken(h, m, ap, word) {
  if (word) return word === 'MIDNIGHT' ? 0 : 720;
  let hh = Number(h); const mm = m ? Number(m) : 0;
  if (!ap) return { hh, mm, needsSuffix: true };
  ap = ap.replace(/\./g, '');
  if (ap === 'AM') { if (hh === 12) hh = 0; }
  else { if (hh !== 12) hh += 12; }
  return hh * 60 + mm;
}

function resolveRange(a, b) {
  const resolve = (t, suffixFrom) => {
    if (typeof t === 'number') return t;
    const base = t.hh * 60 + t.mm;
    if (suffixFrom === 'AM') return (t.hh === 12 ? 0 : t.hh) * 60 + t.mm;
    if (suffixFrom === 'PM') return (t.hh === 12 ? 12 : t.hh + 12) * 60 + t.mm;
    return base; // no info: assume 24h-ish / AM
  };
  const aSuf = typeof a === 'number' ? null : null;
  let start, end;
  if (typeof a === 'object' && typeof b === 'object') {
    // neither has a suffix: assume AM start; if end <= start make end PM
    start = resolve(a, 'AM'); end = resolve(b, 'AM'); if (end <= start) end = resolve(b, 'PM');
  } else if (typeof a === 'object') {
    // start inherits end's suffix unless that makes start >= end
    const endSuffix = b >= 720 ? 'PM' : 'AM';
    end = b; start = resolve(a, endSuffix); if (start >= end) start = resolve(a, endSuffix === 'PM' ? 'AM' : 'PM');
  } else if (typeof b === 'object') {
    const startSuffix = a >= 720 ? 'PM' : 'AM';
    start = a; end = resolve(b, startSuffix); if (end <= start) end = resolve(b, startSuffix === 'PM' ? 'AM' : 'PM');
  } else { start = a; end = b; }
  void aSuf;
  return { start, end };
}

const hhmm = (mins) => mins === 1440 ? '24:00' : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export function extractTimeRanges(text) {
  const out = [];
  for (const m of text.matchAll(TIME_RANGE_RE)) {
    const a = parseTimeToken(m[1], m[2], m[3], m[4]);
    const b = parseTimeToken(m[5], m[6], m[7], m[8]);
    let { start, end } = resolveRange(a, b);
    if (end === 0) end = 1440; // "6PM-MIDNIGHT"
    out.push({ start: hhmm(start), end: hhmm(end), text: m[0].trim() });
  }
  return out;
}

export function extractDays(text) {
  const out = [];
  const t = text.replace(/\bWEEKDAYS?\b/g, 'MON-FRI').replace(/\bWEEKENDS?\b/g, 'SAT-SUN');
  const rangeRe = new RegExp(`\\b${DAY_RE}\\s*(?:-|–|—|TO)\\s*${DAY_RE}\\b`, 'g');
  const consumed = [];
  for (const m of t.matchAll(rangeRe)) {
    const a = DAY_INDEX[m[1]], b = DAY_INDEX[m[2]];
    const days = [];
    for (let d = a; ; d = d % 7 + 1) { days.push(d); if (d === b) break; if (days.length > 7) break; }
    out.push({ days, index: m.index, text: m[0] });
    consumed.push([m.index, m.index + m[0].length]);
  }
  const singleRe = new RegExp(`\\b${DAY_RE}\\b`, 'g');
  for (const m of t.matchAll(singleRe)) {
    if (consumed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    out.push({ days: [DAY_INDEX[m[1]]], index: m.index, text: m[0] });
  }
  return out.sort((x, y) => x.index - y.index);
}

function publicHolidayFlag(text) {
  if (/\b(EXCEPT|EXCL(?:UDING)?|NOT)\s+(ON\s+)?PUB(?:LIC)?\.?\s*HOL(?:IDAY)?S?\b/.test(text)) return 'exclude';
  if (/\bPUB(?:LIC)?\.?\s*HOL(?:IDAY)?S?\b|\bP\.?H\.?\b(?!\s*ZONE)/.test(text)) return 'include';
  return 'unspecified';
}

function extractExceptions(text) {
  const ex = [];
  let m;
  if ((m = /AREA\s*([0-9]{1,2}[A-Z]?)\s*(?:RESIDENT(?:IAL)?\s*)?PERMIT(?:\s*HOLDERS?)?\s*(?:EXCEPTED|EXEMPT|ONLY)?/.exec(text))) {
    ex.push({ type: 'resident_permit', area: m[1], text: m[0].trim() });
  } else if (/\b(RESIDENT(?:IAL)?\s*)?PERMIT\s*HOLDERS?\s*(EXCEPTED|EXEMPT)\b|\bEXCEPT\s*(RESIDENT(?:IAL)?\s*)?PERMIT\s*HOLDERS?\b|\bRESIDENT(?:IAL)?\s*PERMIT\s*EXCEPTED\b/.test(text)) {
    ex.push({ type: 'permit_holders', area: null, text: 'permit holders excepted' });
  } else if ((m = /\bPERMIT\s*ZONE\s*(?:AREA\s*)?([0-9]{1,2}[A-Z]?)\b/.exec(text))) {
    ex.push({ type: 'resident_permit', area: m[1], text: m[0].trim() });
  }
  if (/\bEXCEPT\s*BUSES\b|\bBUSES\s*EXCEPTED\b/.test(text)) ex.push({ type: 'buses', area: null, text: 'buses excepted' });
  if (/\bEXCEPT\s*TAXIS\b|\bTAXIS\s*EXCEPTED\b/.test(text)) ex.push({ type: 'taxis', area: null, text: 'taxis excepted' });
  return ex;
}

function detectKind(line) {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(line)) return kind;
  const stripped = line.replace(TIME_RANGE_RE, ' ');
  let m;
  if ((m = LIMIT_P_RE.exec(stripped))) {
    const v = m[1];
    const mins = v === '1/2' ? 30 : v === '1/4' ? 15 : Number(v) * 60;
    return mins > 0 ? { kind: 'time_limited', limitMinutes: mins } : null;
  }
  if ((m = LIMIT_MIN_RE.exec(stripped))) return { kind: 'time_limited', limitMinutes: Number(m[1]) };
  if (BARE_P_RE.test(stripped) && !/\bP\.?H\b/.test(stripped)) return { kind: 'unrestricted' };
  return null;
}

function sideFromArrows(text) {
  const l = text.includes('←'), r = text.includes('→'), b = text.includes('↔');
  if (b || (l && r)) return 'both';
  if (l) return 'left';
  if (r) return 'right';
  return null;
}

/**
 * Parse sign text into the structured sign model.
 * @param {string} text
 * @param {{jurisdiction?:string, council?:string|null}} opts
 */
export function parseSignText(text, opts = {}) {
  const norm = normaliseText(text);
  const lines = norm.split('\n').map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let sectionSide = null;
  let current = null;
  for (const line of lines) {
    const sec = /^(LEFT|RIGHT|BOTH)\s*(SIDE)?\s*:?$/.exec(line);
    if (sec) { sectionSide = sec[1] === 'BOTH' ? 'both' : sec[1].toLowerCase(); current = null; continue; }
    const kind = detectKind(line);
    // "DISABLED" / "MOTOR BIKES ONLY" followed by a bare "2P" line: the limit belongs to the zone panel.
    if (kind && typeof kind === 'object' && current && ZONE_WITH_LIMIT.has(current.kind) && current.lines.length === 1 && !TIME_RANGE_RE.test(current.lines[0])) {
      TIME_RANGE_RE.lastIndex = 0;
      current.lines.push(line); current.limit = kind.limitMinutes ?? null; continue;
    }
    TIME_RANGE_RE.lastIndex = 0;
    if (kind || !current) {
      current = { lines: [line], kind: kind ?? null, sectionSide };
      blocks.push(current);
    } else {
      current.lines.push(line);
    }
  }

  let recognised = 0;
  const panels = blocks.map((b, i) => {
    const txt = b.lines.join(' ');
    const k = typeof b.kind === 'string' ? { kind: b.kind } : (b.kind ?? { kind: 'unknown' });
    const panel = {
      id: `p${i + 1}`,
      kind: k.kind,
      side: sideFromArrows(txt) ?? b.sectionSide ?? 'both',
      limitMinutes: k.limitMinutes ?? null,
      fee: /\b(TICKET|METER(?:ED)?|PAY(?:\s*BY\s*PHONE)?|PAID|PAYSTAY)\b/.test(txt),
      area: /\bAREA\b/.test(txt.replace(/AREA\s*[0-9]{1,2}[A-Z]?\s*(RESIDENT|PERMIT)/g, '')) && !/PERMIT\s*ZONE/.test(txt),
      towAway: /\bTOW\s*AWAY\b/.test(txt),
      windows: [],
      exceptions: extractExceptions(txt),
      rawText: b.lines.join(' / '),
    };
    // Zone-specific limits ("LOADING ZONE 15 MIN")
    if (panel.kind !== 'time_limited') {
      if (b.limit) panel.limitMinutes = b.limit;
      const lm = LIMIT_MIN_RE.exec(txt.replace(TIME_RANGE_RE, ' '));
      if (lm) panel.limitMinutes = Number(lm[1]);
    }
    // Windows: pair each time range with the day spec that follows it (or precedes it if none follows).
    const ph = publicHolidayFlag(txt);
    if (!/\b(24\s*H(OU)?RS?|AT\s*ALL\s*TIMES)\b/.test(txt)) {
      const times = extractTimeRanges(txt).map(t => ({ ...t, index: txt.indexOf(t.text) }));
      const days = extractDays(txt);
      if (times.length) {
        times.forEach((t, idx) => {
          const nextT = times[idx + 1]?.index ?? Infinity;
          let d = days.filter(x => x.index > t.index && x.index < nextT);
          if (!d.length && idx === 0) d = days.filter(x => x.index < t.index);
          if (!d.length && times.length === 1) d = days;
          const dayList = d.length ? [...new Set(d.flatMap(x => x.days))].sort((a, b) => a - b) : null;
          panel.windows.push({ days: dayList, start: t.start, end: t.end, publicHolidays: ph });
        });
      } else if (days.length) {
        panel.windows.push({ days: [...new Set(days.flatMap(x => x.days))].sort((a, b) => a - b), start: null, end: null, publicHolidays: ph });
      }
    }
    if (panel.kind !== 'unknown') recognised++;
    return panel;
  });

  return {
    jurisdiction: opts.jurisdiction ?? 'au-vic',
    council: opts.council ?? null,
    rawText: text,
    confidence: panels.length ? recognised / panels.length : 0,
    panels,
  };
}
