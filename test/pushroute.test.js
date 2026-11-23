import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PUSH_ACTIONS, PUSH_CATEGORIES } from '../api/_push.js';
import { module as appModule } from './helpers/app.js';

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

test('visible push category toggles omit unshipped confirm and Coming soon copy while server schema keeps confirm', () => {
  assert.ok(PUSH_CATEGORIES.includes('confirm'), 'server default/schema preserves confirm');
  for (const [label, src] of [['src/app/push-notifications.js', readFileSync(path.join(root, 'src/app/push-notifications.js'), 'utf8')], ['dink-score.html', appModule('push-notifications')]]) {
    const cats = new Function(src + '\nreturn PUSH_CATS;')();
    const keys = cats.map(c => c[0]);
    assert.deepEqual(keys, ['nights', 'events', 'league'], `${label} only shows shipped push categories`);
    for (const [k, name, hint] of cats) {
      assert.ok(PUSH_CATEGORIES.includes(k), `${label} category ${k} is valid on the server`);
      assert.doesNotMatch(`${name} ${hint}`, /coming soon/i, `${label} has no Coming soon toggle`);
    }
  }
});

test('notifyCategory toggles visible categories, preserves hidden server categories, and announces state changes', async () => {
  const src = readFileSync(path.join(root, 'src/app/push-notifications.js'), 'utf8');
  const calls = [], announcements = [];
  const state = { clubSheet: { view: 'notify', st: { subscribed: true, categories: ['nights', 'confirm', 'events', 'league'] } } };
  const harness = new Function(
    'state', 'api', 'myName', 'myToken', 'owners', 'club', 'renderClub', 'announce', 'navigator', 'window',
    src.replace(/\bclubSheet\b/g, 'state.clubSheet') + '\nreturn { PUSH_CATS, notifyCategory };'
  )(
    state,
    async (route, opts) => { calls.push({ route, body: JSON.parse(opts.body) }); return { enabled: true }; },
    () => 'Ana',
    () => 'tok',
    { CLUB1: '' },
    { code: 'CLUB1' },
    () => {},
    msg => announcements.push(msg),
    { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/a1' }) } }) } },
    { PushManager: function () {}, Notification: function () {} }
  );

  await harness.notifyCategory('league', false);
  assert.deepEqual(calls.at(-1).body.categories.slice().sort(), ['confirm', 'events', 'nights']);
  assert.equal(announcements.at(-1), 'League notifications off.');

  // Fresh subscription (st.categories null -> server default includes confirm)
  state.clubSheet = { view: 'notify', st: { subscribed: true, categories: null } };
  await harness.notifyCategory('nights', false);
  assert.deepEqual(calls.at(-1).body.categories.slice().sort(), ['confirm', 'events', 'league']);
  assert.equal(announcements.at(-1), 'Game nights notifications off.');

  // Previously disabled confirm stays off when another category changes
  state.clubSheet = { view: 'notify', st: { subscribed: true, categories: ['nights', 'events', 'league'] } };
  await harness.notifyCategory('events', false);
  assert.deepEqual(calls.at(-1).body.categories.slice().sort(), ['league', 'nights']);
  assert.equal(announcements.at(-1), 'Events and courts notifications off.');
});
