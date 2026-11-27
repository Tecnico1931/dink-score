// Rewards pets (phase 1, #107): pure catalogue, growth stage boundaries, deterministic weekly shiny rotation across
// year (52-week and 53-week ISO) and DST boundaries, club-visible allow-list, and isolation guards.
// All time checks use fixed injected timestamps — never Date.now() offsets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PETS, petById, isPetId, utcDayKey,
  weekOf, shinyWeekFor, isShinyFeatured, petStateFor, cleanPetLook, SHINY_FIVE_FROM, SHINY_ALL_FROM
} from '../api/_economypets.js';
import {
  PET_LV, PET_STAGES, PETXP_FROM, PETXP_FROM_DAY, petLevelFor, petStageForLevel, legacyFloorXp, legacyPlayDays, playsByKeys, petXpOf
} from '../api/_economypetxp.js';
import { CATALOGUE, SLOTS, itemById, buyId, planBuy, wornFrom, clubLooksFrom } from '../api/_economyshop.js';
import { boxTiers } from '../api/_economybox.js';
import { weekOf as progressWeekOf } from '../api/_progress.js';
import { module } from './helpers/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const earnDay = (day, id = 'day:' + day) => ({ id, kind: 'earn', amount: 1, reason: 'day', day, streak: 1 });
const spendRow = (id, amount, day = null) => ({ id, kind: 'spend', amount: -amount, reason: 'shop', day, streak: null });
const nullDayEarn = (id, amount) => ({ id, kind: 'earn', amount, reason: 'pass:tier-1', day: null, streak: null });

test('pet catalogue: 12 fixed-price pets in CATALOGUE under slot pet, valid buy ids, excluded from random box draws', () => {
  assert.equal(PETS.length, 12);
  // The first five are the original pets and never move (the shiny rotation and owned rows key on them); WI-11 only appended.
  assert.deepEqual(PETS.map(p => p.id), ['pet-frog', 'pet-duck', 'pet-cat', 'pet-owl', 'pet-yorkie', 'pet-pup', 'pet-blob', 'pet-bat', 'pet-turtle', 'pet-fox', 'pet-netdragon', 'pet-supernova']);
  assert.deepEqual(petById('pet-yorkie'), { id: 'pet-yorkie', slot: 'pet', name: 'Yorkie', price: 400, rarity: 'rare' });
  // Upstream's names, prices and rarities (WI-11; the captain chose parity over the old 1-a-day scale).
  assert.deepEqual(PETS.filter(p => p.id !== 'pet-frog' && p.id !== 'pet-yorkie').map(p => [p.name, p.price, p.rarity]), [
    ['Dink duck', 200, 'common'], ['Kitchen cat', 500, 'rare'], ['Lob owl', 450, 'rare'], ['Pickle pup', 200, 'common'], ['Ball blob', 300, 'rare'],
    ['Paddle bat', 400, 'rare'], ['Court turtle', 250, 'common'], ['Smash fox', 600, 'rare'], ['Net dragon', 800, 'legendary'], ['Supernova dragon', 4800, 'mythic']]);
  assert.ok(SLOTS.includes('pet'));
  for (const p of PETS) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'name', 'price', 'rarity', 'slot']);
    assert.equal(p.slot, 'pet');
    assert.ok(p.id.startsWith('pet-'));
    assert.ok(Number.isInteger(p.price) && p.price >= 1 && p.price <= 5000);
    assert.deepEqual(itemById(p.id), p, 'pet lives in the single CATALOGUE constant');
    assert.deepEqual(petById(p.id), p);
    assert.equal(isPetId(p.id), true);
    assert.match(buyId(p), /^buy:pet-[a-z]{3,12}$/);
  }
  assert.equal(petById('frame-court'), null);
  assert.equal(isPetId('frame-court'), false);
  assert.equal(petById('pet-dragon'), null);

  // Pets are fixed-price only (the box draws them only in its own pet and legendary groups, never Mythic).
  const boxIds = new Set(boxTiers().flatMap(t => t.items.map(i => i.id)));
  for (const p of PETS) assert.equal(boxIds.has(p.id), p.rarity !== 'mythic', `${p.id} is a box prize unless Mythic`);

  // Purchase plans through the shared shop flow: idempotent buy:pet-* id, never below zero.
  const frog = petById('pet-frog');
  const funded = [earnDay('2026-01-01'), { id: 'seed:1', kind: 'earn', amount: frog.price - 1, reason: 'seed', day: null, streak: null }];
  const plan = planBuy(funded, [], 'pet-frog');
  assert.equal(plan.entry.id, 'buy:pet-frog');
  assert.equal(plan.entry.amount, -frog.price);
  assert.deepEqual(planBuy(funded, ['pet-frog'], 'pet-frog'), { item: frog, already: true });
  assert.throws(() => planBuy([earnDay('2026-01-01')], [], 'pet-frog'), e => e.status === 409 && /costs 200 and you have 1/.test(e.message));
});

