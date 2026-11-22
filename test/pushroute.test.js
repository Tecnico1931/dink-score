import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PUSH_ACTIONS } from '../api/_push.js';

// The Notifications sheet showed "Unknown action" because the client posted push-* to /api/players while only
// /api/live dispatches them. tools/push-check.mjs drives the live handler; this pins the client's route to it.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'dink-score.html'), 'utf8');
const sent = [...html.matchAll(/(\w+)\(pushCreds\(\{ action: '(push-[a-z]+)'/g)];

test('the client sends every push action through a sender that posts to the route that handles it', () => {
  assert.deepEqual([...new Set(sent.map(m => m[2]))].sort(), ['push-categories', 'push-status', 'push-subscribe', 'push-unsubscribe']);
  for (const [, fn, action] of sent) {
    assert.ok(PUSH_ACTIONS.includes(action), action);
    assert.equal(fn, 'pushCall', `${action} must go through pushCall, not ${fn}`);
  }
  assert.match(html, /const pushCall = body => api\('live', \{ method: 'POST'/);
});

test('api/live.js dispatches PUSH_ACTIONS and api/players.js does not', () => {
  assert.match(readFileSync(path.join(root, 'api/live.js'), 'utf8'), /PUSH_ACTIONS\.includes\(body\.action\)\) return send\(res, 200, await pushAction\(/);
  assert.doesNotMatch(readFileSync(path.join(root, 'api/players.js'), 'utf8'), /PUSH_ACTIONS|pushAction/);
});
