// Pure rules for asking an organizer to approve (api/_approvals.js): request state, input checks and the push text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_ACTIONS, APPROVAL_TTL_SECONDS, requestState, cleanDecision, cleanAskToken, requestMessage } from '../api/_approvals.js';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const row = (status, offsetMs) => ({ status, expires_at: new Date(NOW + offsetMs).toISOString() });

test('requestState: pending until its time is up, then expired; a decision stands whatever the clock says', () => {
  assert.equal(requestState(row('pending', 60_000), NOW), 'pending');
  assert.equal(requestState(row('pending', 0), NOW), 'expired', 'the moment it runs out');
  assert.equal(requestState(row('pending', -60_000), NOW), 'expired');
  assert.equal(requestState(row('approved', -60_000), NOW), 'approved');
  assert.equal(requestState(row('denied', -60_000), NOW), 'denied');
});

test('a request is short-lived: 15 minutes', () => assert.equal(APPROVAL_TTL_SECONDS, 900));

test('cleanDecision: approve or deny, nothing else', () => {
  assert.equal(cleanDecision(' Approve '), 'approve');
  assert.equal(cleanDecision('DENY'), 'deny');
  for (const bad of ['', 'maybe', undefined, null, 1]) assert.throws(() => cleanDecision(bad), e => e.status === 400);
});

test('cleanAskToken: the same shape as a player token (48 hex), lower-cased', () => {
  const t = 'AB'.repeat(24);
  assert.equal(cleanAskToken(t), t.toLowerCase());
  for (const bad of ['', 'abc', 'g'.repeat(48), 'a'.repeat(47), 'a'.repeat(49), undefined]) assert.throws(() => cleanAskToken(bad), e => e.status === 400);
});

test('requestMessage: names the player as typed, cut short, and never a club', () => {
  const m = requestMessage('Ana Ruiz');
  assert.equal(m.title, 'Approval needed');
  assert.match(m.body, /^Someone asks to link Ana Ruiz to a new phone\./);
  assert.ok(requestMessage('x'.repeat(200)).body.length < 120);
});

test('the actions are routed through /api/players, not a new function', () => {
  assert.deepEqual(APPROVAL_ACTIONS, ['approval-request', 'approval-status', 'approval-decide']);
});
