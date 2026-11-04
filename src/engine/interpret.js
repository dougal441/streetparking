// CanIparkhere rules engine.
// Input: a structured sign (rules/schema/sign.schema.json), a moment in time, a vehicle profile.
// Output: per-side advice (left / right / both) plus a timeline of how the verdict changes.
//
// This file is deliberately dependency-free and side-effect-free so it runs identically
// in Node tests and in the browser.

import { localParts, dateAtMinutes, addDays, hhmmToMinutes, minutesToLabel, durationLabel, DEFAULT_TZ } from './time.js';
import { holidayStatus } from './holidays.js';
import { fineFor, offenceKeyFor } from './fines.js';
import { planFor } from './plan.js';

export const VERDICT = Object.freeze({
  OK: 'ok',              // you can park (maybe with a time limit / fee)
  NO: 'no',              // you cannot stop here
  STOP_ONLY: 'stop_only',// no parking: 2 minute drop-off only
  UNKNOWN: 'unknown',    // no panel addresses this side / unreadable
});

const PROHIBIT = new Set(['no_stopping', 'clearway']);
const ZONES = new Set(['loading_zone', 'bus_zone', 'taxi_zone', 'works_zone', 'mail_zone', 'truck_zone', 'minibus_zone', 'permit_zone', 'disabled', 'motorbike', 'car_share', 'ev_charging', 'bicycle']);

const ZONE_RULE = {
  no_stopping: 'no-stopping', clearway: 'clearway', no_parking: 'no-parking',
  loading_zone: 'loading-zone', bus_zone: 'bus-zone', taxi_zone: 'taxi-zone', works_zone: 'works-zone',
  mail_zone: 'mail-zone', truck_zone: 'truck-zone', minibus_zone: 'minibus-zone', permit_zone: 'permit-zone',
  disabled: 'disabled-parking', motorbike: 'motorbike-parking', time_limited: 'time-limited', unrestricted: 'permissive-sign-meaning',
  ev_charging: 'ev-parking', bicycle: 'bicycle-parking',
};

const ZONE_WHO = {
  loading_zone: 'goods vehicles (not sedans/wagons), taxis and buses, while loading or unloading',
  bus_zone: 'buses', taxi_zone: 'taxis', works_zone: 'vehicles engaged in nearby construction work',
  mail_zone: 'Australia Post vehicles', truck_zone: 'trucks (4.5 t+)', minibus_zone: 'minibuses',
  permit_zone: 'vehicles displaying the permit named on the sign', disabled: 'vehicles displaying an Accessible Parking Permit',
  motorbike: 'motorcycles', car_share: 'car-share vehicles', ev_charging: 'electric vehicles while charging', bicycle: 'bicycles',
};

/** Does this vehicle profile count as "allowed" in a zone kind? */
function zoneAllows(kind, panel, vehicle) {
  const t = vehicle.type ?? 'car';
  const permits = vehicle.permits ?? [];
  switch (kind) {
    case 'loading_zone': return ['goods_vehicle', 'truck', 'taxi', 'bus'].includes(t);
    case 'truck_zone': return t === 'truck';
    case 'bus_zone': return t === 'bus';
    case 'minibus_zone': return t === 'minibus' || t === 'bus';
    case 'taxi_zone': return t === 'taxi';
    case 'works_zone': return t === 'works_vehicle';
    case 'mail_zone': return t === 'mail';
    case 'motorbike': return t === 'motorbike';
    case 'car_share': return t === 'car_share';
    case 'ev_charging': return t === 'ev';
    case 'bicycle': return t === 'bicycle';
    case 'disabled': return permits.includes('accessible_permit');
    case 'permit_zone': {
      const areas = (panel.exceptions ?? []).filter(e => e.area).map(e => String(e.area).toUpperCase());
      if (areas.length === 0) return permits.some(p => p.startsWith('resident_permit'));
      return areas.some(a => permits.includes(`resident_permit:${a}`));
    }
    default: return false;
  }
}