test('pet levels: PET_LV thresholds, stages Grown at level 4 and Champion at level 8, clamping bad inputs', () => {
  assert.deepEqual([...PET_LV], [0, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
  assert.deepEqual(PET_STAGES.map(s => [s.stage, s.label, s.minLevel]), [[1, 'Rookie', 1], [2, 'Grown', 4], [3, 'Champion', 8]]);
  // Every threshold starts its level, one XP less is still the level before.
  PET_LV.forEach((xp, i) => {
    assert.equal(petLevelFor(xp).level, i + 1);
    if (i) assert.equal(petLevelFor(xp - 1).level, i);
  });
  assert.deepEqual(petLevelFor(4), { xp: 4, level: 2, max: 10, levelXp: 3, nextXp: 6 });
  assert.deepEqual(petLevelFor(55), { xp: 55, level: 10, max: 10, levelXp: 55, nextXp: null });
  assert.equal(petLevelFor(9999).level, 10);
  for (const bad of [-5, NaN, Infinity, null, undefined, 'x']) assert.deepEqual(petLevelFor(bad), { xp: 0, level: 1, max: 10, levelXp: 0, nextXp: 3 });
  assert.equal(petStageForLevel(3).label, 'Rookie');
  assert.equal(petStageForLevel(4).label, 'Grown');
  assert.equal(petStageForLevel(7).label, 'Grown');
  assert.equal(petStageForLevel(8).label, 'Champion');
  assert.equal(petStageForLevel(10).stage, 3);
  assert.equal(petLevelFor(PET_LV[3] - 1).level, 3);
  assert.equal(petStageForLevel(petLevelFor(PET_LV[3] - 1).level).stage, 1);
  assert.equal(petStageForLevel(petLevelFor(PET_LV[3]).level).stage, 2);
  assert.equal(petStageForLevel(petLevelFor(PET_LV[7] - 1).level).stage, 2);
  assert.equal(petStageForLevel(petLevelFor(PET_LV[7]).level).stage, 3);
});

test('pet XP: 1 per verified game, 2 per win, from adoption and from the switch day on; unverified, earlier and other players\' games give none', () => {
  const T0 = PETXP_FROM + 3600e3;
  const game = (over = {}) => ({ id: 'g' + Math.random(), teams: [['Ana', 'Ben'], ['Cy', 'Di']], winner: 0, scoredBy: 'ana', receivedAt: T0, ...over });
  const mine = k => playsByKeys([
    game(),                                        // ana wins (2)
    game({ winner: 1 }),                           // ana loses (1)
    game({ scoredBy: '', scoredByPlayer: undefined }), // not from a club player's phone: none
    game({ scoredBy: 'organizer' }),               // organizer phone: none
    game({ scoredBy: undefined, scoredByPlayer: 'ben' }), // the creating phone's own player: counts (2)
    game({ receivedAt: PETXP_FROM - 1 }),          // before the switch: none
    game({ teams: [['Zed', 'Yan'], ['Cy', 'Di']] }), // ana not in it
    game({ winner: '' })                           // no winner recorded: a game, not a win (1)
  ], [k]).get(k);
  assert.deepEqual(mine('ana').map(p => p.xp), [2, 1, 2, 1]);
  assert.deepEqual(mine('cy').map(p => p.xp), [1, 2, 1, 1, 1]);
  assert.equal(petXpOf(mine('ana'), 0, 0), 6);
  // Adopted after two of those games: only later ones count.
  assert.equal(petXpOf([{ r: T0, xp: 2 }, { r: T0 + 10, xp: 1 }, { r: T0 + 20, xp: 2 }], T0 + 10, 0), 3);
  assert.equal(petXpOf([], 0, 0), 0);
  assert.equal(petXpOf(undefined, NaN, 0), 0);
});

test('nobody loses progress: the old play-day stage is the starting point (Club = level 4, Veteran = level 8) and new XP adds on top', () => {
  const adoptedAt = '2026-02-10T18:30:00.000Z';
  assert.equal(utcDayKey(adoptedAt), '2026-02-10');
  assert.equal(utcDayKey(Date.UTC(2026, 1, 10, 23, 59, 59)), '2026-02-10');
  assert.equal(utcDayKey('2026-02-10'), '2026-02-10');
  assert.equal(utcDayKey('not-a-date'), '');
  const days = ledger => legacyPlayDays(ledger, utcDayKey(adoptedAt));

  const base = [
    earnDay('2026-02-08'), earnDay('2026-02-09'),               // before adoption: ignored
    earnDay('2026-02-10'), earnDay('2026-02-10', 'm:old:day:2026-02-10'), // adoption day + a merge duplicate: once
    spendRow('buy:pet-frog', 12, null), spendRow('box:abc12345', 7, '2026-02-11'), nullDayEarn('boxref:abc12345', 4), nullDayEarn('pass:2026-Q1:1', 2),
    { id: 'bad:row', kind: 'earn', amount: 1, reason: 'bad', day: '2026/02/12', streak: null },
    earnDay('2026-02-11'), earnDay('2026-02-12'), earnDay('2026-02-15'),
    earnDay(PETXP_FROM_DAY), earnDay('2030-01-01')              // the switch day and later are XP now, not play days
  ];
  assert.equal(days(base), 4);
  assert.equal(legacyFloorXp(4), 0);
  assert.equal(legacyFloorXp(5), PET_LV[3]);
  assert.equal(legacyFloorXp(14), PET_LV[3]);
  assert.equal(legacyFloorXp(15), PET_LV[7]);
  for (const bad of [-1, NaN, null, undefined]) assert.equal(legacyFloorXp(bad), 0);

  const row = { id: 'pet-frog', item: 'pet-frog', slot: 'pet', worn: true, at: adoptedAt };
  const at = ledger => petStateFor(row, ledger, Date.UTC(2026, 1, 20));
  assert.deepEqual([at(base).stage, at(base).stageLabel, at(base).level, at(base).xp], [1, 'Rookie', 1, 0]);

  const five = [...base, earnDay('2026-02-16')];
  assert.equal(days(five), 5);
  assert.deepEqual([at(five).stage, at(five).stageLabel, at(five).level, at(five).xp, at(five).levelXp, at(five).nextXp], [2, 'Grown', 4, 10, 10, 15]);

  const fourteen = [...five]; for (let d = 17; d <= 25; d++) fourteen.push(earnDay(`2026-02-${d}`));
  assert.equal(days(fourteen), 14);
  assert.equal(at(fourteen).stageLabel, 'Grown');
  const fifteen = [...fourteen, earnDay('2026-02-26')];
  assert.equal(days(fifteen), 15);
  assert.deepEqual([at(fifteen).stage, at(fifteen).stageLabel, at(fifteen).level, at(fifteen).xp, at(fifteen).nextXp], [3, 'Champion', 8, 36, 45]);

  // New XP adds on top of the starting point; a Rookie with no old days climbs from zero.
  const plays = [{ r: PETXP_FROM + 1, xp: 2 }, { r: PETXP_FROM + 2, xp: 1 }];
  assert.deepEqual([petStateFor(row, five, 0, plays).xp, petStateFor(row, five, 0, plays).level], [13, 4]);
  assert.deepEqual([petStateFor(row, fifteen, 0, plays).xp, petStateFor(row, fifteen, 0, plays).level], [39, 8]);
  assert.equal(petStateFor(row, base, 0, plays).xp, 3);
  const top = petStateFor(row, fifteen, 0, Array.from({ length: 30 }, (_, i) => ({ r: PETXP_FROM + i, xp: 2 })));
  assert.deepEqual([top.level, top.nextXp, top.stageLabel], [10, null, 'Champion']);
  // A pet adopted after the switch has no old days at all.
  assert.equal(petStateFor({ ...row, at: new Date(PETXP_FROM + 5e3).toISOString() }, fifteen, 0, []).xp, 0);
  assert.equal(petStateFor({ id: 'pet-nope' }, [], 0), null);
});

test('weekOf and shinyWeekFor: deterministic 4-week rotation across Monday, 52-week/53-week year and DST boundaries', () => {
  // Exact Monday 00:00 UTC boundary: Sunday 23:59:59.999 vs Monday 00:00:00.000.
  const sunEnd = Date.UTC(2026, 2, 1, 23, 59, 59, 999); // Sun 2026-03-01 (end of 2026-W09)
  const monStart = Date.UTC(2026, 2, 2, 0, 0, 0, 0);    // Mon 2026-03-02 (start of 2026-W10)
  const wSun = weekOf(sunEnd), wMon = weekOf(monStart);
  assert.equal(wSun.id, '2026-W09');
  assert.equal(wMon.id, '2026-W10');
  assert.equal(wSun.end, wMon.start);
  assert.equal(wMon.index, wSun.index + 1);
  assert.notEqual(shinyWeekFor(sunEnd).petId, shinyWeekFor(monStart).petId);

  // Every 4 consecutive weeks visits all 4 pets exactly once in fixed order, repeating cleanly over 12 weeks.
  const baseMon = Date.UTC(2026, 0, 5, 12, 0, 0); // 2026-W02
  const twelve = Array.from({ length: 12 }, (_, i) => shinyWeekFor(baseMon + i * WEEK_MS).petId);
  assert.equal(new Set(twelve.slice(0, 4)).size, 4, 'all 4 pets appear once per 4-week cycle');
  assert.deepEqual(twelve.slice(0, 4), twelve.slice(4, 8), 'cycle 2 repeats cycle 1');
  assert.deepEqual(twelve.slice(0, 4), twelve.slice(8, 12), 'cycle 3 repeats cycle 1');

  // 52-week ISO year boundary: 2025-W52 (Mon 2025-12-22) -> 2026-W01 (Mon 2025-12-29).
  const y25w52 = Date.UTC(2025, 11, 28, 23, 59, 59, 999);
  const y26w01 = Date.UTC(2025, 11, 29, 0, 0, 0, 0);
  assert.equal(weekOf(y25w52).id, '2025-W52');
  assert.equal(weekOf(y26w01).id, '2026-W01');
  assert.equal(weekOf(y26w01).index, weekOf(y25w52).index + 1);
  assert.notEqual(shinyWeekFor(y25w52).petId, shinyWeekFor(y26w01).petId, 'no repeat across 52-week year boundary');

  // 53-week ISO year boundary: 2026 HAS 53 ISO weeks!
  // 2026-W53 starts Mon 2026-12-28 (contains Dec 31 and Jan 1-3); 2027-W01 starts Mon 2027-01-04.
  const y26w52 = Date.UTC(2026, 11, 27, 23, 59, 59, 999);
  const y26w53Dec = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
  const y26w53Jan = Date.UTC(2027, 0, 1, 0, 0, 0, 0);
  const y27w01 = Date.UTC(2027, 0, 4, 0, 0, 0, 0);
  const y27w02 = Date.UTC(2027, 0, 11, 0, 0, 0, 0);
  assert.equal(weekOf(y26w52).id, '2026-W52');
  assert.equal(weekOf(y26w53Dec).id, '2026-W53');
  assert.equal(weekOf(y26w53Jan).id, '2026-W53');
  assert.equal(weekOf(y27w01).id, '2027-W01');
  assert.equal(weekOf(y27w02).id, '2027-W02');
  assert.equal(shinyWeekFor(y26w53Dec).petId, shinyWeekFor(y26w53Jan).petId, 'same pet across Dec 31 -> Jan 1 inside 2026-W53');
  const boundary4 = [y26w52, y26w53Dec, y27w01, y27w02].map(t => shinyWeekFor(t).petId);
  assert.equal(new Set(boundary4).size, 4, 'no skip or repeat across 53-week ISO year boundary');

  // DST transition weeks (US spring 2026-03-08, EU spring 2026-03-29, EU fall 2026-10-25, US fall 2026-11-01):
  // UTC weeks are always exactly 7 * 86400000 ms and rotate cleanly with zero drift.
  const dstDates = [
    Date.UTC(2026, 2, 8, 7, 30, 0),   // US spring forward Sunday
    Date.UTC(2026, 2, 9, 0, 0, 0),    // Monday after US spring forward
    Date.UTC(2026, 2, 29, 2, 30, 0),  // EU spring forward Sunday
    Date.UTC(2026, 2, 30, 0, 0, 0),   // Monday after EU spring forward
    Date.UTC(2026, 9, 25, 2, 30, 0),  // EU fall back Sunday
    Date.UTC(2026, 9, 26, 0, 0, 0),   // Monday after EU fall back
    Date.UTC(2026, 10, 1, 6, 30, 0),  // US fall back Sunday
    Date.UTC(2026, 10, 2, 0, 0, 0)    // Monday after US fall back
  ];
  for (let i = 0; i < dstDates.length; i += 2) {
    const sun = weekOf(dstDates[i]), mon = weekOf(dstDates[i + 1]);
    assert.equal(sun.end - sun.start, WEEK_MS);
    assert.equal(mon.end - mon.start, WEEK_MS);
    assert.equal(mon.start, sun.end);
    assert.equal(mon.index, sun.index + 1);
    assert.notEqual(shinyWeekFor(dstDates[i]).petId, shinyWeekFor(dstDates[i + 1]).petId);
  }

  // Exact agreement with api/_progress.js weekOf across every test timestamp.
  for (const ts of [sunEnd, monStart, y25w52, y26w01, y26w52, y26w53Dec, y26w53Jan, y27w01, ...dstDates]) {
    const a = weekOf(ts), b = progressWeekOf(ts);
    assert.deepEqual({ id: a.id, start: a.start, end: a.end }, b, `weekOf matches _progress.js at ${new Date(ts).toISOString()}`);
  }
});

test('shiny rotation: the 4-pet cycle is untouched before the cutover week, the 5-pet cycle runs from it, fixed clocks across year and DST', () => {
  const OLD = ['pet-frog', 'pet-duck', 'pet-cat', 'pet-owl'], NEW = PETS.filter(p => p.rarity !== 'mythic').map(p => p.id); // the Mythic pet is outside the weekly rotation
  const cutover = Date.UTC(2026, 11, 21); // Mon 2026-12-21 00:00 UTC
  assert.equal(SHINY_FIVE_FROM, 2972);
  assert.equal(weekOf(cutover).index, SHINY_FIVE_FROM, 'the cutover is Monday 2026-12-21');
  assert.equal(SHINY_FIVE_FROM % 4, 0, 'a 4-week cycle boundary, so no seam');
  const at = i => cutover + (i - SHINY_FIVE_FROM) * WEEK_MS + 13 * 3600000; // mid-week, whatever the DST of the reader
  const idx = i => weekOf(at(i)).index;
  // Every week before the cutover maps exactly as the old rule did: index mod 4 over frog, duck, cat, owl (checked across the 2026 DST dates).
  for (let i = SHINY_FIVE_FROM - 60; i < SHINY_FIVE_FROM; i++) assert.equal(shinyWeekFor(at(i)).petId, OLD[((i % 4) + 4) % 4], `week ${i} unchanged`);
  // Weeks 2972-2975 (21 Dec 2026 - 17 Jan 2027, which cross the 53-week ISO year) still match the old rule; only 2976 onwards changes.
  for (let i = SHINY_FIVE_FROM; i < SHINY_FIVE_FROM + 4; i++) assert.equal(shinyWeekFor(at(i)).petId, OLD[i % 4], `week ${i} also matches the old rule`);
  // From the cutover: frog, duck, cat, owl, yorkie, repeating, each pet exactly once per 5 weeks, no skip or repeat.
  const FIVE = NEW.slice(0, 5);
  assert.equal(SHINY_ALL_FROM, SHINY_FIVE_FROM + 5, 'the all-pets cycle starts on a 5-week boundary, so no week already scheduled moves');
  for (let i = SHINY_FIVE_FROM; i < SHINY_ALL_FROM; i++) {
    const w = shinyWeekFor(at(i));
    assert.equal(w.petId, FIVE[(i - SHINY_FIVE_FROM) % 5]);
    assert.equal(w.petName, PETS.find(p => p.id === w.petId).name);
    assert.notEqual(w.petId, shinyWeekFor(at(i + 1)).petId);
    assert.equal(idx(i), i);
  }
  // WI-11: from 2027-01-25 every pet (the six new ones after the Yorkie) takes a week in PETS order, repeating, no skip or repeat.
  assert.equal(weekOf(Date.UTC(2027, 0, 25)).index, SHINY_ALL_FROM);
  for (let i = SHINY_ALL_FROM; i < SHINY_ALL_FROM + 3 * NEW.length; i++) {
    const w = shinyWeekFor(at(i));
    assert.equal(w.petId, NEW[(i - SHINY_ALL_FROM) % NEW.length]);
    assert.equal(w.petName, PETS.find(p => p.id === w.petId).name);
    assert.notEqual(w.petId, shinyWeekFor(at(i + 1)).petId);
  }
  assert.equal(shinyWeekFor(Date.UTC(2027, 1, 1)).petId, 'pet-duck');
  assert.equal(shinyWeekFor(Date.UTC(2027, 2, 29)).petId, 'pet-fox', 'nine weeks into the new cycle is the Smash fox');
  assert.equal(shinyWeekFor(Date.UTC(2027, 3, 5)).petId, 'pet-netdragon', 'and the Net dragon follows it');
  assert.equal(shinyWeekFor(Date.UTC(2027, 3, 12)).petId, 'pet-frog', 'then the cycle starts again');
  assert.equal(shinyWeekFor(Date.UTC(2027, 0, 18)).petId, 'pet-yorkie', 'first Yorkie week starts Mon 2027-01-18');
  assert.equal(shinyWeekFor(Date.UTC(2027, 0, 24, 23, 59, 59, 999)).petId, 'pet-yorkie');
  assert.equal(shinyWeekFor(Date.UTC(2027, 0, 25)).petId, 'pet-frog');
  // The week before the cutover is the owl, the cutover week is the frog (identical under both rules).
  assert.equal(shinyWeekFor(Date.UTC(2026, 11, 20, 23, 59, 59, 999)).petId, 'pet-owl');
  assert.equal(shinyWeekFor(cutover).petId, 'pet-frog');
  // Across 2027 DST changes (US 2027-03-14, EU 2027-03-28, EU 2027-10-31, US 2027-11-07) the cycle keeps exact 11-week spacing.
  for (const d of [Date.UTC(2027, 2, 14, 7), Date.UTC(2027, 2, 28, 1), Date.UTC(2027, 9, 31, 1), Date.UTC(2027, 10, 7, 6)]) {
    const w = shinyWeekFor(d), later = shinyWeekFor(d + PETS.filter(q => q.rarity !== 'mythic').length * WEEK_MS), next = shinyWeekFor(d + WEEK_MS);
    assert.equal(w.petId, later.petId);
    assert.notEqual(w.petId, next.petId);
    assert.equal(w.end - w.start, WEEK_MS);
  }
  // Yorkie shiny state: a bought coat stays on in any week (it is the owner's for good), and its worn flag is what the club sees.
  const row = { id: 'pet-yorkie', item: 'pet-yorkie', slot: 'pet', worn: true, shiny: true, at: '2027-01-10T10:00:00Z' };
  assert.equal(petStateFor(row, [], Date.UTC(2027, 0, 20)).shiny, true);
  assert.equal(petStateFor(row, [], Date.UTC(2027, 0, 27)).shiny, true, 'still on the Monday after');
  assert.equal(petStateFor({ ...row, shiny: false, shinyOwned: true }, [], Date.UTC(2027, 0, 27)).shinyOwned, true);
  assert.equal(petStateFor({ ...row, shiny: false }, [], Date.UTC(2027, 0, 27)).shinyOwned, false);
  assert.deepEqual(cleanPetLook({ slot: 'pet', item: 'pet-yorkie', shiny: true, play_days: 15 }, Date.UTC(2027, 0, 20)), { pet: 'pet-yorkie', petStage: 3, petShiny: true });
  assert.deepEqual(clubLooksFrom([{ name_key: 'yo', slot: 'pet', item: 'pet-yorkie', shiny: true, play_days: 5, dinks: 20 }], Date.UTC(2027, 0, 27)), { yo: { pet: 'pet-yorkie', petStage: 2, petShiny: true } });
});

test('shiny state and clubLooksFrom allow-list: a worn coat shows in any week, zero extra fields leaked', () => {
  const wk0 = Date.UTC(2026, 4, 4, 12, 0, 0); // fixed Monday week
  const featured = shinyWeekFor(wk0).petId;
  const nextWk = wk0 + WEEK_MS;
  assert.equal(isShinyFeatured(featured, wk0), true);
  assert.equal(isShinyFeatured(featured, nextWk), false);

  const ledger = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'].map(d => earnDay(d));
  const row = { id: featured, item: featured, slot: 'pet', worn: true, shiny: true, at: '2026-05-01T10:00:00Z' };

  const during = petStateFor(row, ledger, wk0);
  assert.equal(during.stage, 2);
  assert.equal(during.stageLabel, 'Grown');
  assert.deepEqual([during.level, during.xp, during.levelXp, during.nextXp], [4, 10, 10, 15]);
  assert.ok(!('playDays' in during) && !('nextStageDays' in during));
  assert.equal(during.featuredShiny, true);
  assert.equal(during.shiny, true, 'a worn coat shows');

  const after = petStateFor(row, ledger, nextWk);
  assert.equal(after.featuredShiny, false);
  assert.equal(after.shiny, true, 'the coat does not turn off when the featured week ends');

  // clubLooksFrom allow-lists ONLY pet, petStage, petShiny (plus frame/paddle), never XP, level, playDays, dinks, streak, at or price.
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'pet', item: featured, shiny: false, play_days: 0, pet_xp: 36 }], wk0), { ana: { pet: featured, petStage: 3, petShiny: false } });
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'pet', item: featured, shiny: false, play_days: 5, pet_xp: 5 }], wk0), { ana: { pet: featured, petStage: 2, petShiny: false } }, 'the old stage plus new XP');
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'pet', item: featured, shiny: false, play_days: 0, pet_xp: 9 }], wk0), { ana: { pet: featured, petStage: 1, petShiny: false } });
  const looksDuring = clubLooksFrom([
    { name_key: 'ana', slot: 'frame', item: 'frame-court' },
    { name_key: 'ana', slot: 'pet', item: featured, shiny: true, play_days: 15, dinks: 99, streak: 7, at: '2026-05-01', price: 12 },
    { name_key: 'ben', slot: 'pet', item: 'pet-dragon', shiny: true, play_days: 20 },  // unknown pet: dropped
    { name_key: 'cy', slot: 'frame', item: featured, shiny: true, play_days: 20 }      // wrong slot: dropped
  ], wk0);
  assert.deepEqual(looksDuring, {
    ana: { frame: 'frame-court', pet: featured, petStage: 3, petShiny: true }
  });
  assert.ok(!/play_days|playDays|dinks|streak|dragon|price|2026-05-01/.test(JSON.stringify(looksDuring)));

  // Same stored shiny=true row in the following week still emits petShiny: true.
  const looksNext = clubLooksFrom([
    { name_key: 'ana', slot: 'pet', item: featured, shiny: true, play_days: 15 }
  ], nextWk);
  assert.deepEqual(looksNext, {
    ana: { pet: featured, petStage: 3, petShiny: true }
  });

  // cleanPetLook rejects non-pet rows.
  assert.equal(cleanPetLook({ slot: 'frame', item: 'frame-court' }, wk0), null);
  assert.equal(cleanPetLook(null, wk0), null);
  assert.deepEqual(wornFrom([{ id: featured, slot: 'pet', worn: true }, { id: 'frame-court', slot: 'frame', worn: true }]), {
    frame: 'frame-court', paddle: '', pet: featured, title: '', style: '', theme: '', celebrate: '', sound: ''
  });
});

