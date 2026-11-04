// Turn a side's timeline into plain sentences: what you can do now, what changes next, and when.
import { localParts, minutesToLabel, durationLabel } from './time.js';

function clock(d, tz, nowParts) {
  const p = localParts(d, tz);
  const t = minutesToLabel(p.minutesOfDay);
  if (p.isoDate === nowParts.isoDate) return t;
  const tomorrowIso = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1)).toISOString().slice(0, 10);
  if (p.isoDate === tomorrowIso) return `${t} tomorrow`;
  return `${t} ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][p.weekday]}`;
}

function inWords(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `in ${h}h${r ? ' ' + r + 'm' : ''}`;
}

/**
 * @param {object} side   one entry of advice.sides (verdict, timeline, leaveBy, maxStayMinutes, fee)
 * @param {Date} at
 * @param {string} tz
 * @returns {{sentences:string[], nextOk:null|{from:Date,until:Date|null,maxStayMinutes:number|null,fee:boolean}}}
 */
export function planFor(side, at, tz) {
  const nowParts = localParts(at, tz);
  const tl = side.timeline ?? [];
  const sentences = [];
  const say = (s) => sentences.push(s);
  const when = (d) => clock(d, tz, nowParts);
  const limitTxt = (m) => m != null ? ` for up to ${durationLabel(m)}` : ' with no time limit';

  if (side.verdict === 'unknown') return { sentences: [], nextOk: null };

  if (side.verdict === 'ok') {
    if (side.maxStayMinutes != null) {
      say(`You can park now for up to ${durationLabel(side.maxStayMinutes)}${side.fee ? ' (pay first)' : ''}.`);
      if (side.leaveBy) say(`Be gone by ${when(side.leaveBy)}${side.leaveByReason ? ` — ${side.leaveByReason}` : ''}.`);
    } else if (side.leaveBy) {
      say(`You can park now, no time limit${side.fee ? ' (fee applies)' : ''}, until ${when(side.leaveBy)}${side.leaveByReason ? ` — ${side.leaveByReason}` : ''}.`);
    } else {
      say(`You can park now with no time limit${side.fee ? ' (fee applies)' : ''}; nothing on this sign changes that in the next two days.`);
    }
  } else {
    say(side.verdict === 'stop_only' ? `Right now: drop-off or pick-up only, ${side.maxStayMinutes ?? 2} minutes, stay with the car.` : 'Right now you cannot park here.');
  }

  // The next OK run after the current segment, and how long it lasts.
  let nextOk = null;
  for (let i = 1; i < tl.length; i++) {
    const s = tl[i];
    if (s.verdict !== 'ok') continue;
    let until = s.to;
    for (let j = i + 1; j < tl.length; j++) { if (tl[j].verdict !== 'ok') { until = tl[j].from; break; } until = tl[j].to; }
    nextOk = { from: s.from, until, maxStayMinutes: s.maxStayMinutes, fee: s.fee };
    break;
  }

  const next = tl[1];
  if (side.verdict !== 'ok') {
    if (next && next.verdict === 'ok') say(`From ${when(next.from)} (${inWords(next.from - at)}) you can park here${limitTxt(next.maxStayMinutes)}${next.fee ? ', fee payable' : ''}${nextOk?.until ? ` until ${when(nextOk.until)}` : ''}.`);
    else if (nextOk) say(`Next chance: ${when(nextOk.from)} (${inWords(nextOk.from - at)})${limitTxt(nextOk.maxStayMinutes)}${nextOk.until ? `, until ${when(nextOk.until)}` : ''}.`);
    else say('No parking window on this sign in the next two days.');
  } else if (next) {
    if (next.verdict !== 'ok') say(`At ${when(next.from)}: ${next.headline.replace(/\.$/, '')}.`);
    else if (next.maxStayMinutes !== side.maxStayMinutes || next.fee !== side.fee) say(`From ${when(next.from)}: ${next.headline.replace(/\.$/, '')}.`);
    if (nextOk && next.verdict !== 'ok') say(`Parking opens again at ${when(nextOk.from)}${limitTxt(nextOk.maxStayMinutes)}.`);
  }
  return { sentences, nextOk };
}
