// Public entry point. Works in Node and (with pre-loaded JSON) in the browser.
export { parseSignText, normaliseText, extractTimeRanges, extractDays } from './sign/parse.js';
export { interpret, evaluate, windowActive, VERDICT } from './engine/interpret.js';
export { holidayStatus } from './engine/holidays.js';
export { fineFor, offenceKeyFor, penaltyUnitValue } from './engine/fines.js';
export * as time from './engine/time.js';

/**
 * Convenience: bind a rules pack + holiday + council data once, then call .advise(signOrText, opts).
 */
export function createEngine({ rulesPack, holidays, councils, penalties, council = null, tz } = {}) {
  return {
    rulesPack, holidays, councils, penalties,
    async advise(signOrText, opts = {}) {
      const { parseSignText } = await import('./sign/parse.js');
      const { interpret } = await import('./engine/interpret.js');
      const sign = typeof signOrText === 'string' ? parseSignText(signOrText, { jurisdiction: rulesPack?.id, council }) : signOrText;
      return { sign, advice: interpret(sign, { rulesPack, holidays, councils, penalties, council, tz, ...opts }) };
    },
  };
}