test('guard: pet module never reads scores, ratings, ranks, winners, randomness or system clock, and stays out of CORE', () => {
  const code = read('api/_economypets.js').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  assert.ok(!/\bscore\b|\brating|\brank|pairing|winner|Math\.random|crypto|Date\.now|\bstripe\b|payment/i.test(code), 'api/_economypets.js must stay pure, deterministic and game-free');
  for (const f of ['pb-engine.js', 'rating-engine.js', 'api/_pb.js', 'api/_rating.js', 'api/_rating_store.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js']) {
    assert.ok(!/economypets|petStage|petShiny/.test(read(f)), f + ' must not touch pets');
  }
});

test('profile pet card: Level N, an XP bar, and a quiet evolution note that stays until dismissed (no overlay, no motion)', () => {
  const petsMod = new Function('esc', module('economypets') + ';return { rwPetCardHTML, rwPetProgress };')(String);
  const pet = { id: 'pet-frog', stage: 2, level: 4, xp: 12, levelXp: 10, nextXp: 15, shiny: false };
  const card = petsMod.rwPetCardHTML(pet, '');
  assert.match(card, /<b>Court Frog<\/b><small>Level 4 · Grown<\/small>/);
  assert.match(card, /role="progressbar" aria-label="Court Frog XP" aria-valuemin="10" aria-valuemax="15" aria-valuenow="12" aria-valuetext="12 of 15 XP"><span style="width:40%">/);
  assert.match(card, /3 XP to level 5\. 1 XP for each game sent from a club player's phone, 2 for a win\./);
  assert.ok(!/rw-evolve|petseen/.test(card), 'no note until the stage changes');
  const evolved = petsMod.rwPetCardHTML(pet, 'Grown');
  assert.match(evolved, /<p class="rw-evolve" role="status"><b>Court Frog is now Grown\.<\/b> <button type="button" class="link" data-rw="petseen">Got it<\/button><\/p>/);
  assert.ok(!/animation|confetti|overlay|modal/i.test(evolved), 'calm copy only');
  const top = petsMod.rwPetCardHTML({ id: 'pet-frog', stage: 3, level: 10, xp: 80, levelXp: 55, nextXp: null }, '');
  assert.match(top, /Level 10 · Champion/); assert.match(top, /Top level reached\./); assert.match(top, /aria-valuetext="80 XP, top level"><span style="width:100%"/);
  assert.equal(petsMod.rwPetCardHTML({ id: 'frame-court', level: 3 }, ''), '');
  assert.equal(petsMod.rwPetCardHTML(null, ''), '');
  assert.deepEqual(petsMod.rwPetProgress({ level: 99, xp: -4 }), { level: 10, xp: 0, from: 55, to: null, left: 0, pct: 100 });
});

test('Rewards.petCardHTML: own worn pet only; first sight is silent, a higher stage shows the note once, Got it dismisses it', () => {
  const kv = { 'pb.rewardsHide': false, 'pb.rewards': { 'club-a': { dinks: 20, streak: 0, best: 0, last: '', worn: { frame: '', paddle: '', pet: 'pet-frog' }, pet: { id: 'pet-frog', stage: 2, level: 4, xp: 12, levelXp: 10, nextXp: 15, shiny: false, featuredShiny: false } } } };
  const listeners = [], said = [], redraws = [];
  const code = module('economy') + ';' + module('economypets') + ';' + module('economyshop') + ';return { Rewards };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel', 'isMe', 'renderProfile',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
    { code: 'club-a', rewards: true },
    String, m => said.push(m), { documentElement: { setAttribute() {}, removeAttribute() {} }, addEventListener: (t, f) => listeners.push(f), querySelector: () => null },
    () => 'Ana', () => 'tok', async () => ({}), () => {}, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div></div>', n => n.slice(0, 2), ps => ps.join(' & '),
    n => n === 'Ana', () => redraws.push(1)
  );
  assert.equal(x.Rewards.petCardHTML('Ben'), '', "never another player's pet card");
  const first = x.Rewards.petCardHTML('Ana');
  assert.match(first, /Level 4 · Grown/); assert.ok(!/rw-evolve/.test(first), 'first sight is silent');
  assert.equal(kv['pb.petSeen']['club-a:pet-frog'], 2);
  kv['pb.petSeen'] = { 'club-a:pet-frog': 1 }; // last seen as a Rookie
  assert.match(x.Rewards.petCardHTML('Ana'), /Court Frog is now Grown\./);
  assert.match(x.Rewards.petCardHTML('Ana'), /Court Frog is now Grown\./, 'stays until dismissed');
  listeners.forEach(f => f({ target: { closest: () => ({ dataset: { rw: 'petseen' } }) } }));
  assert.equal(kv['pb.petSeen']['club-a:pet-frog'], 2);
  assert.equal(redraws.length, 1);
  assert.ok(!/rw-evolve/.test(x.Rewards.petCardHTML('Ana')), 'gone after Got it');
  kv['pb.rewardsHide'] = true;
  assert.equal(x.Rewards.petCardHTML('Ana'), '', 'hidden with the rest of the rewards');
});

