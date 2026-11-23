// Rewards pets (phase 1, #107): pure catalogue, growth stage boundaries, deterministic weekly shiny rotation across
// year (52-week and 53-week ISO) and DST boundaries, club-visible allow-list, and isolation guards.
// All time checks use fixed injected timestamps — never Date.now() offsets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PETS, PET_STAGES, petById, isPetId, utcDayKey,
  countPlayDaysSince, petStageFor, petStageFromLedger,
  weekOf, shinyWeekFor, isShinyFeatured, petStateFor, cleanPetLook
} from '../api/_economypets.js';
import { CATALOGUE, SLOTS, itemById, buyId, planBuy, wornFrom, clubLooksFrom } from '../api/_economyshop.js';
import { BOX_TIERS } from '../api/_economybox.js';
import { DAY_PAY, BONUS } from '../api/_economy.js';
import { weekOf as progressWeekOf } from '../api/_progress.js';
import { module } from './helpers/app.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const earnDay = (day, id = 'day:' + day) => ({ id, kind: 'earn', amount: 1, reason: 'day', day, streak: 1 });
const spendRow = (id, amount, day = null) => ({ id, kind: 'spend', amount: -amount, reason: 'shop', day, streak: null });
const nullDayEarn = (id, amount) => ({ id, kind: 'earn', amount, reason: 'pass:tier-1', day: null, streak: null });

test('pet catalogue: 4 fixed-price pets in CATALOGUE under slot pet, valid buy ids, excluded from random box draws', () => {
  assert.equal(PETS.length, 4);
  assert.deepEqual(PETS.map(p => p.id), ['pet-frog', 'pet-duck', 'pet-cat', 'pet-owl']);
  assert.ok(SLOTS.includes('pet'));
  const weekPay = 7 * DAY_PAY + BONUS[0][1] + BONUS[1][1]; // 14 Dinks
  for (const p of PETS) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'name', 'price', 'slot']);
    assert.equal(p.slot, 'pet');
    assert.ok(p.id.startsWith('pet-'));
    assert.ok(Number.isInteger(p.price) && p.price >= 1 && p.price <= 2 * weekPay);
    assert.deepEqual(itemById(p.id), p, 'pet lives in the single CATALOGUE constant');
    assert.deepEqual(petById(p.id), p);
    assert.equal(isPetId(p.id), true);
    assert.match(buyId(p), /^buy:pet-[a-z]{3,12}$/);
  }
  assert.equal(petById('frame-court'), null);
  assert.equal(isPetId('frame-court'), false);
  assert.equal(petById('pet-dragon'), null);

  // Pets are fixed-price only (never in random mystery box tiers).
  const boxIds = new Set(BOX_TIERS.flatMap(t => t.items));
  for (const p of PETS) assert.equal(boxIds.has(p.id), false, `${p.id} must not be in mystery box tiers`);

  // Purchase plans through the shared shop flow: idempotent buy:pet-* id, never below zero.
  const frog = petById('pet-frog');
  const funded = [earnDay('2026-01-01'), { id: 'seed:1', kind: 'earn', amount: 11, reason: 'seed', day: null, streak: null }];
  const plan = planBuy(funded, [], 'pet-frog');
  assert.equal(plan.entry.id, 'buy:pet-frog');
  assert.equal(plan.entry.amount, -frog.price);
  assert.deepEqual(planBuy(funded, ['pet-frog'], 'pet-frog'), { item: frog, already: true });
  assert.throws(() => planBuy([earnDay('2026-01-01')], [], 'pet-frog'), e => e.status === 409 && /costs 12 and you have 1/.test(e.message));
});