/** Is the user exempt from this panel via an exception printed on it? */
function exceptionApplies(panel, vehicle) {
  const t = vehicle.type ?? 'car';
  const permits = vehicle.permits ?? [];
  for (const ex of panel.exceptions ?? []) {
    if (ex.type === 'buses' && t === 'bus') return ex;
    if (ex.type === 'taxis' && t === 'taxi') return ex;
    if (ex.type === 'goods_vehicles' && (t === 'goods_vehicle' || t === 'truck')) return ex;
    if (ex.type === 'motorbikes' && t === 'motorbike') return ex;
    if (ex.type === 'disability_permit' && permits.includes('accessible_permit')) return ex;
    if (ex.type === 'permit_holders' || ex.type === 'resident_permit') {
      if (ex.area) { if (permits.includes(`resident_permit:${String(ex.area).toUpperCase()}`)) return ex; }
      else if (permits.some(p => p.startsWith('resident_permit'))) return ex;
    }
  }
  return null;
}

/**
 * Is a window active at local parts? Applies rule 318: day-of-week signs are off on public holidays
 * unless the sign says otherwise; signs with no days apply every day.
 */
export function windowActive(w, parts, holiday, prevDayHoliday) {
  const start = w.start == null ? 0 : hhmmToMinutes(w.start);
  const end = w.end == null ? 1440 : hhmmToMinutes(w.end);
  const m = parts.minutesOfDay;
  let weekday = parts.weekday;
  let inTime;
  let holidayToday = holiday?.isHoliday ?? false;
  if (end > start) {
    inTime = m >= start && m < end;
  } else { // overnight, e.g. 6PM-6AM
    if (m >= start) inTime = true;
    else if (m < end) { inTime = true; weekday = weekday === 1 ? 7 : weekday - 1; holidayToday = prevDayHoliday?.isHoliday ?? false; }
    else inTime = false;
  }
  if (!inTime) return false;
  const hasDays = Array.isArray(w.days) && w.days.length > 0;
  if (hasDays && !w.days.includes(weekday)) return false;
  const ph = w.publicHolidays ?? 'unspecified';
  if (holidayToday) {
    if (ph === 'exclude') return false;
    if (hasDays && ph !== 'include') return false; // rule 318(3)
  }
  return true;
}

function panelActive(panel, parts, holiday, prevDayHoliday) {
  const ws = panel.windows ?? [];
  if (ws.length === 0) return true;
  return ws.some(w => windowActive(w, parts, holiday, prevDayHoliday));
}

