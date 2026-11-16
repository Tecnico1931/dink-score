import test from 'node:test';
import assert from 'node:assert/strict';
import { netKey, lockSeconds, waitText } from '../api/_limits.js';

test('netKey: IPv4 as is, IPv6 collapses to its /64, mapped IPv4 is IPv4', () => {
  assert.equal(netKey('203.0.113.7'), '203.0.113.7');
  assert.equal(netKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(netKey('2001:db8:1:2:aaaa::1'), netKey('2001:DB8:1:2::ffff'));
  assert.notEqual(netKey('2001:db8:1:2::1'), netKey('2001:db8:1:3::1'));
});
test('lockSeconds: free tries, then doubling up to the cap', () => {
  assert.equal(lockSeconds(2, 3, 10, 100), 0);
  assert.equal(lockSeconds(3, 3, 10, 100), 10);
  assert.equal(lockSeconds(5, 3, 10, 100), 40);
  assert.equal(lockSeconds(50, 3, 10, 100), 100);
});
test('waitText', () => { assert.equal(waitText(30), '30 seconds'); assert.equal(waitText(900), '15 minutes'); });