test('growth stages at exact boundaries: Rookie 0-4, Club 5-14, Veteran 15+, clamping bad inputs', () => {
  assert.deepEqual(PET_STAGES.map(s => [s.stage, s.label, s.minDays]), [
    [1, 'Rookie', 0],
    [2, 'Club', 5],
    [3, 'Veteran', 15]
  ]);
  for (const d of [0, 1, 2, 3, 4]) {
    assert.deepEqual(petStageFor(d), { stage: 1, label: 'Rookie', playDays: d, nextDays: 5 });
  }
  for (const d of [5, 6, 10, 14]) {
    assert.deepEqual(petStageFor(d), { stage: 2, label: 'Club', playDays: d, nextDays: 15 });
  }
  for (const d of [15, 16, 30, 365]) {
    assert.deepEqual(petStageFor(d), { stage: 3, label: 'Veteran', playDays: d, nextDays: null });
  }
  // Negative, fractional, NaN or non-numeric values stay safely clamped at Rookie (0 days).
  for (const bad of [-5, -1, NaN, Infinity, null, undefined, 'x']) {
    assert.deepEqual(petStageFor(bad), { stage: 1, label: 'Rookie', playDays: 0, nextDays: 5 });
  }
  assert.deepEqual(petStageFor(4.9), { stage: 1, label: 'Rookie', playDays: 4, nextDays: 5 });
  assert.deepEqual(petStageFor(5.1), { stage: 2, label: 'Club', playDays: 5, nextDays: 15 });
});

