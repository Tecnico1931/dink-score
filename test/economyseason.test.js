import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEASONS, SEASONAL, seasonFor, isAvailable, closedMessage, eventClosedMessage } from '../api/_economyseason.js';
import { CATALOGUE, itemById, planBuy, clubLooksFrom } from '../api/_economyshop.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fixed injected clocks only (UTC instants); nothing here reads the system clock.
const at = s => Date.parse(s);
const earn = n => ({ id: 'day:2026-01-' + String(n).padStart(2, '0'), kind: 'earn', amount: n, reason: 'day', day: null, streak: 1 });

test('the seasonal list is small, fixed-price, cosmetic-only, outside CATALOGUE and has every season', () => {
  assert.ok(SEASONAL.length >= 4 && SEASONAL.length <= 6);
  for (const i of SEASONAL) {
    assert.deepEqual(Object.keys(i).sort(), ['id', 'name', 'price', 'season', 'slot']);
    assert.ok(['frame', 'paddle'].includes(i.slot) && i.id.startsWith(i.slot + '-'));
    assert.match(i.id, /^[a-z]{3,8}-[a-z]{3,12}$/, 'a plain look name the stylesheet can use');
    assert.ok(Number.isInteger(i.price) && i.price >= 1 && i.price <= 30);
    assert.ok(SEASONS.some(s => s.id === i.season));
    assert.ok(!CATALOGUE.some(c => c.id === i.id), 'never in CATALOGUE, so never in the box or the pass');
    assert.equal(itemById(i.id), i, 'but the shop still finds it');
  }
  assert.equal(new Set(SEASONAL.map(i => i.id)).size, SEASONAL.length);
  assert.deepEqual([...new Set(SEASONAL.map(i => i.season))].sort(), SEASONS.map(s => s.id).sort(), 'every season has something');
});

test('seasonFor: calendar seasons in UTC at the exact boundaries', () => {
  const id = s => seasonFor(at(s)).id;
  assert.equal(id('2026-02-28T23:59:59Z'), 'winter');
  assert.equal(id('2026-03-01T00:00:00Z'), 'spring');
  assert.equal(id('2026-05-31T23:59:59Z'), 'spring');
  assert.equal(id('2026-06-01T00:00:00Z'), 'summer');
  assert.equal(id('2026-08-31T23:59:59Z'), 'summer');
  assert.equal(id('2026-09-01T00:00:00Z'), 'autumn');
  assert.equal(id('2026-11-30T23:59:59Z'), 'autumn');
  assert.equal(id('2026-12-01T00:00:00Z'), 'winter');
});

test('winter crosses new year and the leap day, and its window is one block', () => {
  const dec = seasonFor(at('2026-12-15T12:00:00Z')), jan = seasonFor(at('2027-01-10T12:00:00Z')), feb = seasonFor(at('2027-02-28T23:59:59Z'));
  for (const w of [dec, jan, feb]) { assert.equal(w.id, 'winter'); assert.equal(w.startsOn, '2026-12-01'); assert.equal(w.endsOn, '2027-02-28'); }
  assert.equal(seasonFor(at('2027-03-01T00:00:00Z')).id, 'spring');
  const leap = seasonFor(at('2028-02-29T12:00:00Z'));
  assert.equal(leap.id, 'winter'); assert.equal(leap.startsOn, '2027-12-01'); assert.equal(leap.endsOn, '2028-02-29');
  assert.equal(seasonFor(at('2028-03-01T00:00:00Z')).id, 'spring');
  assert.equal(dec.endMs - dec.startMs, (31 + 31 + 28) * 86400000);
});