test('client looks: opted-in pet id/stage/shiny pass through Rewards.lookOf for leaderboard/roster/profile, never on game cards', async () => {
  const kv = { 'pb.rewardsHide': false };
  const looksReply = {
    looks: {
      ana: { frame: 'frame-court', pet: 'pet-frog', petStage: 2, petShiny: true },
      ben: { pet: 'pet-owl', petStage: 3, petShiny: false },
      bad: { pet: 'pet-"><x>', petStage: 99, petShiny: true }
    }
  };
  const rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const code = module('economy') + ';' + module('economypets') + ';' + module('economyshop') + ';return { Rewards, rwCleanLooks };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
    { code: 'club-a', rewards: true },
    String, () => {}, { documentElement: rootEl, addEventListener: () => {}, querySelector: () => null },
    () => 'Ana', () => 'tok',
    async b => (b.action === 'rewards-looks' ? looksReply : { dinks: 20, worn: { frame: '', paddle: '', pet: '' }, pet: null, share: false, items: CATALOGUE.map(i => ({ ...i, owned: false })) }),
    () => {}, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div></div>', n => n.slice(0, 2), ps => ps.join(' & ')
  );

  await x.Rewards.syncLooks(true);
  assert.deepEqual(x.Rewards.lookOf('Ana'), { frame: 'court', paddle: '', pet: 'frog', petStage: 2, petShiny: true });
  assert.deepEqual(x.Rewards.lookOf('Ben'), { frame: '', paddle: '', pet: 'owl', petStage: 3, petShiny: false });
  assert.equal(x.Rewards.lookOf('Bad'), null, 'malformed pet ids are dropped');

  // Game cards NEVER render pets: a pet-only player (Ben) stays plain text, and Ana shows only her ring, never her pet.
  assert.equal(x.Rewards.teamHTML(['Ben', 'Cy']), 'Ben & Cy', 'pet-only opted-in player stays plain text on game cards');
  const anaCard = x.Rewards.teamHTML(['Ana', 'Ben']);
  assert.match(anaCard, /data-rw-frame="court"/);
  assert.ok(!/frog|owl|pet/i.test(anaCard), 'game cards never include pet data');

  // Avatar-side pet badge (Leaderboard, Roster, Profile): small, named for screen readers, no motion, only the three allow-listed facts.
  const badge = x.Rewards.petBadgeHTML('Ana');
  assert.match(badge, /rw-pet sm rw-pet-club/);
  assert.match(badge, /data-pet="pet-frog"[^>]*data-pet-stage="2"[^>]*data-pet-shiny="true"/);
  assert.match(badge, /role="img" aria-label="Court Frog, Grown, shiny coat"/);
  assert.match(badge, /width="20" height="20"/);
  assert.ok(!/animate|transition|<style|href=|http/i.test(badge), 'no motion or remote refs');
  assert.equal(x.Rewards.petBadgeHTML('Cy'), '', 'unshared player shows no pet');
  assert.equal(x.Rewards.petBadgeHTML('Bad'), '', 'malformed pet dropped');
  kv['pb.rewardsHide'] = true;
  assert.equal(x.Rewards.petBadgeHTML('Ana'), '', 'one-tap hide removes the pet badge');
});

