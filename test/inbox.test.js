import { test } from 'node:test';
import assert from 'node:assert/strict';
import { section, page } from './helpers/app.js';

const Inbox = new Function(section('INBOX') + '\nreturn Inbox;')();
const NOW = 1_000_000_000_000;
const night = (o = {}) => Object.assign({ id: 'n1', title: 'Thursday drills', startsAt: NOW + 864e5, location: 'Court 1', when: 'Fri 6:30 PM', mine: true }, o);
const snap = (o = {}) => Object.assign({ now: NOW, me: 'Ann', failed: 0, sync: 'idle', held: [], nights: null, events: null, leagues: null }, o);

test('first look records a source and makes no news', () => {
  const r = Inbox.step(null, snap({ nights: [night()], events: [{ id: 'e1', name: 'Open', status: 'live', round: 2 }], leagues: [{ id: 'l1', name: 'Fall', status: 'live', count: 4 }] }));
  assert.deepEqual(r.fresh, []);
  assert.equal(Inbox.count(r.needs, r.mem), 0);
  assert.deepEqual(Object.keys(r.mem.base).sort(), ['events', 'leagues', 'nights']);
});

test('a night not answered yet needs you; answering clears it', () => {
  const a = Inbox.step(null, snap({ nights: [night({ mine: false })] }));
  assert.deepEqual(a.needs.map(n => n.id), ['rsvp:n1']);
  assert.equal(a.needs[0].go, 'nights');
  assert.equal(Inbox.step(a.mem, snap({ nights: [night()] })).needs.length, 0);
  assert.equal(Inbox.step(null, snap({ me: null, nights: [night({ mine: false })] })).needs.length, 0, 'no claimed name, nothing to answer for');
});

test('a new, changed or cancelled night becomes news, once', () => {
  const base = Inbox.step(null, snap({ nights: [night()] })).mem;
  const changed = Inbox.step(base, snap({ nights: [night({ startsAt: NOW + 2 * 864e5 })] }));
  assert.deepEqual(changed.fresh.map(x => x.title), ['Game night changed']);
  const again = Inbox.step(changed.mem, snap({ nights: [night({ startsAt: NOW + 2 * 864e5 })] }));
  assert.deepEqual(again.fresh, []);
  assert.equal(again.mem.log.length, 1);
  const added = Inbox.step(again.mem, snap({ nights: [night({ startsAt: NOW + 2 * 864e5 }), night({ id: 'n2', title: 'Ladder night' })] }));
  assert.deepEqual(added.fresh.map(x => x.title), ['New game night']);
  const gone = Inbox.step(added.mem, snap({ nights: [night({ id: 'n2', title: 'Ladder night' })] }));
  assert.deepEqual(gone.fresh.map(x => [x.title, x.body]), [['Game night cancelled', 'Thursday drills']]);
  const past = Inbox.step(gone.mem, snap({ now: NOW + 9 * 864e5, nights: [] }));
  assert.deepEqual(past.fresh, [], 'a night that simply passed is not a cancellation');
});

test('events: a round going live and a finish are news', () => {
  const base = Inbox.step(null, snap({ events: [{ id: 'e1', name: 'Open', status: 'live', round: 1 }] })).mem;
  const r2 = Inbox.step(base, snap({ events: [{ id: 'e1', name: 'Open', status: 'live', round: 2 }] }));
  assert.deepEqual(r2.fresh.map(x => [x.title, x.go]), [['Round 2 is live', 'event:e1']]);
  const done = Inbox.step(r2.mem, snap({ events: [{ id: 'e1', name: 'Open', status: 'done', round: 2 }, { id: 'e2', name: 'Cup', status: 'live', round: 1 }] }));
  assert.deepEqual(done.fresh.map(x => x.title).sort(), ['Event finished', 'Round 1 is live']);
});

