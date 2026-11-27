// Rewards, M13: pet XP and levels (upstream parity, the captain's C8 call). A pet earns 1 XP for each verified game its owner plays and 2 for each win
// (a game sent from a club player's own phone, `verifiedGame`), counted from the day it was adopted and from PETXP_FROM on. Levels follow PET_LV; the
// Grown stage starts at level 4 and Champion at level 8. Nobody loses progress: before the switch a pet grew by verified play days (Rookie 0-4,
// Club 5-14, Veteran 15+), and that stage is the starting point, Club = the XP of level 4 and Veteran = the XP of level 8, with new XP added on top.
// Pure functions first (no clock, no randomness); loadPlays/loadClubPlays are the only SQL. Nothing here changes a rating, score, rank or pairing.
import { nameKey } from './_names.js';
import { likeFor } from './_privacy.js';
import { counts } from './_confirm.js';
import { verifiedGame } from './_economygame.js';

export const PET_LV = Object.freeze([0, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
export const PET_LEVEL_MAX = PET_LV.length;
export const PET_XP = Object.freeze({ game: 1, win: 2 });
export const PET_GROWN_LEVEL = 4, PET_CHAMPION_LEVEL = 8;
// First moment games give pet XP (00:00 UTC). Play days before it set the starting point; games after it are XP.
export const PETXP_FROM = Date.UTC(2026, 10, 28);
export const PETXP_FROM_DAY = new Date(PETXP_FROM).toISOString().slice(0, 10);
// The old play-day stages (5 and 15 verified days) become the XP of the level where the new stage starts.
const LEGACY_CLUB_DAYS = 5, LEGACY_VETERAN_DAYS = 15;

export const PET_STAGES = Object.freeze([
  Object.freeze({ stage: 1, label: 'Rookie', minLevel: 1 }),
  Object.freeze({ stage: 2, label: 'Grown', minLevel: PET_GROWN_LEVEL }),
  Object.freeze({ stage: 3, label: 'Champion', minLevel: PET_CHAMPION_LEVEL })
]);

// Where a total of pet XP puts a pet: level 1..10, the XP the level started at and the XP of the next level (null at the top).
export function petLevelFor(total) {
  const xp = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  let level = 1;
  while (level < PET_LEVEL_MAX && xp >= PET_LV[level]) level++;
  return { xp, level, max: PET_LEVEL_MAX, levelXp: PET_LV[level - 1], nextXp: level < PET_LEVEL_MAX ? PET_LV[level] : null };
}

export function petStageForLevel(level) {
  let cur = PET_STAGES[0];
  for (const s of PET_STAGES) if (level >= s.minLevel) cur = s;
  return cur;
}

// The starting XP of a pet from the verified play days it had before the switch (days on or after adoption and before PETXP_FROM_DAY).
export function legacyFloorXp(playDays) {
  const d = Number.isFinite(playDays) ? Math.floor(playDays) : 0;
  return d >= LEGACY_VETERAN_DAYS ? PET_LV[PET_CHAMPION_LEVEL - 1] : d >= LEGACY_CLUB_DAYS ? PET_LV[PET_GROWN_LEVEL - 1] : 0;
}

// Distinct verified earn days of the ledger from the adoption day up to (not including) the switch day.
export function legacyPlayDays(ledger, adoptedDay) {
  if (!adoptedDay || !Array.isArray(ledger)) return 0;
  const days = new Set();
  for (const e of ledger) {
    if (e && e.kind === 'earn' && typeof e.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.day) && e.day >= adoptedDay && e.day < PETXP_FROM_DAY) days.add(e.day);
  }
  return days.size;
}

// Pure: one { r, xp } per verified game of each key in `keys` (receivedAt and XP: 1, or 2 for a win). Games with no receivedAt or not from a club
// player's phone are skipped. `games` are game data objects (club rows, already filtered by counts()).
export function playsByKeys(games, keys) {
  const want = new Set(keys), out = new Map([...want].map(k => [k, []]));
  for (const g of Array.isArray(games) ? games : []) {
    if (!g || !Array.isArray(g.teams) || !verifiedGame(g)) continue;
    const r = Number(g.receivedAt);
    if (!Number.isFinite(r) || r < PETXP_FROM) continue;
    const w = g.winner == null || g.winner === '' ? NaN : Number(g.winner);
    g.teams.forEach((team, side) => {
      if (!Array.isArray(team)) return;
      for (const k of new Set(team.map(nameKey))) if (want.has(k)) out.get(k).push({ r, xp: w === side ? PET_XP.win : PET_XP.game });
    });
  }
  return out;
}

// Pure: the pet XP of one pet adopted at `adoptedMs` from its owner's plays and the verified play days it had before the switch.
export function petXpOf(plays, adoptedMs, legacyDays) {
  const since = Number.isFinite(adoptedMs) ? adoptedMs : 0;
  let xp = legacyFloorXp(legacyDays);
  for (const p of Array.isArray(plays) ? plays : []) if (p.r >= since) xp += p.xp;
  return xp;
}

const required = async (sql, code) => { const [c] = await sql`SELECT require_confirmation FROM clubs WHERE code = ${code}`; return !!(c && c.require_confirmation); };
const asGame = r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: true } : {}) });

// One player's plays (see playsByKeys) from the games their club counts.
export async function loadPlays(sql, code, key) {
  const req = await required(sql, code);
  const rows = await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND deleted_at IS NULL AND (data->>'receivedAt')::bigint >= ${PETXP_FROM}
    AND lower(data->>'teams') LIKE ${likeFor(key)} ORDER BY ended_at DESC LIMIT 3000`;
  return playsByKeys(rows.map(asGame).filter(g => counts(g, req)), [key]).get(key) || [];
}

// Plays for several players at once (the club's shared looks): one query for the whole club.
export async function loadClubPlays(sql, code, keys) {
  if (!keys.length) return new Map();
  const req = await required(sql, code);
  const rows = await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND deleted_at IS NULL AND (data->>'receivedAt')::bigint >= ${PETXP_FROM}
    ORDER BY ended_at DESC LIMIT 20000`;
  return playsByKeys(rows.map(asGame).filter(g => counts(g, req)), keys);
}
