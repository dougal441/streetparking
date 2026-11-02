// Vision reader: photo → structured sign. Backend-agnostic core.
//
//   readSign({ imageBase64, mediaType, jurisdiction, council, client })    Anthropic SDK (direct key, or via
//                                                                          Cloudflare AI Gateway with a baseURL)
//   readSignOpenAIShape(...)                                               builds an OpenAI-chat-style request for
//                                                                          Cloudflare's AI binding (Unified Billing
//                                                                          Claude, or Workers AI Llama 4 Scout)
//   normaliseSign(parsed, { jurisdiction, council })                       validates/cleans any backend's JSON
//
// The caller constructs the client so this file bundles anywhere (Node server, Cloudflare Worker).

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Structured-output schema: a constrained subset of rules/schema/sign.schema.json
// (structured outputs need additionalProperties:false and full "required" lists).
export const PANEL_KINDS = ['time_limited', 'unrestricted', 'no_stopping', 'no_parking', 'clearway', 'loading_zone', 'bus_zone', 'taxi_zone', 'works_zone', 'mail_zone', 'truck_zone', 'minibus_zone', 'permit_zone', 'disabled', 'motorbike', 'car_share', 'ev_charging', 'bicycle', 'unknown'];
export const SIGN_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['isParkingSign', 'rawText', 'confidence', 'panels'],
  properties: {
    isParkingSign: { type: 'boolean', description: 'false if the photo does not show a parking control sign' },
    rawText: { type: 'string', description: 'Every panel transcribed top to bottom, one panel per line, using <- -> <-> for arrows and LEFT:/RIGHT: lines for split signs' },
    confidence: { type: 'number', description: '0-1 overall confidence in the transcription' },
    panels: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'side', 'limitMinutes', 'fee', 'area', 'towAway', 'windows', 'exceptions', 'rawText'],
        properties: {
          kind: { type: 'string', enum: PANEL_KINDS },
          side: { type: 'string', enum: ['left', 'right', 'both'], description: 'Arrow direction as the viewer faces the sign. No arrow or double arrow = both' },
          limitMinutes: { type: ['integer', 'null'], description: '2P=120, 1P=60, 1/2P=30, 1/4P=15, "10 MINUTE"=10; null if no limit' },
          fee: { type: 'boolean', description: 'TICKET / METER / PAY / PAY BY PHONE shown' },
          area: { type: 'boolean', description: 'the word AREA (area restriction) — not "AREA 7" of a permit exception' },
          towAway: { type: 'boolean' },
          windows: {
            type: 'array', description: 'Empty if the panel shows no times or days',
            items: {
              type: 'object', additionalProperties: false, required: ['days', 'start', 'end', 'publicHolidays'],
              properties: {
                days: { type: ['array', 'null'], items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'ISO weekdays 1=Mon..7=Sun; null if the panel shows no days' },
                start: { type: ['string', 'null'], description: 'HH:MM 24h, null if no start time' },
                end: { type: ['string', 'null'], description: 'HH:MM 24h (24:00 for midnight end), null if no end time' },
                publicHolidays: { type: 'string', enum: ['unspecified', 'include', 'exclude'] },
              },
            },
          },
          exceptions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['type', 'area', 'text'],
              properties: {
                type: { type: 'string', enum: ['permit_holders', 'resident_permit', 'buses', 'taxis', 'goods_vehicles', 'motorbikes', 'disability_permit', 'other'] },
                area: { type: ['string', 'null'], description: 'permit area code e.g. "7", "1A"' },
                text: { type: ['string', 'null'] },
              },
            },
          },
          rawText: { type: 'string' },
        },
      },
    },
  },
};

export const SYSTEM = `You transcribe Australian (Victorian) street parking signs into structured data for a rules engine. Signs follow AS 1742.11: red-on-white panels prohibit (a red circle with a struck-through S = NO STOPPING; struck-through P = NO PARKING; CLEARWAY), green-on-white "P" panels permit with limits (2P = 2 hours, 1/2P = 30 minutes, "P 10 MINUTE" = 10 minutes, plain P = no limit), zone panels reserve the space (LOADING ZONE, PERMIT ZONE, BUS ZONE, TAXI ZONE, WORKS ZONE, MAIL ZONE, TRUCK ZONE, wheelchair symbol = disabled, MOTOR BIKES ONLY). TICKET/METER/PAY means a fee. Times like "7-9AM" share the suffix (07:00-09:00); "4-6.30PM" is 16:00-18:30; small AM/PM letters belong to the number before them. Days: MON-FRI = [1,2,3,4,5]; no days shown = null. Arrows: a panel's arrow says which side of the post it governs as you face the sign; a split sign (left half and right half with different content, often with a vertical line between) gives different panels different sides. A horizontal line or a change of colour separates panels. "AREA 7 RESIDENT PERMIT EXCEPTED" is an exception on the panel above it, not a new panel. Transcribe exactly what is printed; do not infer restrictions that are not on the sign. If text is unreadable, use kind "unknown" and say so in rawText.`;

