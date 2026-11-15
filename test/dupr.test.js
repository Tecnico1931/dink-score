import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDupr, duprFrom } from '../api/_dupr.js';

test('accepts ratings from 2 to 8 with up to 3 decimals', () => {
  for (const [raw, want] of [['3.52', 3.52], [' 4 ', 4], ['2', 2], ['8.000', 8], ['2.000', 2], ['5.125', 5.125], [3.5, 3.5], ['3,52', 3.52], ['7.9', 7.9]]) assert.equal(cleanDupr(raw), want, String(raw));
});
test('empty input clears it', () => {
  for (const raw of ['', '   ', null, undefined]) assert.equal(cleanDupr(raw), null);
});
test('rejects out of range, too many decimals and non-numbers', () => {
  for (const raw of ['1.99', '8.001', '9', '0', '-3', '3.5217', 'abc', '3.5.2', '1e1', '0x4', 'NaN', 'Infinity', '3.', '.5', '3 5', {}]) assert.throws(() => cleanDupr(raw), /DUPR/, String(raw));
});
test('database values convert back to numbers', () => {
  assert.equal(duprFrom('3.520'), 3.52);
  assert.equal(duprFrom(null), null);
});
