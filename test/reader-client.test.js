import test from 'node:test';
import assert from 'node:assert/strict';
import { jobUrl } from '../src/reader/claude.js';

test('job url keeps host, prefix and token', () => {
  assert.equal(jobUrl('https://mac.ts.net/streetparking/api/read-sign?token=abc', 'deadbeef0001'), 'https://mac.ts.net/streetparking/api/read-sign/jobs/deadbeef0001?token=abc');
  assert.equal(jobUrl('http://127.0.0.1:8765/api/read-sign', 'x'), 'http://127.0.0.1:8765/api/read-sign/jobs/x');
});
