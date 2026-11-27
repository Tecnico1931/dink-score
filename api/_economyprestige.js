// Rewards: prestige. A player at the top level (25, _economyxp.js) can start again from level 1: they keep a star by their level for good and get
// PRESTIGE_DINKS once. Server side only: the level is worked out from the player's own saved games (never a client claim) and the whole state is the
// ledger: one append-only earn row `prestige:<n>` per run (n = the new count), so there is no new column or table, and rename/merge, export and
// anonymise already cover it. A run costs exactly RUN_XP = LEVEL_XP[LEVEL_MAX - 1] XP, so the level is levelFor(allXp - count * RUN_XP) and XP earned
// past level 25 carries into the next run. The id is the key, so a double tap, a replay or a race pays and counts once. It changes no rating, score,
// rank or pairing; stars and levels reach other members only for those who opted in to showing their look (clubLevels), like the worn items.
// Called from players.js (rewards-restart) through _economypass.js.
import { LEVEL_XP, LEVEL_MAX, levelFor, xpFromGames } from './_economyxp.js';

export const PRESTIGE_DINKS = 250;
export const RUN_XP = LEVEL_XP[LEVEL_MAX - 1];
export const prestigeId = n => `prestige:${n}`;
// Also matches a row a merge moved under `m:<name key>:`.
const ROW = /(?:^|:)prestige:\d+$/;
export const prestigeCount = ledger => (Array.isArray(ledger) ? ledger : []).filter(e => e && e.kind === 'earn' && ROW.test(String(e.id))).length;

// The level card of a player: XP of this run through levelFor, with the all-time XP for the label.
export function runLevel(allXp, count) {
  const xp = Math.max(0, Math.trunc(Number(allXp) || 0));
  return { ...levelFor(Math.max(0, xp - Math.max(0, Math.trunc(Number(count) || 0)) * RUN_XP)), xp };
}

// Pure: plan one prestige. Throws { status: 409 } unless the player is at the top level of the current run.
export function planPrestige({ ledger = [], allXp = 0 }) {
  const count = prestigeCount(ledger) + 1, lv = runLevel(allXp, count - 1);
  if (lv.level < LEVEL_MAX) throw Object.assign(new Error(`Reach level ${LEVEL_MAX} first. ${lv.toNext} XP to level ${lv.level + 1}.`), { status: 409 });
  return { count, entry: { id: prestigeId(count), kind: 'earn', amount: PRESTIGE_DINKS, reason: 'prestige', day: null, streak: null } };
}

// False when that row is already there (a race lost or a replay): nothing is paid twice.
export async function applyPrestige(sql, code, key, entry) {
  const out = await sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason)
    VALUES (${code}, ${key}, ${entry.id}, 'earn', ${entry.amount}, ${entry.reason}) ON CONFLICT DO NOTHING RETURNING id`;
  return out.length > 0;
}

// Pure: level and star count of the players in `keys` from saved games (rows as _economypass.js loads them) and their prestige row counts.
export function levelsFrom(rows, counts, keys) {
  const by = new Map();
  for (const g of rows) for (const k of new Set([g.scored_by, g.scored_by_player])) if (k) (by.get(k) || by.set(k, []).get(k)).push(g);
  const out = Object.create(null);
  for (const k of keys) {
    const n = Math.max(0, Math.trunc(Number(counts[k]) || 0));
    out[k] = { level: runLevel(xpFromGames(by.get(k) || [], k), n).level, prestige: n };
  }
  return out;
}

// Level and stars for club members who opted in to showing their look (roster.rewards_public), keyed by name key. Nothing for anyone else.
export async function clubLevels(sql, code) {
  const keys = (await sql`SELECT name_key FROM roster WHERE club = ${code} AND rewards_public = true AND blocked_at IS NULL`).map(m => m.name_key);
  if (!keys.length) return {};
  const [rows, marks] = await Promise.all([
    sql`SELECT data->'teams' AS teams, data->>'receivedAt' AS r, data->>'winner' AS winner, data->>'scoredBy' AS scored_by, data->>'scoredByPlayer' AS scored_by_player
      FROM games WHERE club = ${code} AND deleted_at IS NULL AND data->>'receivedAt' IS NOT NULL
        AND (data->>'scoredBy' = ANY(${keys}) OR data->>'scoredByPlayer' = ANY(${keys})) ORDER BY ended_at DESC LIMIT 20000`,
    sql`SELECT name_key, id FROM reward_ledger WHERE club = ${code} AND name_key = ANY(${keys}) AND kind = 'earn' AND id ~ '(^|:)prestige:[0-9]+$'`
  ]);
  const counts = {};
  for (const m of marks) counts[m.name_key] = (counts[m.name_key] || 0) + 1;
  return levelsFrom(rows, counts, keys);
}