const USER_TEXT = (jurisdiction, council) => `Jurisdiction: ${jurisdiction}${council ? `, council: ${council}` : ''}. Transcribe this parking sign.`;

/** Pull the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
  if (typeof text !== 'string') return text;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object in model reply');
  return JSON.parse(body.slice(start, end + 1));
}

/** Validate and clean a backend's JSON into the sign model. Throws on garbage. */
export function normaliseSign(parsed, { jurisdiction = 'au-vic', council = null } = {}) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Reader returned no object');
  if (parsed.isParkingSign === false) return { sign: null, error: 'No parking sign found in the photo.' };
  const hhmm = (v) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) ? v.padStart(5, '0') : null;
  const panels = (Array.isArray(parsed.panels) ? parsed.panels : []).map((p, i) => ({
    id: `p${i + 1}`,
    kind: PANEL_KINDS.includes(p?.kind) ? p.kind : 'unknown',
    side: ['left', 'right', 'both'].includes(p?.side) ? p.side : 'both',
    limitMinutes: Number.isInteger(p?.limitMinutes) && p.limitMinutes > 0 ? p.limitMinutes : null,
    fee: Boolean(p?.fee), area: Boolean(p?.area), towAway: Boolean(p?.towAway),
    windows: (Array.isArray(p?.windows) ? p.windows : []).map(w => ({
      days: Array.isArray(w?.days) && w.days.length ? [...new Set(w.days.map(Number).filter(d => d >= 1 && d <= 7))].sort() : null,
      start: hhmm(w?.start), end: hhmm(w?.end),
      publicHolidays: ['include', 'exclude'].includes(w?.publicHolidays) ? w.publicHolidays : 'unspecified',
    })).filter(w => w.days || w.start || w.end),
    exceptions: (Array.isArray(p?.exceptions) ? p.exceptions : []).map(e => ({ type: e?.type ?? 'other', area: e?.area ?? null, text: e?.text ?? null })),
    rawText: typeof p?.rawText === 'string' ? p.rawText : '',
  }));
  if (!panels.length) throw new Error('Reader found no panels');
  return {
    sign: { jurisdiction, council, rawText: typeof parsed.rawText === 'string' ? parsed.rawText : panels.map(p => p.rawText).join('\n'), confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null, panels },
  };
}

/**
 * Anthropic SDK path (direct API key, or Cloudflare AI Gateway via baseURL).
 * @param {{imageBase64:string, mediaType?:string, jurisdiction?:string, council?:string|null, client:object, model?:string, fallbacks?:boolean}} args
 */
export async function readSign({ imageBase64, mediaType = 'image/jpeg', jurisdiction = 'au-vic', council = null, client, model = DEFAULT_MODEL, fallbacks = true }) {
  if (!client) throw new Error('readSign: an Anthropic client is required');
  const base = {
    model, max_tokens: 4096,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SIGN_OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
      { type: 'text', text: USER_TEXT(jurisdiction, council) },
    ] }],
  };
  // Server-side refusal fallback: retried on a fallback model if the image is declined. Some proxies reject
  // beta headers, so fall back to a plain request on a 400 that mentions them.
  let response;
  if (fallbacks) {
    try { response = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }); }
    catch (e) { if (e?.status === 400 && /fallback|beta/i.test(String(e?.message))) response = null; else throw e; }
  }
  if (!response) response = await client.messages.create(base);
  if (response.stop_reason === 'refusal') throw new Error('The vision model declined to read this image.');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = normaliseSign(extractJson(text), { jurisdiction, council });
  return { ...out, model: response.model, usage: response.usage };
}

/**
 * OpenAI-chat-shaped request for Cloudflare's AI binding (env.AI.run) — used for both
 * Unified-Billing Claude ("anthropic/claude-opus-5.5") and Workers AI vision models.
 */
export function buildChatRequest({ imageBase64, mediaType = 'image/jpeg', jurisdiction = 'au-vic', council = null, jsonSchema = true }) {
  const req = {
    messages: [
      { role: 'system', content: SYSTEM + ' Reply with a single JSON object matching the schema; no prose.' },
      { role: 'user', content: [
        { type: 'text', text: USER_TEXT(jurisdiction, council) + ' Required JSON schema: ' + JSON.stringify(SIGN_OUTPUT_SCHEMA) },
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
      ] },
    ],
    max_tokens: 4096,
  };
  if (jsonSchema) req.response_format = { type: 'json_schema', json_schema: { name: 'parking_sign', schema: SIGN_OUTPUT_SCHEMA } };
  return req;
}

/** Pull reply text out of whatever shape the AI binding returns. */
export function chatReplyText(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.response === 'string') return resp.response;
  if (resp.response && typeof resp.response === 'object') return JSON.stringify(resp.response);
  const c = resp.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x.text ?? '').join('');
  if (Array.isArray(resp.content)) return resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.stringify(resp);
}
