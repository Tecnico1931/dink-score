// Rewards, pets (phase 1, #107; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js).
// Pure pet catalogue, growth stages and deterministic weekly shiny rotation. Zero DB access, zero randomness,
// and nothing here reads or changes a game result, rating, rank or pairing.
//
// Growth: derived strictly from distinct verified play days in `reward_ledger` (kind = 'earn', valid YYYY-MM-DD
// day >= adoptedDay UTC). Play days come from attendance only; wins, losses and scores never matter.
//
// Weekly shiny coat: deterministic spotlight rotation (4 pets until week index SHINY_FIVE_FROM, then 5, then every pet from SHINY_ALL_FROM) using Monday 00:00 UTC ISO weeks.
// During that pet's featured week its owner can buy the shiny coat once (reward_items.shiny_owned, ledger id buy:shiny-<pet>); it is theirs for good and keeps the pet's
// level, and reward_items.shiny says whether it is worn. Nothing random.

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_EPOCH = Date.UTC(1970, 0, 5); // first Monday in UTC: exact 7-day cadence across 52/53-week years and DST
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Court pets at fixed Dinks prices (included in CATALOGUE in _economyshop.js; never in random box draws). PETS order is the rotation order, so the
// first five never move and new pets are only ever appended. Prices and rarities follow the upstream shop (WI-11). The owl keeps its id under the
// upstream name Lob owl; Court Frog and Yorkie have no upstream twin and keep their names.
export const PETS = Object.freeze([
  Object.freeze({ id: 'pet-frog', slot: 'pet', name: 'Court Frog', price: 200, rarity: 'common' }),
  Object.freeze({ id: 'pet-duck', slot: 'pet', name: 'Dink duck', price: 200, rarity: 'common' }),
  Object.freeze({ id: 'pet-cat', slot: 'pet', name: 'Kitchen cat', price: 500, rarity: 'rare' }),
  Object.freeze({ id: 'pet-owl', slot: 'pet', name: 'Lob owl', price: 450, rarity: 'rare' }),
  Object.freeze({ id: 'pet-yorkie', slot: 'pet', name: 'Yorkie', price: 400, rarity: 'rare' }),
  Object.freeze({ id: 'pet-pup', slot: 'pet', name: 'Pickle pup', price: 200, rarity: 'common' }),
  Object.freeze({ id: 'pet-blob', slot: 'pet', name: 'Ball blob', price: 300, rarity: 'rare' }),
  Object.freeze({ id: 'pet-bat', slot: 'pet', name: 'Paddle bat', price: 400, rarity: 'rare' }),
  Object.freeze({ id: 'pet-turtle', slot: 'pet', name: 'Court turtle', price: 250, rarity: 'common' }),
  Object.freeze({ id: 'pet-fox', slot: 'pet', name: 'Smash fox', price: 600, rarity: 'rare' }),
  Object.freeze({ id: 'pet-netdragon', slot: 'pet', name: 'Net dragon', price: 800, rarity: 'legendary' }),
  // WI-13: a Mythic pet. Appended last and kept out of the weekly shiny rotation (ROTATION below), so no scheduled week changes.
  Object.freeze({ id: 'pet-supernova', slot: 'pet', name: 'Supernova dragon', price: 4800, rarity: 'mythic' })
]);

// Three growth stages fed purely by distinct verified play days since adoption.
export const PET_STAGES = Object.freeze([
  Object.freeze({ stage: 1, label: 'Rookie', minDays: 0 }),
  Object.freeze({ stage: 2, label: 'Club', minDays: 5 }),
  Object.freeze({ stage: 3, label: 'Veteran', minDays: 15 })
]);

export const petById = id => PETS.find(p => p.id === id) || null;
export const isPetId = id => !!petById(id);