test('the season is the same every year, so nothing is permanently missed', () => {
  for (const y of [2026, 2027, 2031]) {
    assert.equal(seasonFor(at(`${y}-04-10T08:00:00Z`)).id, 'spring');
    assert.equal(seasonFor(at(`${y}-07-10T08:00:00Z`)).id, 'summer');
    assert.equal(seasonFor(at(`${y}-10-10T08:00:00Z`)).id, 'autumn');
  }
  for (const item of SEASONAL) {
    assert.equal(isAvailable(item, at('2026-04-10T08:00:00Z')), isAvailable(item, at('2027-04-10T08:00:00Z')));
    const on = [2026, 2027, 2028].filter(y => [`${y}-01-15`, `${y}-04-15`, `${y}-07-15`, `${y}-10-15`].some(d => isAvailable(item, at(d + 'T12:00:00Z'))));
    assert.equal(on.length, 3, `${item.id} is on sale every year`);
  }
});

test('the boundary is UTC: US DST changes and far time zones move nothing', () => {
  // US spring-forward (2026-03-08) and fall-back (2026-11-01) fall inside a season, never on its edge: the season does not move.
  assert.equal(seasonFor(at('2026-03-08T07:30:00Z')).id, 'spring');
  assert.equal(seasonFor(at('2026-11-01T05:59:59Z')).id, 'autumn');
  assert.equal(seasonFor(at('2026-11-01T06:00:00Z')).id, 'autumn');
  // 2026-03-01 00:00 in UTC+14 is still 2026-02-28 10:00 UTC: winter; 2026-02-28 23:00 in UTC-12 is already 2026-03-01 11:00 UTC: spring.
  assert.equal(seasonFor(at('2026-02-28T10:00:00Z')).id, 'winter');
  assert.equal(seasonFor(at('2026-03-01T11:00:00Z')).id, 'spring');
  // The same instant given as a Date gives the same answer.
  assert.deepEqual(seasonFor(new Date('2026-09-01T00:00:00Z')), seasonFor(at('2026-09-01T00:00:00Z')));
  assert.throws(() => seasonFor(NaN));
});

