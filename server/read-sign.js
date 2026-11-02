// Vision reader: photo → structured sign via Claude. Runs server-side so the API key stays private.
// Usage: const { readSign } = await import('./read-sign.js'); await readSign({ imageBase64, mediaType, council });
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CANIPARKHERE_MODEL ?? 'claude-opus-5-5';

// Structured-output schema: a constrained subset of rules/schema/sign.schema.json
// (structured outputs need additionalProperties:false and full "required" lists).
const PANEL_KINDS = ['time_limited', 'unrestricted', 'no_stopping', 'no_parking', 'clearway', 'loading_zone', 'bus_zone', 'taxi_zone', 'works_zone', 'mail_zone', 'truck_zone', 'minibus_zone', 'permit_zone', 'disabled', 'motorbike', 'car_share', 'ev_charging', 'bicycle', 'unknown'];
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

const SYSTEM = `You transcribe Australian (Victorian) street parking signs into structured data for a rules engine. Signs follow AS 1742.11: red-on-white panels prohibit (NO STOPPING, NO PARKING, CLEARWAY), green-on-white "P" panels permit with limits (2P = 2 hours, 1/2P = 30 minutes, "P 10 MINUTE" = 10 minutes, plain P = no limit), zone panels reserve the space (LOADING ZONE, PERMIT ZONE, BUS ZONE, TAXI ZONE, WORKS ZONE, MAIL ZONE, TRUCK ZONE, wheelchair symbol = disabled, MOTOR BIKES ONLY). TICKET/METER/PAY means a fee. Times like "7-9AM" share the suffix (07:00-09:00); "4-6.30PM" is 16:00-18:30. Days: MON-FRI = [1,2,3,4,5]; no days shown = null. Arrows: a panel's arrow says which side of the post it governs as you face the sign; a split sign (left half and right half with different content) gives different panels different sides. A horizontal line or a change of colour separates panels. "AREA 7 RESIDENT PERMIT EXCEPTED" is an exception on the panel above it, not a new panel. Transcribe exactly what is printed; do not infer restrictions that are not on the sign. If text is unreadable, use kind "unknown" and say so in rawText.`;

export async function readSign({ imageBase64, mediaType = 'image/jpeg', jurisdiction = 'au-vic', council = null, client = new Anthropic() }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SIGN_OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Jurisdiction: ${jurisdiction}${council ? `, council: ${council}` : ''}. Transcribe this parking sign.` },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The vision model declined to read this image.');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  if (!parsed.isParkingSign) return { sign: null, error: 'No parking sign found in the photo.' };
  const sign = {
    jurisdiction, council,
    rawText: parsed.rawText, confidence: parsed.confidence,
    panels: parsed.panels.map((p, i) => ({ id: `p${i + 1}`, ...p })),
  };
  return { sign, model: response.model, usage: response.usage };
}