// Convert an adoption timestamp (Date, ISO string, ms) or YYYY-MM-DD day key to a UTC YYYY-MM-DD key.
export function utcDayKey(value) {
  if (typeof value === 'string' && DAY_RE.test(value)) return value;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

// Count distinct verified earn play days on or after adoption day (UTC).
// Ignores spends, null-day bonus/pass/refund rows, days before adoption, and duplicate rows from player merges.
export function countPlayDaysSince(ledger, adoptedAt) {
  const since = utcDayKey(adoptedAt);
  if (!since || !Array.isArray(ledger)) return 0;
  const days = new Set();
  for (const e of ledger) {
    if (!e || e.kind !== 'earn' || typeof e.day !== 'string' || !DAY_RE.test(e.day)) continue;
    if (e.day >= since) days.add(e.day);
  }
  return days.size;
}

// Map verified play days since adoption to its growth stage: Rookie 0-4, Club 5-14, Veteran 15+.
export function petStageFor(playDays) {
  const days = Number.isFinite(playDays) ? Math.max(0, Math.floor(playDays)) : 0;
  let idx = 0;
  for (let i = 0; i < PET_STAGES.length; i++) {
    if (days >= PET_STAGES[i].minDays) idx = i;
  }
  const cur = PET_STAGES[idx];
  const next = PET_STAGES[idx + 1] || null;
  return { stage: cur.stage, label: cur.label, playDays: days, nextDays: next ? next.minDays : null };
}

export const petStageFromLedger = (ledger, adoptedAt) => petStageFor(countPlayDaysSince(ledger, adoptedAt));

// Monday 00:00 UTC ISO week for a given finite timestamp (matches _progress.js weekOf, plus monotonic week index).
// Pure: always takes an explicit timestamp; never reads the system clock.
export function weekOf(ts) {
  const ms = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(ms)) throw new Error('weekOf requires a finite timestamp.');
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
  const thursday = new Date(start + 3 * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const n = Math.floor((thursday - yearStart) / DAY_MS / 7) + 1;
  const index = Math.floor((start - WEEK_EPOCH) / WEEK_MS);
  return { id: `${thursday.getUTCFullYear()}-W${String(n).padStart(2, '0')}`, start, end: start + WEEK_MS, index };
}

// Deterministic shiny spotlight rotation. Monotonic week index guarantees no skip or repeat across 53-week years or DST.
// Before SHINY_FIVE_FROM (week index 2972 = Mon 2026-12-21 00:00 UTC) the original 4-pet cycle applies: index mod 4 over the first four pets.
// From that week on the 5-pet cycle applies: (index - SHINY_FIVE_FROM) mod 5 over PETS. 2972 is a multiple of 4, so week 2972 is the Frog in both
// schedules; no week already scheduled under the old cycle changes before the first Yorkie week (index 2976, Mon 2027-01-18).
export const SHINY_FIVE_FROM = 2972;
// WI-11 added six pets. From SHINY_ALL_FROM (week index 2977 = Mon 2027-01-25 00:00 UTC) the cycle runs over every pet in PETS order. 2977 is five weeks after
// SHINY_FIVE_FROM, so it is the Frog under the 5-pet cycle too: no week already scheduled changes, and the new pets only ever follow the Yorkie.
export const SHINY_ALL_FROM = 2977;
const LEGACY_CYCLE = 4;
const FIVE_PETS = PETS.slice(0, 5);
const ROTATION = PETS.filter(p => p.rarity !== 'mythic'); // the Mythic pet has no weekly shiny coat
const mod = (n, m) => ((n % m) + m) % m;
export function shinyWeekFor(ts) {
  const wk = weekOf(ts);
  const pet = wk.index < SHINY_FIVE_FROM ? PETS[mod(wk.index, LEGACY_CYCLE)]
    : wk.index < SHINY_ALL_FROM ? FIVE_PETS[mod(wk.index - SHINY_FIVE_FROM, FIVE_PETS.length)]
      : ROTATION[mod(wk.index - SHINY_ALL_FROM, ROTATION.length)];
  return { weekId: wk.id, start: wk.start, end: wk.end, petId: pet.id, petName: pet.name };
}

export const isShinyFeatured = (petId, ts) => isPetId(petId) && shinyWeekFor(ts).petId === petId;

// The shiny coat is sold as `shiny-<pet id>` (ledger and Manage shop key). Default price by the pet's own price: 300 for the early cheap pets, 600 mid, 1400 later ones.
export const shinyItemId = petId => 'shiny-' + petId;
export const shinyPetOf = itemId => { const p = typeof itemId === 'string' && itemId.startsWith('shiny-') ? petById(itemId.slice(6)) : null; return p && p.rarity !== 'mythic' ? p : null; };
export const shinyPriceFor = pet => pet.price <= 250 ? 300 : pet.price <= 500 ? 600 : 1400;
export const shinyPriceOf = (pet, prices) => (prices && prices[shinyItemId(pet.id)]) || shinyPriceFor(pet);

// Full owner-private view of an owned pet row at timestamp `now`.
// `shiny` = the owned coat is worn (the flag only becomes true for an owner), whatever the week; `featuredShiny` = it is on sale this week.
export function petStateFor(row, ledger, now) {
  const pet = row && petById(row.id || row.item);
  if (!pet) return null;
  const st = petStageFromLedger(ledger, row.at);
  const featuredShiny = isShinyFeatured(pet.id, now);
  return {
    id: pet.id,
    name: pet.name,
    stage: st.stage,
    stageLabel: st.label,
    playDays: st.playDays,
    nextStageDays: st.nextDays,
    shiny: !!row.shiny,
    shinyOwned: !!(row.shinyOwned || row.shiny),
    featuredShiny
  };
}

// Strict club-visible allow-list for a worn pet row (used by clubLooksFrom in _economyshop.js).
// Emits ONLY { pet, petStage, petShiny }; never playDays, adoption time, balance or history.
export function cleanPetLook(row, now) {
  if (!row || row.slot !== 'pet') return null;
  const pet = petById(row.item);
  if (!pet) return null;
  const rawDays = row.play_days !== undefined ? row.play_days : row.playDays;
  const days = Number(rawDays);
  const stage = petStageFor(Number.isFinite(days) ? days : 0).stage;
  const petShiny = !!row.shiny;
  return { pet: pet.id, petStage: stage, petShiny };
}