test('plain-words dates and a plain return line; no countdown or urgency wording', () => {
  const a = seasonFor(at('2026-11-23T10:00:00Z'));
  assert.equal(a.dates, '1 September to 30 November (UTC)');
  assert.equal(a.returns, 'Autumn Clay returns every September. Anything you already have stays yours.');
  assert.equal(seasonFor(at('2027-01-05T10:00:00Z')).dates, '1 December to the last day of February (UTC)');
  for (const s of SEASONS) {
    const w = seasonFor(at(`2026-${String(s.months[0] + 1).padStart(2, '0')}-10T10:00:00Z`));
    const words = [w.dates, w.returns, ...SEASONAL.map(closedMessage)].join(' ');
    assert.ok(!/hurry|last chance|limited|only \d|ends in|countdown|don'?t miss|running out|rare|exclusive|now or never|\d+ (days?|hours?) left/i.test(words), words);
  }
});

test('planBuy: on sale in its season at one fixed price, refused plainly outside it, owned stays owned', () => {
  const frame = itemById('frame-clay');
  assert.equal(planBuy([earn(20)], [], 'frame-clay', at('2026-11-23T10:00:00Z')).entry.amount, -frame.price);
  assert.equal(planBuy([earn(20)], [], 'frame-clay', at('2026-09-01T00:00:00Z')).entry.amount, -frame.price, 'same price on the first day');
  assert.equal(planBuy([earn(20)], [], 'frame-clay', at('2026-11-30T23:59:59Z')).entry.amount, -frame.price, 'and on the last second');
  for (const when of ['2026-12-01T00:00:00Z', '2027-03-15T10:00:00Z', '2026-08-31T23:59:59Z']) {
    assert.throws(() => planBuy([earn(20)], [], 'frame-clay', at(when)), e => e.status === 409 && /Autumn Clay/.test(e.message) && /comes back every year/.test(e.message), when);
  }
  // Out of season but already owned: a replay charges nothing and is not refused.
  assert.deepEqual(planBuy([earn(20)], ['frame-clay'], 'frame-clay', at('2027-03-15T10:00:00Z')), { item: frame, already: true });
  // A permanent item is unaffected by the date.
  assert.ok(planBuy([earn(99)], [], 'frame-court', at('2027-03-15T10:00:00Z')).entry);
  // Same item, next year: on sale again at the same price.
  assert.equal(planBuy([earn(20)], [], 'frame-clay', at('2027-10-05T10:00:00Z')).entry.amount, -frame.price);
});

test('an owned seasonal item stays wearable and visible to the club after its window', () => {
  const looks = clubLooksFrom([{ name_key: 'ana', slot: 'frame', item: 'frame-clay' }, { name_key: 'ana', slot: 'paddle', item: 'paddle-frost' }], at('2027-06-01T00:00:00Z'));
  assert.deepEqual(looks, { ana: { frame: 'frame-clay', paddle: 'paddle-frost' } });
});

test('the phone draws the season from the server and has no timer, no random and no hard-coded colour', () => {
  const ui = fs.readFileSync(path.join(root, 'src/app/economyshop.js'), 'utf8');
  const fn = ui.slice(ui.indexOf('function rwSeasonHTML'), ui.indexOf('let rwBoxSeq'));
  assert.ok(fn.includes('se.dates') && fn.includes('se.returns') && fn.includes('data-rw-buy'));
  assert.ok(!/setInterval|setTimeout|Date\.now|new Date|Math\.random|#[0-9a-f]{3,8}\b/i.test(fn));
  const html = fs.readFileSync(path.join(root, 'dink-score.html'), 'utf8');
  const css = html.slice(html.indexOf('/* Seasonal looks'), html.indexOf('[data-rw-skin="court"]'));
  for (const i of SEASONAL) assert.ok(css.includes(`[data-rw-${i.slot === 'frame' ? 'frame' : 'skin'}="${i.id.replace(/^[a-z]+-/, '')}"]`), i.id + ' has a look');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(css), 'tokens only');
});

// ---------- Events (WI-12) ----------
import { EVENTS, EVENT_ITEMS, SCHEDULE, eventFor, scheduleProblems } from '../api/_economyseason.js';
import { SLOTS } from '../api/_economyshop.js';

test('events: a fixed, cosmetic, rarity-labelled list outside CATALOGUE, in existing slots, on a plain look name', () => {
  assert.ok(EVENTS.length >= 1);
  for (const i of EVENT_ITEMS) {
    assert.ok(SLOTS.includes(i.slot));
    assert.match(i.id, /^[a-z]{3,8}-[a-z]{3,12}$/);
    assert.ok(Number.isInteger(i.price) && i.price >= 1 && ['common', 'rare', 'legendary', 'mythic'].includes(i.rarity));
    assert.ok(!CATALOGUE.some(c => c.id === i.id) && !SEASONAL.some(c => c.id === i.id));
    assert.equal(itemById(i.id), i);
  }
  assert.equal(new Set(EVENT_ITEMS.map(i => i.id)).size, EVENT_ITEMS.length);
});

test('eventFor: Christmas runs 24 Nov to the end of 25 Dec 2026 in UTC as one run over two seasons, with an end date and no countdown', () => {
  const id = s => (eventFor(at(s)) || {}).id || null;
  assert.equal(id('2026-11-23T23:59:59Z'), null);
  assert.equal(id('2026-11-24T00:00:00Z'), 'christmas');
  assert.equal(id('2026-12-25T23:59:59Z'), 'christmas');
  assert.equal(id('2026-12-26T00:00:00Z'), null);
  assert.equal(id('2027-12-01T12:00:00Z'), null, 'not scheduled for 2027: no auto-rollover');
  assert.equal(id('2028-06-01T12:00:00Z'), null);
  const e = eventFor(at('2026-12-01T00:00:00Z'));
  assert.equal(e.startsOn, '2026-11-24'); assert.equal(e.endsOn, '2026-12-25');
  assert.equal(e.dates, '24 November to 25 December (UTC)');
  assert.ok(/end of 25 December \(UTC\).*yours to keep/.test(e.note));
  assert.equal(eventFor(at('2026-11-26T00:00:00Z')).endsOn, '2026-12-25', 'the autumn and winter windows read as one run');
  assert.ok(!/hurry|last chance|limited|only \d|ends in|countdown|don'?t miss|running out|\d+ (days?|hours?) left/i.test(e.note + closedMessage(EVENT_ITEMS[0])));
});

test('planBuy: an event item is bought only inside its window at one fixed price; owned stays owned and wearable', () => {
  const it = EVENT_ITEMS[0], big = [{ id: 'day:2026-01-01', kind: 'earn', amount: 5000, reason: 'day', day: null, streak: 1 }];
  assert.equal(planBuy(big, [], it.id, at('2026-12-10T10:00:00Z')).entry.amount, -it.price);
  for (const when of ['2026-11-23T10:00:00Z', '2026-12-26T00:00:00Z', '2027-03-01T10:00:00Z']) {
    assert.throws(() => planBuy(big, [], it.id, at(when)), e => e.status === 409 && /Christmas/.test(e.message) && /yours/.test(e.message) && !/every year/.test(e.message), when);
  }
  assert.deepEqual(planBuy(big, [it.id], it.id, at('2027-03-01T10:00:00Z')), { item: it, already: true });
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: it.slot, item: it.id }], at('2027-03-01T00:00:00Z')), { ana: { [it.slot]: it.id } });
});