/** Evaluate one side's panels at one instant. Pure. */
export function evaluate(panels, parts, ctx) {
  const { holiday, prevDayHoliday, vehicle, rulesById } = ctx;
  const notes = [];
  const rules = new Set();
  const active = [];
  for (const p of panels) {
    if (!panelActive(p, parts, holiday, prevDayHoliday)) continue;
    const ex = exceptionApplies(p, vehicle);
    if (ex) { notes.push(`"${p.rawText ?? p.kind}" does not apply to you (${ex.text ?? ex.type.replace('_', ' ')} excepted).`); continue; }
    active.push(p);
  }
  const addRule = (kind) => { const id = ZONE_RULE[kind]; if (id && rulesById[id]) rules.add(id); };

  // 1. Absolute prohibitions.
  const prohibit = active.find(p => PROHIBIT.has(p.kind));
  if (prohibit) {
    addRule(prohibit.kind);
    const tow = prohibit.towAway || prohibit.kind === 'clearway';
    return { verdict: VERDICT.NO, headline: prohibit.kind === 'clearway' ? 'No — clearway. Do not stop.' : 'No — no stopping, not even to drop off.',
      detail: tow ? 'Vehicles are towed from here.' : 'Stopping for any reason is an offence.', maxStayMinutes: 0, fee: false, activePanels: active, notes, rules: [...rules] };
  }
  // 2. Zones.
  const zone = active.find(p => ZONES.has(p.kind));
  if (zone) {
    addRule(zone.kind);
    if (!zoneAllows(zone.kind, zone, vehicle)) {
      const who = ZONE_WHO[zone.kind] ?? 'authorised vehicles';
      return { verdict: VERDICT.NO, headline: `No — ${zone.kind.replace('_', ' ')}: only ${who}.`, detail: zone.kind === 'loading_zone' ? 'Ordinary cars may not stop here even to load.' : '', maxStayMinutes: 0, fee: false, activePanels: active, notes, rules: [...rules] };
    }
    const limit = zone.limitMinutes ?? (zone.kind === 'loading_zone' || zone.kind === 'truck_zone' ? 30 : null);
    notes.push(`You qualify for this ${zone.kind.replace('_', ' ')}.`);
    if (zone.kind === 'disabled' && limit) notes.push('Inside an accessible bay the signed time applies as-is (no doubling, rule 206(2)).');
    if (zone.fee) rules.add('fees');
    return { verdict: VERDICT.OK, headline: limit ? `Yes — up to ${durationLabel(limit)} (${zone.kind.replace('_', ' ')}).` : `Yes — ${zone.kind.replace('_', ' ')}.`, detail: '', maxStayMinutes: limit, fee: Boolean(zone.fee), activePanels: active, notes, rules: [...rules] };
  }
  // 3. No parking.
  const np = active.find(p => p.kind === 'no_parking');
  if (np) {
    addRule('no_parking');
    const hasAP = (vehicle.permits ?? []).includes('accessible_permit');
    let lim = np.limitMinutes ?? rulesById['no-parking']?.params?.maxMinutes ?? 2;
    if (hasAP && lim < 5) { lim = rulesById['no-parking']?.params?.maxMinutesAccessiblePermit ?? 5; notes.push('Accessible parking permit: 5 minutes allowed in a No Parking area (rule 168(3)(c)).'); }
    return { verdict: VERDICT.STOP_ONLY, headline: `No parking — drop-off/pick-up only, max ${lim} min, stay within 3 m of the car.`, detail: '', maxStayMinutes: lim, fee: false, activePanels: active, notes, rules: [...rules] };
  }
  // 4. Time limited / unrestricted.
  const limited = active.filter(p => p.kind === 'time_limited' && p.limitMinutes);
  const feePanels = active.filter(p => p.fee);
  const fee = feePanels.length > 0;
  if (fee) rules.add('fees');
  if (limited.length) {
    addRule('time_limited'); rules.add('permissive-sign-meaning');
    let limit = Math.min(...limited.map(p => p.limitMinutes));
    if (limited.length > 1 && new Set(limited.map(p => p.limitMinutes)).size > 1) notes.push('Two time limits overlap at this time; the shorter one is used. Check the sign.');
    if ((vehicle.permits ?? []).includes('accessible_permit')) {
      const mult = rulesById['accessible-permit-double-time']?.params?.permitTimeMultiplier ?? 2;
      limit = limit * mult; rules.add('accessible-permit-double-time');
      notes.push(`Accessible parking permit: ${mult}x the signed time (${durationLabel(limit)}) under rule 206.`);
    }
    return { verdict: VERDICT.OK, headline: `Yes — up to ${durationLabel(limit)}${fee ? ', fee payable' : ''}.`, detail: fee ? 'Pay at the meter/ticket machine or by phone for the whole stay.' : '', maxStayMinutes: limit, fee, activePanels: active, notes, rules: [...rules] };
  }
  const unrestricted = active.find(p => p.kind === 'unrestricted');
  if (unrestricted) {
    rules.add('permissive-sign-meaning');
    return { verdict: VERDICT.OK, headline: `Yes — no time limit on this sign${fee ? ', fee payable' : ''}.`, detail: '', maxStayMinutes: null, fee, activePanels: active, notes, rules: [...rules] };
  }
  if (active.some(p => p.kind === 'unknown')) {
    return { verdict: VERDICT.UNKNOWN, headline: 'Could not read this panel — check the sign.', detail: '', maxStayMinutes: null, fee: false, activePanels: active, notes, rules: [] };
  }
  // 5. Nothing applies right now.
  rules.add('sign-times-days');
  return { verdict: VERDICT.OK, headline: panels.length ? 'Yes — no restriction on this sign applies right now.' : 'No sign panel covers this side.', detail: 'General road rules still apply (intersections, driveways, crossings).', maxStayMinutes: null, fee: false, activePanels: [], notes, rules: [...rules], unsigned: true };
}

