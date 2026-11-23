import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEASONS, SEASONAL, seasonFor, isAvailable, closedMessage } from '../api/_economyseason.js';
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
  assert.ok(planBuy([earn(20)], [], 'frame-court', at('2027-03-15T10:00:00Z')).entry);
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