test('the event shelf is drawn from the server, with no timer and no hard-coded colour; every event ring has a look', () => {
  const ui = fs.readFileSync(path.join(root, 'src/app/economyshop.js'), 'utf8');
  const fn = ui.slice(ui.indexOf('function rwEventHTML'), ui.indexOf('// One item card'));
  assert.ok(fn.includes('ev.note') && fn.includes('rwShelf'));
  assert.ok(!/setInterval|setTimeout|Date\.now|new Date|Math\.random|#[0-9a-f]{3,8}\b/i.test(fn));
  const html = fs.readFileSync(path.join(root, 'dink-score.html'), 'utf8');
  for (const i of EVENT_ITEMS.filter(x => x.slot === 'frame')) assert.ok(html.includes(`[data-rw-frame="${i.id.replace(/^[a-z]+-/, '')}"]`), i.id + ' has a look');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(html.slice(html.indexOf('/* Event shelf'), html.indexOf('/* Paddle colourways'))), 'tokens only');
});

// ---------- Events repeat inside a season; each new season is scheduled again (no auto-rollover) ----------
const W = (season, from, to, event = 'christmas') => ({ season, event, from, to });
const id = (s, sched) => (eventFor(at(s), sched) || {}).id || null;

test('the shipped schedule is valid: every window inside its own season key, no overlaps', () => {
  assert.deepEqual(scheduleProblems(), []);
  assert.ok(SCHEDULE.length >= 1 && SCHEDULE.every(r => /^[a-z]+-\d{4}$/.test(r.season)));
});

test('scheduleProblems catches an unknown event, bad or reversed dates, a window outside its season and overlaps', () => {
  const bad = rows => scheduleProblems(rows).join('|');
  assert.match(bad([W('winter-2026', '2026-12-01', '2026-12-05', 'easter')]), /unknown event/);
  assert.match(bad([W('winter-2026', '2026-12-31', '2027-02-30')]), /bad date/);
  assert.match(bad([W('winter-2026', '2026-12-10', '2026-12-05')]), /ends before/);
  assert.match(bad([W('winter-2026', '2027-03-01', '2027-03-05')]), /not inside winter-2026/);
  assert.match(bad([W('winter-2026', '2026-11-28', '2026-12-05')]), /not inside winter-2026/, 'a window may not straddle two seasons');
  assert.match(bad([W('winter-2026', '2026-12-01', '2026-12-10'), W('winter-2026', '2026-12-10', '2026-12-12')]), /overlaps/);
  assert.deepEqual(scheduleProblems([W('winter-2026', '2026-12-01', '2026-12-10'), W('winter-2026', '2027-01-05', '2027-01-07')]), []);
});

