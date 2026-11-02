// Time helpers that work in a named IANA timezone (default Australia/Melbourne)
// without any dependency. Works in Node >= 18 and modern browsers.

export const DEFAULT_TZ = 'Australia/Melbourne';

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Break a Date into local wall-clock parts in tz. */
export function localParts(date, tz = DEFAULT_TZ) {
  const parts = {};
  for (const p of fmt(tz).formatToParts(date)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WD[parts.weekday], // ISO 1..7
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: hour * 60 + Number(parts.minute),
  };
}

/** Build a Date for local wall-clock y-m-d hh:mm in tz (handles DST by two-pass correction). */
export function fromLocal(year, month, day, hour = 0, minute = 0, tz = DEFAULT_TZ) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    guess += want - asUtc;
  }
  return new Date(guess);
}

/** Add whole days to a local calendar date (y,m,d) → {year,month,day}. */
export function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function dateAtMinutes(isoDate, minutes, tz = DEFAULT_TZ) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return fromLocal(y, m, d, Math.floor(minutes / 60), minutes % 60, tz);
}

export function hhmmToMinutes(s) {
  if (s == null) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToLabel(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(mins / 60), m = mins % 60;
  if (mins === 0) return 'midnight';
  if (mins === 720) return 'noon';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'am' : 'pm';
  return m === 0 ? `${h12}${ap}` : `${h12}:${String(m).padStart(2, '0')}${ap}`;
}

export function durationLabel(mins) {
  if (mins == null) return 'no limit';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  const hs = h === 1 ? '1 hour' : `${h} hours`;
  return m ? `${hs} ${m} min` : hs;
}

export function formatDateTime(date, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(date);
}