test('play days are derived solely from distinct verified earn days in reward_ledger since adoption', () => {
  const adoptedAt = '2026-02-10T18:30:00.000Z';
  assert.equal(utcDayKey(adoptedAt), '2026-02-10');
  assert.equal(utcDayKey(Date.UTC(2026, 1, 10, 23, 59, 59)), '2026-02-10');
  assert.equal(utcDayKey('2026-02-10'), '2026-02-10');
  assert.equal(utcDayKey('not-a-date'), '');

  const ledger = [
    // Before adoption: ignored.
    earnDay('2026-02-08'),
    earnDay('2026-02-09'),
    // Adoption day itself + duplicate row from a player merge: counts ONCE.
    earnDay('2026-02-10'),
    earnDay('2026-02-10', 'm:old:day:2026-02-10'),
    // Non-play-day entries (spends, season pass claims, box spends/refunds): ignored.
    spendRow('buy:pet-frog', 12, null),
    spendRow('box:abc12345', 7, '2026-02-11'),
    nullDayEarn('boxref:abc12345', 4),
    nullDayEarn('pass:2026-Q1:1', 2),
    { id: 'bad:row', kind: 'earn', amount: 1, reason: 'bad', day: '2026/02/12', streak: null },
    // 3 more distinct play days after adoption -> total 4 (still Rookie).
    earnDay('2026-02-11'),
    earnDay('2026-02-12'),
    earnDay('2026-02-15')
  ];
  assert.equal(countPlayDaysSince(ledger, adoptedAt), 4);
  assert.equal(petStageFromLedger(ledger, adoptedAt).label, 'Rookie');

  // 5th verified play day crosses into Club.
  const fiveDays = [...ledger, earnDay('2026-02-16')];
  assert.equal(countPlayDaysSince(fiveDays, adoptedAt), 5);
  assert.equal(petStageFromLedger(fiveDays, adoptedAt).stage, 2);
  assert.equal(petStageFromLedger(fiveDays, adoptedAt).label, 'Club');

  // Add 9 more (14 total -> still Club), then 1 more (15 total -> Veteran).
  const fourteen = [...fiveDays];
  for (let d = 17; d <= 25; d++) fourteen.push(earnDay(`2026-02-${String(d).padStart(2, '0')}`));
  assert.equal(countPlayDaysSince(fourteen, adoptedAt), 14);
  assert.equal(petStageFromLedger(fourteen, adoptedAt).label, 'Club');

  const fifteen = [...fourteen, earnDay('2026-02-26')];
  assert.equal(countPlayDaysSince(fifteen, adoptedAt), 15);
  assert.equal(petStageFromLedger(fifteen, adoptedAt).stage, 3);
  assert.equal(petStageFromLedger(fifteen, adoptedAt).label, 'Veteran');
  assert.equal(petStageFromLedger(fifteen, adoptedAt).nextDays, null);
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

test('Variant A shiny state and clubLooksFrom allow-list: active only in featured week, zero extra fields leaked', () => {
  const wk0 = Date.UTC(2026, 4, 4, 12, 0, 0); // fixed Monday week
  const featured = shinyWeekFor(wk0).petId;
  const nextWk = wk0 + WEEK_MS;
  assert.equal(isShinyFeatured(featured, wk0), true);
  assert.equal(isShinyFeatured(featured, nextWk), false);

  const ledger = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'].map(d => earnDay(d));
  const row = { id: featured, item: featured, slot: 'pet', worn: true, shiny: true, at: '2026-05-01T10:00:00Z' };

  const during = petStateFor(row, ledger, wk0);
  assert.equal(during.stage, 2);
  assert.equal(during.stageLabel, 'Club');
  assert.equal(during.playDays, 5);
  assert.equal(during.nextStageDays, 15);
  assert.equal(during.featuredShiny, true);
  assert.equal(during.shiny, true, 'shiny is active during its featured week');

  const after = petStateFor(row, ledger, nextWk);
  assert.equal(after.featuredShiny, false);
  assert.equal(after.shiny, false, 'Variant A: shiny automatically turns off once the featured week ends');

  // clubLooksFrom allow-lists ONLY pet, petStage, petShiny (plus frame/paddle), never playDays/dinks/streak/at/price.
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

  // Same stored shiny=true row in the following week emits petShiny: false!
  const looksNext = clubLooksFrom([
    { name_key: 'ana', slot: 'pet', item: featured, shiny: true, play_days: 15 }
  ], nextWk);
  assert.deepEqual(looksNext, {
    ana: { pet: featured, petStage: 3, petShiny: false }
  });

  // cleanPetLook rejects non-pet rows.
  assert.equal(cleanPetLook({ slot: 'frame', item: 'frame-court' }, wk0), null);
  assert.equal(cleanPetLook(null, wk0), null);
  assert.deepEqual(wornFrom([{ id: featured, slot: 'pet', worn: true }, { id: 'frame-court', slot: 'frame', worn: true }]), {
    frame: 'frame-court', paddle: '', pet: featured
  });
});

test('guard: pet module never reads scores, ratings, ranks, winners, randomness or system clock, and stays out of CORE', () => {
  const code = read('api/_economypets.js').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  assert.ok(!/\bscore\b|\brating|\brank|pairing|winner|Math\.random|crypto|Date\.now|\bstripe\b|payment/i.test(code), 'api/_economypets.js must stay pure, deterministic and game-free');
  for (const f of ['pb-engine.js', 'rating-engine.js', 'api/_pb.js', 'api/_rating.js', 'api/_rating_store.js', 'api/_gamesave.js', 'api/games.js', 'api/club.js']) {
    assert.ok(!/economypets|petStage|petShiny/.test(read(f)), f + ' must not touch pets');
  }
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
  assert.match(badge, /role="img" aria-label="Court Frog, Club, shiny coat"/);
  assert.match(badge, /width="20" height="20"/);
  assert.ok(!/animate|transition|<style|href=|http/i.test(badge), 'no motion or remote refs');
  assert.equal(x.Rewards.petBadgeHTML('Cy'), '', 'unshared player shows no pet');
  assert.equal(x.Rewards.petBadgeHTML('Bad'), '', 'malformed pet dropped');
  kv['pb.rewardsHide'] = true;
  assert.equal(x.Rewards.petBadgeHTML('Ana'), '', 'one-tap hide removes the pet badge');
});

test('SVG art module: all 4 pets x 3 stages + shiny return valid, safe, tokenised, accessible SVGs with distinct silhouettes', () => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const petsMod = new Function('esc', module('economypets') + ';return { RW_PET_ORDER, RW_PET_NAMES, RW_PET_ART, rwPetSvg, rwPetBadgeHTML, rwPetAccessibleName, rwPetStageLine, rwPetRotationCopy };')(esc);
  assert.deepEqual(petsMod.RW_PET_ORDER, PETS.map(p => p.id));

  const allowedTags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'polygon']);
  const allowedVars = new Set(['--pet-1', '--pet-2', '--pet-3', '--pet-eye', '--pet-bg']);
  const seenStage1 = new Set();

  for (const pet of PETS) {
    assert.equal(petsMod.RW_PET_NAMES[pet.id], pet.name);
    const stages = new Set();
    for (const stage of [1, 2, 3]) {
      const stageLabel = PET_STAGES[stage - 1].label;
      for (const shiny of [false, true]) {
        const svg = petsMod.rwPetSvg(pet.id, { stage, shiny });
        assert.ok(svg.startsWith('<svg viewBox="0 0 64 64"') && svg.endsWith('</svg>'), `${pet.id} stage ${stage} valid svg wrapper`);
        assert.ok(Buffer.byteLength(svg, 'utf8') <= 1650, `${pet.id} stage ${stage} shiny=${shiny} stays compact (${Buffer.byteLength(svg, 'utf8')} B)`);

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
  assert.equal(seenStage1.size, 4, 'all 4 pets have distinct silhouettes');

  // Bad inputs fail closed without throwing or injecting markup.
  assert.equal(petsMod.rwPetSvg('pet-dragon'), '');
  assert.equal(petsMod.rwPetSvg('"><script>'), '');
  assert.equal(petsMod.rwPetBadgeHTML('frame-court'), '');

  // Growth stage lines state current stage and days remaining clearly.
  assert.equal(petsMod.rwPetStageLine({ stage: 1, stageLabel: 'Rookie', playDays: 3, nextStageDays: 5 }), 'Rookie · 2 more play days to Club (3/5)');
  assert.equal(petsMod.rwPetStageLine({ stage: 1, stageLabel: 'Rookie', playDays: 4, nextStageDays: 5 }), 'Rookie · 1 more play day to Club (4/5)');
  assert.equal(petsMod.rwPetStageLine({ stage: 2, stageLabel: 'Club', playDays: 10, nextStageDays: 15 }), 'Club · 5 more play days to Veteran (10/15)');
  assert.equal(petsMod.rwPetStageLine({ stage: 3, stageLabel: 'Veteran', playDays: 18, nextStageDays: null }), 'Veteran · 18 play days');

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
  const shinyOwlWeek = { weekId: '2026-W23', start: 0, end: 1, petId: 'pet-owl', petName: 'Net Owl' };
  const mkStore = ({ dinks = 15, wornPet = 'pet-frog', frogShiny = false, shinyWeek = shinyFrogWeek, owned = ['pet-frog'] } = {}) => ({
    dinks,
    worn: { frame: '', paddle: '', pet: wornPet },
    pet: wornPet === 'pet-frog' ? { id: 'pet-frog', name: 'Court Frog', stage: 2, stageLabel: 'Club', playDays: 7, nextStageDays: 15, shiny: frogShiny && shinyWeek.petId === 'pet-frog', featuredShiny: shinyWeek.petId === 'pet-frog' } : null,
    shinyWeek,
    share: false,
    items: CATALOGUE.map(i => {
      if (i.slot !== 'pet') return { ...i, owned: false };
      const isOwned = owned.includes(i.id);
      const featuredShiny = shinyWeek.petId === i.id;
      if (!isOwned) return { ...i, owned: false, featuredShiny };
      return { ...i, owned: true, featuredShiny, stage: 2, stageLabel: 'Club', playDays: 7, nextStageDays: 15, shiny: i.id === 'pet-frog' && frogShiny && featuredShiny };
    })
  });

  // Featured week: Pets section shows court-green spotlight + rotation copy, owned picker with stage/days, one-tap shiny toggle, unowned Adopt list with price & shortfall.
  const p = mkPhone({
    replyFn: async b => {
      if (b.action === 'rewards-catalog') return mkStore();
      if (b.action === 'rewards-wear' && b.shiny === true) return mkStore({ frogShiny: true });
      if (b.action === 'rewards-wear' && b.shiny === false) return mkStore({ frogShiny: false });
      if (b.action === 'rewards-buy') return mkStore({ dinks: 1, owned: ['pet-frog', 'pet-duck'] });
      return mkStore({ wornPet: '' });
    }
  });
  await p.x.Rewards.openStore();
  const html = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(html, /Court pets/);
  assert.match(html, /This week's shiny coat: Court Frog/);
  assert.match(html, /Court Frog → Dink Duck → Kitchen Cat → Net Owl/);
  assert.match(html, /data-rw-wear="pet:pet-frog"[^>]*aria-pressed="true"/);
  assert.match(html, /data-rw-wear="pet:"/);
  assert.match(html, /Club · 8 more play days to Veteran \(7\/15\)/);
  assert.match(html, /data-rw-shiny="pet-frog:1"[^>]*aria-pressed="false"/, 'one-tap shiny toggle appears during featured week');
  assert.match(html, /data-rw-buy="pet-duck"/);
  assert.match(html, /Dink Duck<\/b><small>14 Dinks/);
  assert.match(html, /Kitchen Cat<\/b><small>18 Dinks\. You need 3 more\./, 'shortfall stated before tapping');
  assert.ok(!/data-rw-buy="pet-frog"/.test(html), 'owned pet is not offered to adopt again');
  assert.ok(!/animation|confetti|odds|random/i.test(html), 'calm copy only');

  // Clicking the one-tap shiny toggle sends rewards-wear with shiny: true, announces and updates Your Dink card.
  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  click({ rwShiny: 'pet-frog:1' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls.at(-1), { name: 'Ana', playerToken: 'tok', action: 'rewards-wear', slot: 'pet', item: 'pet-frog', shiny: true });
  assert.equal(p.announced.at(-1), 'Shiny coat on for Court Frog this week.');
  assert.equal(p.focused.at(-1), '[data-rw-shiny]');
  const cardShiny = p.x.Rewards.cardHTML();
  assert.match(cardShiny, /rw-card-pet/);
  assert.match(cardShiny, /data-pet="pet-frog" data-pet-stage="2" data-pet-shiny="true"/);
  assert.match(cardShiny, /Court Frog · Shiny coat/);
  assert.match(cardShiny, /Club · 8 more play days to Veteran \(7\/15\)/);
  assert.match(cardShiny, /role="img" aria-label="Court Frog, Club, shiny coat"/);

  // Clicking Adopt for an affordable pet sends rewards-buy (never a price) and announces.
  click({ rwBuy: 'pet-duck' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(p.calls.at(-1), { name: 'Ana', playerToken: 'tok', action: 'rewards-buy', item: 'pet-duck' });
  assert.equal('price' in p.calls.at(-1), false);
  assert.match(p.announced.at(-1), /Dink Duck is yours for 14 Dinks/);

  // Outside the owned pet's featured week: NO shiny toggle is rendered, while the rotation spotlight still names this week's pet.
  const offWeekHtml = p.x.Rewards.storeHTML({ store: mkStore({ shinyWeek: shinyOwlWeek }), msg: '', error: '', busy: false });
  assert.match(offWeekHtml, /This week's shiny coat: Net Owl/);
  assert.ok(!/data-rw-shiny/.test(offWeekHtml), 'shiny toggle must not appear outside an owned pet featured week');

  // Club rewards off or player hid rewards: nothing shows on Your Dink card or Shop sheet.
  for (const opts of [{ rewards: false, hide: false }, { rewards: true, hide: true }]) {
    const h = mkPhone(opts);
    h.kv['pb.rewards'] = { 'club-a': { dinks: 20, streak: 3, best: 3, last: '', worn: { frame: '', paddle: '', pet: 'pet-frog' }, pet: { id: 'pet-frog', stage: 2, playDays: 7, nextStageDays: 15, shiny: true, featuredShiny: true } } };
    assert.equal(h.x.Rewards.cardHTML(), '');
    assert.ok(!/rw-pets|data-rw-shiny|data-rw-buy/.test(h.x.Rewards.storeHTML({ store: mkStore(), msg: '', error: '', busy: false })));
  }
});