test('SVG art module: all pets x 3 stages + shiny return valid, safe, tokenised, accessible SVGs with distinct silhouettes', () => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const petsMod = new Function('esc', module('economypets') + ';return { RW_PET_ORDER, RW_PET_NAMES, RW_PET_ART, rwPetSvg, rwPetBadgeHTML, rwPetAccessibleName, rwPetStageLine, rwPetRotationCopy };')(esc);
  assert.deepEqual(petsMod.RW_PET_ORDER, PETS.map(p => p.id));

  const allowedTags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'polygon']);
  const allowedVars = new Set(['--pet-1', '--pet-2', '--pet-3', '--pet-eye', '--pet-bg', '--pet-steel', '--pet-black', '--pet-tan', '--pet-gold']);
  const seenStage1 = new Set();

  for (const pet of PETS) {
    assert.equal(petsMod.RW_PET_NAMES[pet.id], pet.name);
    const stages = new Set();
    for (const stage of [1, 2, 3]) {
      const stageLabel = PET_STAGES[stage - 1].label; // Rookie, Grown, Champion
      for (const shiny of [false, true]) {
        const svg = petsMod.rwPetSvg(pet.id, { stage, shiny });
        assert.ok(svg.startsWith('<svg viewBox="0 0 64 64"') && svg.endsWith('</svg>'), `${pet.id} stage ${stage} valid svg wrapper`);
        assert.ok(Buffer.byteLength(svg, 'utf8') <= (pet.id === 'pet-supernova' ? 1900 : 1650), `${pet.id} stage ${stage} shiny=${shiny} stays compact (${Buffer.byteLength(svg, 'utf8')} B)`);

        // Accessible name on non-decorative SVG; aria-hidden on decorative SVG.
        const expectedName = `${pet.name}, ${stageLabel}${shiny ? ', shiny coat' : ''}`;
        assert.equal(petsMod.rwPetAccessibleName(pet.id, stage, shiny), expectedName);
        assert.match(svg, new RegExp(`role="img" aria-label="${expectedName}"`));
        const dec = petsMod.rwPetSvg(pet.id, { stage, shiny, decorative: true });
        assert.match(dec, /aria-hidden="true"/);
        assert.ok(!/role="img"/.test(dec));

        // Safe SVG primitives only; zero scripts, styles, foreignObjects, raster images, remote URLs or event handlers.
        const tags = [...svg.matchAll(/<\/?([a-zA-Z0-9:-]+)/g)].map(m => m[1].toLowerCase());
        assert.ok(tags.length >= 4);
        for (const t of tags) assert.ok(allowedTags.has(t), `disallowed SVG tag <${t}> in ${pet.id} stage ${stage}`);
        assert.ok(!/https?:|xlink:|href=|url\(|data:|<script|<style|foreignObject|<image|\bon[a-z]+\s*=/i.test(svg), `unsafe reference in ${pet.id} stage ${stage}`);

        // Tokens only: zero hard-coded hex/rgb/hsl colours, only approved --pet-* CSS custom properties.
        assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(svg), `hard-coded colour in ${pet.id} stage ${stage}`);
        const vars = [...svg.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]);
        assert.ok(vars.length >= 3, `${pet.id} stage ${stage} uses CSS tokens`);
        for (const v of vars) assert.ok(allowedVars.has(v), `unexpected token ${v} in ${pet.id} stage ${stage}`);

        // Shiny coat adds static star pip; classic omits it.
        assert.equal(svg.includes('data-pet-star="1"'), shiny);

        // Badge wrapper carries clean data attributes and supports 20px sm size.
        const badge20 = petsMod.rwPetBadgeHTML(pet.id, { stage, shiny, size: 20, decorative: true });
        assert.match(badge20, new RegExp(`class="rw-pet sm" data-pet="${pet.id}" data-pet-stage="${stage}" data-pet-shiny="${shiny}"`));
      }
      stages.add(petsMod.RW_PET_ART[pet.id][stage]);
    }
    assert.equal(stages.size, 3, `${pet.id} has 3 distinct visual growth stages`);
    seenStage1.add(petsMod.RW_PET_ART[pet.id][1]);
  }
  assert.equal(seenStage1.size, PETS.length, 'every pet has a distinct silhouette');

  // The Yorkie's own colour properties are defined in the page CSS from theme tokens with color-mix(), never a hex.
  const css = read('dink-score.html').split('\n').filter(l => /\.rw-pet\[data-pet="pet-yorkie"\]/.test(l));
  assert.equal(css.length, 2, 'classic and shiny Yorkie colourways');
  for (const l of css) {
    for (const v of ['--pet-steel', '--pet-black', '--pet-tan', '--pet-gold']) assert.ok(l.includes(v + ':'), `${v} defined`);
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(l), 'Yorkie colours follow theme tokens, no hard-coded colour');
  }
  assert.ok(/color-mix\(in srgb, var\(--blue\)/.test(css[0]) && /var\(--ball-ink\)/.test(css[0]), 'classic coat derives from theme tokens');

  // Bad inputs fail closed without throwing or injecting markup.
  assert.equal(petsMod.rwPetSvg('pet-dragon'), '');
  assert.equal(petsMod.rwPetSvg('"><script>'), '');
  assert.equal(petsMod.rwPetBadgeHTML('frame-court'), '');

  // Growth lines state level, stage and the XP left.
  assert.equal(petsMod.rwPetStageLine({ stage: 1, level: 1, xp: 2, levelXp: 0, nextXp: 3 }), 'Level 1 · Rookie · 1 XP to level 2');
  assert.equal(petsMod.rwPetStageLine({ stage: 2, level: 4, xp: 10, levelXp: 10, nextXp: 15 }), 'Level 4 · Grown · 5 XP to level 5');
  assert.equal(petsMod.rwPetStageLine({ stage: 3, level: 10, xp: 80, levelXp: 55, nextXp: null }), 'Level 10 · Champion · top level');
  assert.equal(petsMod.rwPetStageLine({ stage: 1 }), 'Level 1 · Rookie · 3 XP to level 2');

  // Calm & isolation guard on src/app/economypets.js.
  const src = read('src/app/economypets.js').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  assert.ok(!/@keyframes|\banimation\b|\btransition\b|confetti|Audio\(|\.play\(|Math\.random|\bscore\b|\brating|\brank|winner/i.test(src), 'economypets.js must stay calm and game-free');
});

test('Shop Pets UI and Your Dink companion: adopt, picker, growth progress, featured-week shiny toggle, calm hide and announce()', async () => {
  const mkPhone = ({ hide = false, rewards = true, name = 'Ana', replyFn } = {}) => {
    const calls = [], kv = { 'pb.rewardsHide': hide }, listeners = [], announced = [], focused = [];
    const rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const code = module('economy') + ';' + module('economypets') + ';' + module('economyshop')
      + ';return { Rewards, rwCur, rwSave, rwClean, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
    const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
      'let clubSheet = null;' + code)(
      { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } },
      { code: 'club-a', rewards },
      s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      m => announced.push(m),
      { documentElement: rootEl, addEventListener: (t, f) => listeners.push(f), querySelector: sel => ({ focus() { focused.push(sel); } }) },
      () => name, () => (name ? 'tok' : null),
      async b => { calls.push(b); return replyFn ? replyFn(b) : {}; },
      () => {}, () => {}, s => s.slice(0, 2), () => '<svg></svg>', () => '<div></div>', n => n.slice(0, 2), ps => ps.join(' & ')
    );
    return { x, calls, kv, listeners, announced, focused };
  };

  const shinyFrogWeek = { weekId: '2026-W20', start: 0, end: 1, petId: 'pet-frog', petName: 'Court Frog' };
  const shinyOwlWeek = { weekId: '2026-W23', start: 0, end: 1, petId: 'pet-owl', petName: 'Lob owl' };
  const mkStore = ({ dinks = 250, wornPet = 'pet-frog', frogShiny = false, frogCoat = false, shinyWeek: wk = shinyFrogWeek, owned = ['pet-frog'] } = {}) => ({
    dinks,
    worn: { frame: '', paddle: '', pet: wornPet },
    pet: wornPet === 'pet-frog' ? { id: 'pet-frog', name: 'Court Frog', stage: 2, stageLabel: 'Grown', level: 4, xp: 12, levelXp: 10, nextXp: 15, shiny: frogShiny, shinyOwned: frogCoat || frogShiny, featuredShiny: wk.petId === 'pet-frog' } : null,
    shinyWeek: { ...wk, price: wk.petId === 'pet-frog' ? 300 : 600, owned: wk.petId === 'pet-frog' && (frogCoat || frogShiny) },
    share: false,
    items: CATALOGUE.map(i => {
      if (i.slot !== 'pet') return { ...i, owned: false };
      const isOwned = owned.includes(i.id);
      const featuredShiny = wk.petId === i.id;
      if (!isOwned) return { ...i, owned: false, featuredShiny };
      return { ...i, owned: true, featuredShiny, stage: 2, stageLabel: 'Grown', level: 4, xp: 12, levelXp: 10, nextXp: 15, shiny: i.id === 'pet-frog' && frogShiny, shinyOwned: i.id === 'pet-frog' && (frogCoat || frogShiny) };
    })
  });

  // Featured week: Pets section shows court-green spotlight + rotation copy, owned picker with stage/days, one-tap shiny toggle, unowned Adopt list with price & shortfall.
  const p = mkPhone({
    replyFn: async b => {
      if (b.action === 'rewards-catalog') return mkStore();
      if (b.action === 'rewards-wear' && b.shiny === true) return mkStore({ frogShiny: true });
      if (b.action === 'rewards-wear' && b.shiny === false) return mkStore({ frogCoat: true });
      if (b.action === 'rewards-buy' && b.item === 'shiny-pet-frog') return mkStore({ dinks: 100, frogCoat: true });
      if (b.action === 'rewards-buy') return mkStore({ dinks: 50, owned: ['pet-frog', 'pet-duck'] });
      return mkStore({ wornPet: '' });
    }
  });
  await p.x.Rewards.openStore();
  const html = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(html, /Court pets/);
  assert.match(html, /Shiny this week<\/span><b>Shiny court frog<\/b>/);
  assert.match(html, /A rare colour version for anyone who owns the Court Frog\. It keeps its level\. For sale until \w+, \w+ \d+ · 300 Dinks\. Next week, another pet\./, 'the end is a date, not a countdown; the price is shown');
  assert.ok(!/days? left/i.test(html), 'no countdown');
  assert.ok(!/rw-hero-lock/.test(html), 'an owner sees the buy button, not the locked state');
  assert.match(html, /data-rw-shiny-buy="pet-frog" aria-label="Buy Shiny court frog for 300 Dinks\. You need 50 more"[^>]*>50 more</, 'the owner buys the coat; the shortfall is stated');
  assert.ok(!/data-rw-shiny="/.test(html), 'no coat owned yet: no switch');
  assert.ok(!/Free|free shiny/.test(html), 'the coat is sold, not free');
  assert.match(html, /data-rw="pets"[^>]*>Pet collection: see how every pet grows</);
  assert.ok(html.includes(PETS.filter(p => p.rarity !== 'mythic').map(p => p.name).join(' → ')), 'the rotation lists every pet, in order');
  assert.match(html, /Lob owl → Yorkie → Pickle pup/);
  assert.match(html, /for sale in turn, rotating every Monday/);
  assert.match(html, /data-rw-buy="pet-yorkie"[^>]*>150 more</);
  assert.match(html, /Yorkie<\/b><small class="rw-cost">400 Dinks<\/small>/, 'Yorkie is listed at its fixed price');
  assert.match(html, /aria-label="Adopt Yorkie for 400 Dinks\. You need 150 more"/);
  assert.match(html, /data-rw-buy="pet-netdragon"[^>]*>550 more</, 'Net dragon is on the shelf too');
  assert.match(html, /data-rarity="legendary">Legendary</);
  assert.match(html, /data-rw-wear="pet:pet-frog"[^>]*aria-pressed="true"/);
  assert.match(html, /data-rw-wear="pet:"/);
  assert.match(html, /Level 4 · Grown · 3 XP to level 5/);
  assert.match(html, /data-rw-buy="pet-duck"/);
  assert.match(html, /Dink duck<\/b><small class="rw-cost">200 Dinks/);
  assert.match(html, /data-rw-buy="pet-cat"[^>]*aria-label="Adopt Kitchen cat for 500 Dinks\. You need 250 more"[^>]*>250 more</, 'shortfall stated before tapping');
  assert.ok(!/data-rw-buy="pet-frog"/.test(html), 'owned pet is not offered to adopt again');
  assert.ok(!/animation|odds|random/i.test(html), 'calm copy only'); // the Confetti celebration card (WI-16) is a name, not an effect

  // Buying the coat: a short balance only says so (no call); with enough Dinks it sends rewards-buy for the shiny id, never a price.
  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  const before = p.calls.length;
  click({ rwShinyBuy: 'pet-frog' });
  assert.equal(p.calls.length, before, 'too few Dinks: no request');
  assert.equal(p.announced.at(-1), 'Not enough Dinks yet: Shiny court frog costs 300 and you have 250.');
  p.x.sheet.store = mkStore({ dinks: 400 });
  click({ rwShinyBuy: 'pet-frog' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls.at(-1), { name: 'Ana', playerToken: 'tok', action: 'rewards-buy', item: 'shiny-pet-frog' });
  assert.match(p.announced.at(-1), /Shiny court frog is yours for 300 Dinks/);
  const ownHtml = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(ownHtml, /rw-hero-lock" aria-disabled="true" tabindex="-1"><span aria-hidden="true">✦ <\/span>Yours</, 'the hero says Yours once bought');
  assert.ok(!/data-rw-shiny-buy/.test(ownHtml), 'no second buy');
  assert.match(ownHtml, /data-rw-shiny="pet-frog:1"[^>]*aria-pressed="false"/, 'the owner gets the coat switch');
  assert.match(ownHtml, /Level 4 · Grown · 3 XP to level 5 · Shiny coat owned/, 'the pet keeps its level');

  // Clicking the shiny switch sends rewards-wear with shiny: true, announces.
  click({ rwShiny: 'pet-frog:1' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls.at(-1), { name: 'Ana', playerToken: 'tok', action: 'rewards-wear', slot: 'pet', item: 'pet-frog', shiny: true });
  assert.equal(p.announced.at(-1), 'Shiny coat on for Court Frog.');
  assert.equal(p.focused.at(-1), '[data-rw-shiny]');

  // Clicking Adopt for an affordable pet sends rewards-buy (never a price) and announces.
  click({ rwBuy: 'pet-duck' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls.at(-1), { name: 'Ana', playerToken: 'tok', action: 'rewards-buy', item: 'pet-duck' });
  assert.equal('price' in p.calls.at(-1), false);
  assert.match(p.announced.at(-1), /Dink duck is yours for 200 Dinks/);

  // Another pet's week: no switch for a coat not bought, but a bought coat keeps its switch in any week.
  assert.match(p.x.Rewards.storeHTML({ store: mkStore({ shinyWeek: shinyOwlWeek, frogCoat: true }), msg: '', error: '', busy: false }), /data-rw-shiny="pet-frog:1"/);
  const offWeekHtml = p.x.Rewards.storeHTML({ store: mkStore({ shinyWeek: shinyOwlWeek }), msg: '', error: '', busy: false });
  assert.match(offWeekHtml, /Shiny this week<\/span><b>Shiny lob owl<\/b>/);
  assert.match(offWeekHtml, /rw-hero-lock" aria-disabled="true">Get the lob owl first</, 'not owned: quiet locked state, no price');
  // Pet collection sheet: every pet at all three stages, the owner's own stage, a way back, nothing about scores.
  click({ rw: 'pets' });
  assert.equal(p.x.sheet.view, 'rwpets');
  const coll = p.x.Rewards.petsHTML(p.x.sheet);
  assert.match(coll, /Pet collection/);
  for (const n of PETS.map(p => p.name)) assert.match(coll, new RegExp(`<b>${n}</b>`));
  assert.equal((coll.match(/data-pet-stage="1"/g) || []).length, PETS.length);
  assert.equal((coll.match(/data-pet-stage="2"/g) || []).length, PETS.length);
  assert.equal((coll.match(/data-pet-stage="3"/g) || []).length, PETS.length);
  assert.match(coll, /at level 4 \(10 XP\)/); assert.match(coll, /at level 8 \(36 XP\)/);
  assert.match(coll, /Yours: level 4, Grown/);
  assert.ok(!/play days?/.test(coll), 'growth is XP now, not play days');
  assert.match(coll, /data-rw="store">Back to the shop</);
  assert.ok(!/animation|odds|random/i.test(coll.replace(/data-pet-shiny/g, '')), 'calm copy only');
  assert.ok(!/data-rw-shiny/.test(offWeekHtml), 'no switch for a coat that was never bought');

  // Club rewards off or player hid rewards: nothing shows on the Your Dinks tile or Shop sheet.
  for (const opts of [{ rewards: false, hide: false }, { rewards: true, hide: true }]) {
    const h = mkPhone(opts);
    h.kv['pb.rewards'] = { 'club-a': { dinks: 20, streak: 3, best: 3, last: '', worn: { frame: '', paddle: '', pet: 'pet-frog' }, pet: { id: 'pet-frog', stage: 2, level: 4, xp: 12, levelXp: 10, nextXp: 15, shiny: true, featuredShiny: true } } };
    assert.equal(h.x.Rewards.tileHTML(), '');
    assert.ok(!/rw-pets|data-rw-shiny|data-rw-buy/.test(h.x.Rewards.storeHTML({ store: mkStore(), msg: '', error: '', busy: false })));
  }
});