/** All window boundary instants for a set of panels between now and now + horizonDays. */
function boundaries(panels, parts, tz, horizonDays) {
  const out = new Set();
  for (let d = -1; d <= horizonDays; d++) {
    const iso = addDays(parts.isoDate, d);
    for (const p of panels) for (const w of p.windows ?? []) {
      for (const hm of [w.start ?? '00:00', w.end ?? '24:00']) {
        const mins = hhmmToMinutes(hm);
        const date = dateAtMinutes(iso, mins, tz);
        out.add(date.getTime());
      }
    }
    // midnight boundaries matter for day-of-week and holiday changes
    out.add(dateAtMinutes(iso, 0, tz).getTime());
  }
  return [...out].sort((a, b) => a - b);
}

/** Short name of what a timeline segment is, for "leave by" reasons: "clearway", "no stopping", "2 hour limit". */
function shortName(seg) {
  const kinds = (seg.activePanels ?? []).map(p => p.kind);
  for (const k of ['clearway', 'no_stopping', 'no_parking', 'loading_zone', 'works_zone', 'bus_zone', 'taxi_zone', 'permit_zone', 'truck_zone', 'mail_zone', 'disabled', 'motorbike']) if (kinds.includes(k)) return k.replace(/_/g, ' ');
  if (seg.maxStayMinutes != null) return `${durationLabel(seg.maxStayMinutes)} limit`;
  return seg.verdict === VERDICT.OK ? 'parking' : 'restriction';
}

function sameOutcome(a, b) {
  return a.verdict === b.verdict && a.maxStayMinutes === b.maxStayMinutes && a.fee === b.fee && a.headline === b.headline;
}

/**
 * Main entry point.
 * @param {object} sign structured sign
 * @param {object} opts { at: Date, tz, rulesPack, holidays, councils, council, vehicle, horizonDays }
 */