test('leagues: new results and a finish are news; a source not loaded yet changes nothing', () => {
  const base = Inbox.step(null, snap({ leagues: [{ id: 'l1', name: 'Fall', status: 'live', count: 4 }] })).mem;
  assert.deepEqual(Inbox.step(base, snap({ leagues: null })).fresh, []);
  const r = Inbox.step(base, snap({ leagues: [{ id: 'l1', name: 'Fall', status: 'live', count: 6 }] }));
  assert.deepEqual(r.fresh.map(x => [x.title, x.body]), [['League results in', 'Fall: 2 new results']]);
  const f = Inbox.step(r.mem, snap({ leagues: [{ id: 'l1', name: 'Fall', status: 'done', count: 6 }] }));
  assert.deepEqual(f.fresh.map(x => x.title), ['League finished']);
});

test('games to confirm, refused changes and a sync problem need you', () => {
  const r = Inbox.step(null, snap({ held: [{ id: 'g1', label: 'Ann & Bo 11–8 Cy & Di' }], failed: 2 }));
  assert.deepEqual(r.needs.map(n => [n.id, n.go]), [['confirm:g1', 'history'], ['failed', 'club']]);
  assert.equal(r.needs[1].title, '2 changes need attention');
  assert.deepEqual(Inbox.step(null, snap({ sync: 'error' })).needs.map(n => n.id), ['sync']);
  assert.deepEqual(Inbox.step(null, snap({ sync: 'offline' })).needs, [], 'offline is normal at a court');
});

test('unread count, reading, the label and the announcement', () => {
  const base = Inbox.step(null, snap({ events: [{ id: 'e1', name: 'Open', status: 'live', round: 1 }] })).mem;
  const r = Inbox.step(base, snap({ events: [{ id: 'e1', name: 'Open', status: 'live', round: 2 }], failed: 1 }));
  assert.equal(Inbox.count(r.needs, r.mem), 2);
  assert.equal(Inbox.label(2), 'Notifications, 2 new');
  assert.equal(Inbox.label(0), 'Notifications');
  Inbox.markRead(r.mem);
  assert.equal(Inbox.count(r.needs, r.mem), 1, 'a read item stays in the list; a thing that still waits keeps the count');
  assert.equal(r.mem.log.length, 1);
  assert.equal(Inbox.say([]), '');
  assert.equal(Inbox.say(r.fresh), 'New in your inbox: Round 2 is live');
  assert.equal(Inbox.say([1, 2, 3].map(() => ({ title: 'x' }))), '3 new in your inbox');
});

test('the log is capped, and damaged storage counts as empty', () => {
  let mem = Inbox.step(null, snap({ events: [] })).mem;
  for (let i = 0; i < 40; i++) mem = Inbox.step(mem, snap({ events: [{ id: 'e' + i, name: 'E' + i, status: 'live', round: 1 }] })).mem;
  assert.equal(mem.log.length, Inbox.KEEP);
  for (const bad of [null, 'x', 5, [], { log: 'x', fp: [], ev: 3, base: null }, { log: [null, { id: 1 }, { id: 'a', title: 'T' }] }]) {
    const m = Inbox.parse(bad);
    assert.ok(Array.isArray(m.log) && m.log.every(x => typeof x.id === 'string' && Number.isFinite(x.at)));
    assert.doesNotThrow(() => Inbox.step(bad, snap({ nights: [night()] })));
  }
});

test('ago words', () => {
  assert.equal(Inbox.ago(NOW, NOW), 'Just now');
  assert.equal(Inbox.ago(NOW - 5 * 60000, NOW), '5 min ago');
  assert.equal(Inbox.ago(NOW - 3 * 3600000, NOW), '3 h ago');
  assert.equal(Inbox.ago(NOW - 2 * 864e5, NOW), '2 d ago');
});

test('the page wires the bell between the club chip and the avatar, with an accessible name and the inbox sheet', () => {
  const html = page();
  assert.match(html, /\$\{syncPillHTML\(\)\}\$\{bellButtonHTML\(\)\}\$\{profileButtonHTML\(\)\}/);
  assert.match(html, /<div id="sheet11"><\/div>/);
  assert.match(html, /aria-label="\$\{Inbox\.label\(n\)\}"/);
  assert.match(html, /\.bell-btn \{[^}]*width: 44px; height: 44px/);
  assert.match(html, /announce\(Inbox\.say\(said\)\)/);
  assert.match(html, /e\.key === 'Escape' && inboxOpen/);
});
