// Fine (infringement penalty) lookup. Data: rules/<jurisdiction>/penalties.json.
// amount = penaltyUnits × penalty unit value for the financial year of `at`; a council may have fixed a
// higher minimum for the cheap items (Road Safety Act s 87(4)), which we apply when known.

export function penaltyUnitValue(penalties, at) {
  const iso = at.toISOString().slice(0, 10);
  const row = (penalties?.penaltyUnit ?? []).find(r => r.from <= iso && iso <= r.to);
  if (row) return { value: row.value, known: true };
  const last = (penalties?.penaltyUnit ?? []).at(-1);
  return { value: last?.value ?? null, known: false };
}

/**
 * @param {object} penalties  penalties.json
 * @param {string} key        offence key (e.g. 'no_stopping', 'overstay')
 * @param {Date} at
 * @param {string|null} council
 * @returns {null | {key, code, provision, summary, units, amount, approx, note}}
 */
export function fineFor(penalties, key, at, council) {
  const off = penalties?.offences?.[key];
  if (!off) return null;
  const { value, known } = penaltyUnitValue(penalties, at);
  if (value == null) return null;
  let units = off.penaltyUnits;
  let note = null;
  const min = council ? penalties.councilMinimumUnits?.[council] : undefined;
  if (typeof min === 'number' && min > units) { units = min; note = `Council sets ${min} penalty units for this offence (Road Safety Act s 87(4)).`; }
  else if (off.penaltyUnits < 0.5 && !council) { note = 'Most councils charge 0.5 penalty units (~$105) for this offence under s 87(4); the regulation base is shown.'; }
  const amount = Math.round(units * value);
  return { key, code: off.code, provision: off.provision, summary: off.summary, units, amount, approx: !known || Boolean(note), unitValue: value, note };
}

/** Which offence a verdict exposes the driver to. */
export function offenceKeyFor(sideResult) {
  const kinds = (sideResult.activePanels ?? []).map(p => p.kind);
  if (sideResult.verdict === 'no') {
    for (const k of ['no_stopping', 'clearway', 'loading_zone', 'disabled', 'permit_zone', 'bus_zone', 'taxi_zone', 'works_zone', 'mail_zone', 'truck_zone', 'minibus_zone', 'motorbike', 'bicycle', 'ev_charging']) if (kinds.includes(k)) return k;
    return null;
  }
  if (sideResult.verdict === 'stop_only') return 'no_parking';
  if (sideResult.verdict === 'ok') {
    if (sideResult.maxStayMinutes != null && kinds.includes('loading_zone')) return 'loading_overstay';
    if (sideResult.maxStayMinutes != null) return 'overstay';
    if (sideResult.fee) return 'fee';
  }
  return null;
}
