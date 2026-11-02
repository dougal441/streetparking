import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normaliseSign, buildChatRequest, chatReplyText, SIGN_OUTPUT_SCHEMA } from '../server/read-sign.js';

const sample = { isParkingSign: true, rawText: 'LEFT:\nNO STOPPING <-\nRIGHT:\nWORKS ZONE 7AM-4PM MON-FRI ->', confidence: 0.9,
  panels: [
    { kind: 'no_stopping', side: 'left', limitMinutes: null, fee: false, area: false, towAway: false, windows: [], exceptions: [], rawText: 'NO STOPPING' },
    { kind: 'works_zone', side: 'right', limitMinutes: null, fee: false, area: false, towAway: false, windows: [{ days: [1, 2, 3, 4, 5], start: '7:00', end: '16:00', publicHolidays: 'unspecified' }], exceptions: [], rawText: 'WORKS ZONE 7AM-4PM MON-FRI' },
  ] };

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":{"b":2}} trailing'), { a: { b: 2 } });
  assert.deepEqual(extractJson({ already: true }), { already: true });
  assert.throws(() => extractJson('no json here'));
});

test('normaliseSign cleans and pads values', () => {
  const { sign } = normaliseSign(sample, { council: 'melbourne' });
  assert.equal(sign.panels.length, 2);
  assert.equal(sign.panels[1].windows[0].start, '07:00');
  assert.equal(sign.panels[0].id, 'p1');
  assert.equal(sign.council, 'melbourne');
});

test('normaliseSign rejects junk and flags non-signs', () => {
  assert.throws(() => normaliseSign({ panels: [] }));
  assert.equal(normaliseSign({ isParkingSign: false }).sign, null);
  const { sign } = normaliseSign({ panels: [{ kind: 'bogus', side: 'up', windows: [{ days: [9, 1], start: 'x', end: null }] }] });
  assert.equal(sign.panels[0].kind, 'unknown'); assert.equal(sign.panels[0].side, 'both');
  assert.deepEqual(sign.panels[0].windows[0].days, [1]);
});

test('chat request carries the image and schema', () => {
  const req = buildChatRequest({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.equal(req.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.equal(req.response_format.json_schema.schema, SIGN_OUTPUT_SCHEMA);
  assert.equal(buildChatRequest({ imageBase64: 'A', jsonSchema: false }).response_format, undefined);
});

test('chatReplyText handles binding shapes', () => {
  assert.equal(chatReplyText({ response: '{"x":1}' }), '{"x":1}');
  assert.equal(chatReplyText({ response: { x: 1 } }), '{"x":1}');
  assert.equal(chatReplyText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(chatReplyText({ content: [{ type: 'text', text: 'ok' }] }), 'ok');
});