test('an event can run in several windows inside one season, with the gap shut and each end shown as a date', () => {
  const two = [W('winter-2026', '2026-12-01', '2026-12-10'), W('winter-2026', '2027-01-05', '2027-01-07')];
  assert.deepEqual(scheduleProblems(two), []);
  for (const [when, want] of [['2026-11-30T23:59:59Z', null], ['2026-12-01T00:00:00Z', 'christmas'], ['2026-12-10T23:59:59Z', 'christmas'], ['2026-12-11T00:00:00Z', null],
    ['2026-12-31T12:00:00Z', null], ['2027-01-05T00:00:00Z', 'christmas'], ['2027-01-07T23:59:59Z', 'christmas'], ['2027-01-08T00:00:00Z', null]]) assert.equal(id(when, two), want, when);
  assert.equal(eventFor(at('2026-12-05T00:00:00Z'), two).endsOn, '2026-12-10');
  assert.equal(eventFor(at('2027-01-06T00:00:00Z'), two).endsOn, '2027-01-07');
  assert.match(eventFor(at('2027-01-06T00:00:00Z'), two).note, /end of 7 January \(UTC\)/);
  // the shop can buy in both windows and is shut between them; the refusal names the next window of this season
  const it = EVENT_ITEMS[0], big = [{ id: 'day:2026-01-01', kind: 'earn', amount: 5000, reason: 'day', day: null, streak: 1 }];
  assert.match(eventClosedMessage(it, at('2026-12-20T00:00:00Z'), two), /next on from 5 January to 7 January \(UTC\).*yours/);
  assert.match(eventClosedMessage(it, at('2027-01-20T00:00:00Z'), two), /not on right now.*yours/, 'no later window: not scheduled');
  assert.ok(big.length);
});

test('a new season has no scheduled events until they are scheduled again (no auto-rollover)', () => {
  const sched = [W('winter-2026', '2026-12-01', '2026-12-10'), W('winter-2026', '2027-01-05', '2027-01-07')];
  assert.equal(id('2026-12-05T00:00:00Z', sched), 'christmas');
  // the same month-days a year on, the next winter, the following spring: nothing carried over
  for (const when of ['2027-12-05T00:00:00Z', '2028-01-06T00:00:00Z', '2027-03-15T00:00:00Z', '2027-09-15T00:00:00Z']) assert.equal(id(when, sched), null, when);
  // a row only counts while its own season key is the current one, even if its dates were hand-edited to fall in another season
  assert.equal(id('2027-03-15T00:00:00Z', [W('winter-2026', '2027-03-10', '2027-03-20')]), null);
  // scheduling the next season again switches it back on, for that season only
  const again = [...sched, W('winter-2027', '2027-12-01', '2027-12-10')];
  assert.equal(id('2027-12-05T00:00:00Z', again), 'christmas');
  assert.equal(id('2028-01-06T00:00:00Z', again), null);
  assert.equal(eventFor(at('2027-12-05T00:00:00Z'), again).season, 'winter-2027');
  assert.equal(seasonFor(at('2027-01-06T00:00:00Z')).key, 'winter-2026');
  // the shipped schedule: Christmas 2026 is on, the following winter is empty
  assert.equal(id('2026-12-10T00:00:00Z'), 'christmas');
  assert.equal(id('2027-12-10T00:00:00Z'), null);
  assert.equal(id('2028-01-06T00:00:00Z'), null);
});

test('items bought in a window stay owned and wearable after it ends and after the season changes', () => {
  const it = EVENT_ITEMS[0], big = [{ id: 'day:2026-01-01', kind: 'earn', amount: 5000, reason: 'day', day: null, streak: 1 }];
  const bought = planBuy(big, [], it.id, at('2026-12-10T10:00:00Z'));
  assert.equal(bought.entry.amount, -it.price);
  for (const when of ['2026-12-26T00:00:00Z', '2027-03-01T10:00:00Z', '2027-12-10T10:00:00Z']) {
    assert.deepEqual(planBuy(big, [it.id], it.id, at(when)), { item: it, already: true }, 'owned: no second charge, no refusal');
    assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: it.slot, item: it.id }], at(when)), { ana: { [it.slot]: it.id } }, 'still visible to the club');
    assert.throws(() => planBuy(big, [], it.id, at(when)), e => e.status === 409, 'a new buy is refused');
  }
});
