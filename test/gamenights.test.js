// Pure rules for game nights (api/_gamenights.js): input validation, RSVP formatting and push reminder messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNightInput, cleanRsvpStatus, cleanAudience,
  formatNight, formatReminderWhen, nightReminderMessages
} from '../api/_gamenights.js';

const NOW = Date.UTC(2026, 10, 20, 15, 0, 0); // 2026-11-20 15:00 UTC

test('cleanNightInput: validates title, future date, optional location, note and cap', () => {
  const ok = cleanNightInput({
    title: '  Tuesday\t open  play ',
    startsAt: NOW + 864e5,
    location: ' West Park, Courts 1-3 ',
    note: 'Bring outdoor balls.\r\n\r\n\r\n\r\nWarmup at 6:15.',
    cap: '12'
  }, { now: NOW });
  assert.equal(ok.title, 'Tuesday open play');
  assert.equal(ok.startsAt, NOW + 864e5);
  assert.equal(ok.location, 'West Park, Courts 1-3');
  assert.equal(ok.note, 'Bring outdoor balls.\n\n\nWarmup at 6:15.');
  assert.equal(ok.cap, 12);

  const bare = cleanNightInput({ title: 'Friday lights', startsAt: NOW + 3600_000, cap: '' }, { now: NOW });
  assert.equal(bare.location, '');
  assert.equal(bare.note, '');
  assert.equal(bare.cap, null);
});

test('cleanNightInput: refuses missing title, past dates on create, too-far dates and bad caps', () => {
  assert.throws(() => cleanNightInput({ title: '   ', startsAt: NOW + 3600_000 }, { now: NOW }), e => e.status === 400);
  assert.throws(() => cleanNightInput({ title: 'Past', startsAt: NOW - 10 * 60_000 }, { now: NOW }), e => e.status === 400);
  // Edits allow up to 12h grace for an evening already started, still refuse older dates.
  assert.equal(cleanNightInput({ title: 'Tonight', startsAt: NOW - 2 * 3600_000 }, { now: NOW, edit: true }).title, 'Tonight');
  assert.throws(() => cleanNightInput({ title: 'Old', startsAt: NOW - 24 * 3600_000 }, { now: NOW, edit: true }), e => e.status === 400);
  assert.throws(() => cleanNightInput({ title: 'Too far', startsAt: NOW + 400 * 864e5 }, { now: NOW }), e => e.status === 400);
  for (const badCap of [0, 1, 129, 4.5, 'abc']) {
    assert.throws(() => cleanNightInput({ title: 'Bad cap', startsAt: NOW + 3600_000, cap: badCap }, { now: NOW }), e => e.status === 400, String(badCap));
  }
  assert.throws(() => cleanNightInput({ title: 'Long loc', startsAt: NOW + 3600_000, location: 'x'.repeat(81) }, { now: NOW }), e => e.status === 400);
  assert.throws(() => cleanNightInput({ title: 'Long note', startsAt: NOW + 3600_000, note: 'x'.repeat(301) }, { now: NOW }), e => e.status === 400);
});

test('cleanRsvpStatus and cleanAudience: accept only allowed values', () => {
  for (const v of ['in', 'IN', ' maybe ', 'out', 'none']) assert.ok(['in', 'maybe', 'out', 'none'].includes(cleanRsvpStatus(v)));
  for (const bad of ['', 'yes', 'no', null, undefined]) assert.throws(() => cleanRsvpStatus(bad), e => e.status === 400);
  assert.equal(cleanAudience(undefined), 'all');
  for (const v of ['all', 'going', 'in', 'unanswered']) assert.equal(cleanAudience(v), v);
  assert.throws(() => cleanAudience('everyone'), e => e.status === 400);
});

test('formatNight: groups RSVPs in order and computes counts', () => {
  const row = { id: 'gn-1', title: 'Tuesday play', starts_at: String(NOW + 864e5), location: 'Court 2', note: '', cap: 8, status: 'open', reminded_at: null, reminder_count: 0 };
  const rsvps = [
    { name: 'Ben', status: 'in', updated_at: new Date(NOW + 2000).toISOString() },
    { name: 'Ana', status: 'in', updated_at: new Date(NOW + 1000).toISOString() },
    { name: 'Cy', status: 'maybe', updated_at: new Date(NOW + 1500).toISOString() },
    { name: 'Di', status: 'out', updated_at: new Date(NOW + 3000).toISOString() }
  ];
  const n = formatNight(row, rsvps);
  assert.deepEqual(n.counts, { in: 2, maybe: 1, out: 1 });
  assert.deepEqual(n.rsvps, { in: ['Ana', 'Ben'], maybe: ['Cy'], out: ['Di'] });
  assert.equal(n.cap, 8);
  assert.equal(n.status, 'open');
});

test('formatReminderWhen: formats today, tomorrow and later dates in the given zone', () => {
  assert.match(formatReminderWhen(NOW + 3 * 3600_000, 'UTC', NOW), /^today at /);
  assert.match(formatReminderWhen(NOW + 24 * 3600_000, 'UTC', NOW), /^tomorrow at /);
  assert.match(formatReminderWhen(NOW + 5 * 864e5, 'America/New_York', NOW), /\bNov 25\b.*at /);
  assert.match(formatReminderWhen(NOW + 3 * 3600_000, 'Not/A_Zone', NOW), /^today at /);
});

test('nightReminderMessages: filters by audience, personalizes copy, and never includes club code/name', () => {
  const night = { id: 'gn-42', title: 'Tuesday lights', startsAt: NOW + 24 * 3600_000, location: 'Courts 1-2' };
  const members = [{ name: 'Ana', name_key: 'ana' }, { name: 'Ben', name_key: 'ben' }, { name: 'Cy', name_key: 'cy' }, { name: 'Di', name_key: 'di' }];
  const rsvps = [{ name_key: 'ana', status: 'in' }, { name_key: 'ben', status: 'maybe' }, { name_key: 'cy', status: 'out' }];

  const all = nightReminderMessages(night, members, rsvps, { audience: 'all', tz: 'UTC', now: NOW });
  assert.deepEqual([...all.keys()].sort(), ['Ana', 'Ben', 'Di']);
  assert.equal(all.get('Ana').title, 'Tuesday lights');
  assert.match(all.get('Ana').body, /^Ana, you're in for tomorrow at .*\(Courts 1-2\)\.$/);
  assert.match(all.get('Ben').body, /^Ben, still maybe for tomorrow at .*\(Courts 1-2\)\? Tap to update\.$/);
  assert.match(all.get('Di').body, /^Di, are you in for tomorrow at .*\(Courts 1-2\)\?$/);
  assert.equal(all.get('Ana').tag, 'night-gn-42');

  const going = nightReminderMessages(night, members, rsvps, { audience: 'going', tz: 'UTC', now: NOW });
  assert.deepEqual([...going.keys()].sort(), ['Ana', 'Ben']);

  const inOnly = nightReminderMessages(night, members, rsvps, { audience: 'in', tz: 'UTC', now: NOW });
  assert.deepEqual([...inOnly.keys()], ['Ana']);

  const unans = nightReminderMessages(night, members, rsvps, { audience: 'unanswered', tz: 'UTC', now: NOW });
  assert.deepEqual([...unans.keys()], ['Di']);
});
