// Public-holiday lookup. Data lives in rules/<jurisdiction>/public-holidays.json.

/**
 * @param {string} isoDate YYYY-MM-DD (local)
 * @param {{holidays: Array}} holidayPack
 * @param {{dayInLieu?: 'both'|'holiday_only'|'unknown'}} policy council policy
 * @returns {{isHoliday:boolean, name?:string, confidence:'high'|'medium'|'low', note?:string}}
 */
export function holidayStatus(isoDate, holidayPack, policy = {}) {
  const list = holidayPack?.holidays ?? [];
  const dayInLieu = policy.dayInLieu ?? 'unknown';
  const direct = list.find(h => h.date === isoDate);
  if (direct) {
    const isSubstitute = Boolean(direct.substituteFor);
    let confidence = direct.tbc ? 'low' : 'high';
    let note = direct.note;
    if (isSubstitute && dayInLieu === 'holiday_only') {
      return { isHoliday: false, name: direct.name, confidence: 'medium', note: 'Council applies holiday parking rules to the actual holiday only, not the substitute day.' };
    }
    if (isSubstitute && dayInLieu === 'unknown') { confidence = 'low'; note = 'Substitute public holiday: councils differ on whether holiday parking rules apply. Follow the sign to be safe.'; }
    return { isHoliday: true, name: direct.name, confidence, note };
  }
  // A date that a substitute holiday stands in for (e.g. Boxing Day on a Saturday).
  const original = list.find(h => h.substituteFor === isoDate);
  if (original) {
    if (dayInLieu === 'both' || dayInLieu === 'holiday_only') return { isHoliday: true, name: original.name.replace(/ \(substitute\)/, ''), confidence: 'high' };
    return { isHoliday: true, name: original.name, confidence: 'low', note: 'Actual holiday date with a substitute day declared; council treatment varies.' };
  }
  const years = new Set(list.map(h => h.date.slice(0, 4)));
  if (!years.has(isoDate.slice(0, 4))) return { isHoliday: false, confidence: 'low', note: `No public-holiday data loaded for ${isoDate.slice(0, 4)}.` };
  return { isHoliday: false, confidence: 'high' };
}