export function interpret(sign, opts = {}) {
  const tz = opts.tz ?? opts.rulesPack?.timezone ?? DEFAULT_TZ;
  const at = opts.at ?? new Date();
  const vehicle = opts.vehicle ?? { type: 'car', permits: [] };
  const rulesById = Object.fromEntries((opts.rulesPack?.rules ?? []).map(r => [r.id, r]));
  const councilId = sign.council ?? opts.council ?? null;
  const policy = (councilId && opts.councils?.councils?.[councilId]?.publicHolidayPolicy) ?? opts.councils?.default?.publicHolidayPolicy ?? {};
  const horizonDays = opts.horizonDays ?? 2;

  const hol = (iso) => holidayStatus(iso, opts.holidays, policy);
  const ctxAt = (date) => {
    const parts = localParts(date, tz);
    return { parts, ctx: { holiday: hol(parts.isoDate), prevDayHoliday: hol(addDays(parts.isoDate, -1)), vehicle, rulesById } };
  };

  const panels = (sign.panels ?? []).map((p, i) => ({ id: p.id ?? `p${i + 1}`, side: 'both', windows: [], exceptions: [], fee: false, towAway: false, area: false, ...p }));
  const sideKeys = panels.some(p => p.side !== 'both') ? ['left', 'right'] : ['both'];
  const { parts: nowParts, ctx: nowCtx } = ctxAt(at);

  const sides = {};
  for (const side of sideKeys) {
    const sidePanels = panels.filter(p => p.side === 'both' || p.side === side);
    const now = evaluate(sidePanels, nowParts, nowCtx);

    // Timeline over the horizon.
    const segs = [];
    let cur = { from: at, ...now };
    for (const t of boundaries(sidePanels, nowParts, tz, horizonDays)) {
      if (t <= at.getTime()) continue;
      const d = new Date(t);
      const { parts, ctx } = ctxAt(d);
      const r = evaluate(sidePanels, parts, ctx);
      if (!sameOutcome(r, cur)) { segs.push({ ...cur, to: d }); cur = { from: d, ...r }; }
    }
    segs.push({ ...cur, to: null });

    // Leave-by.
    let leaveBy = null, leaveByReason = null;
    if (now.verdict === VERDICT.OK) {
      const curSeg = segs[0];
      if (now.maxStayMinutes != null) {
        const byLimit = new Date(at.getTime() + now.maxStayMinutes * 60000);
        if (!curSeg.to || byLimit <= curSeg.to) { leaveBy = byLimit; leaveByReason = `${durationLabel(now.maxStayMinutes)} limit`; }
        else {
          // Limit outlasts the signed period — walk forward through the timeline.
          let i = 1; let lb = null; let reason = null;
          while (i < segs.length) {
            const s = segs[i];
            if (s.verdict !== VERDICT.OK) { lb = s.from; reason = `${shortName(s)} starts at ${minutesToLabel(localParts(s.from, tz).minutesOfDay)}`; break; }
            if (s.maxStayMinutes != null) { lb = new Date(s.from.getTime() + s.maxStayMinutes * 60000); reason = `new ${durationLabel(s.maxStayMinutes)} limit starts ${minutesToLabel(localParts(s.from, tz).minutesOfDay)} (assumes a fresh limit — check rule 205A)`; break; }
            i++;
          }
          leaveBy = lb; leaveByReason = reason ?? 'no later restriction found in the next ' + horizonDays + ' days';
          now.notes.push(`The ${durationLabel(now.maxStayMinutes)} limit only runs until ${minutesToLabel(localParts(curSeg.to, tz).minutesOfDay)}, when this restriction ends.`);
        }
      } else {
        const next = segs.find(s => s.verdict !== VERDICT.OK || s.maxStayMinutes != null);
        if (next) { leaveBy = next.from; leaveByReason = `${shortName(next)} starts`; }
      }
    } else if (now.verdict === VERDICT.STOP_ONLY) {
      leaveBy = new Date(at.getTime() + (now.maxStayMinutes ?? 2) * 60000); leaveByReason = 'drop-off only';
    }

    // What a ticket costs: the offence you'd commit by parking here (NO / STOP_ONLY), or by overstaying / not paying (OK).
    const offence = offenceKeyFor(now);
    const fine = offence ? fineFor(opts.penalties, offence, at, councilId) : null;
    const feeFine = now.verdict === VERDICT.OK && now.fee && offence !== 'fee' ? fineFor(opts.penalties, 'fee', at, councilId) : null;
    const entry = { ...now, leaveBy, leaveByReason, fine, feeFine, timeline: segs.map(s => ({ from: s.from, to: s.to, verdict: s.verdict, headline: s.headline, maxStayMinutes: s.maxStayMinutes, fee: s.fee })) };
    if (entry.unsigned && panels.length && sideKeys.length === 2 && !sidePanels.length) {
      entry.verdict = VERDICT.UNKNOWN;
      entry.headline = 'The reader put every panel on the other side.';
      entry.detail = 'Open "Show my working" and tap ← ↔ → on a panel to move it, or re-take the photo straight on.';
      entry.fine = null;
    }
    const plan = planFor(entry, at, tz);
    sides[side] = { ...entry, plan: plan.sentences, nextOk: plan.nextOk };
  }

  const general = (opts.rulesPack?.rules ?? []).filter(r => (r.appliesTo ?? []).includes('general') && r.id !== 'sign-times-days');
  const usedRuleIds = new Set(Object.values(sides).flatMap(s => s.rules));
  const ruleRefs = (ids) => [...ids].map(id => rulesById[id]).filter(Boolean).map(r => ({ id: r.id, number: r.number, title: r.title, plain: r.plain, url: r.sources?.[0]?.url, verification: r.verification?.status }));

  return {
    at: at.toISOString(), tz, local: nowParts, holiday: nowCtx.holiday, council: councilId,
    vehicle, sides, split: sideKeys.length === 2,
    rules: ruleRefs(usedRuleIds),
    penaltiesSource: opts.penalties?.sources?.[0]?.url ?? null,
    generalRules: ruleRefs(general.map(r => r.id)),
    instrument: opts.rulesPack?.instrument ?? null,
  };
}
