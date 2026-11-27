// Rewards, WI-14: XP and levels, and the pass-only items the XP season pass hands out. XP is computed here on the server from games the player's own
// verified phone saved (scoredBy / scoredByPlayer), never from anything a request says. This is the one economy file that reads a result: it looks at
// who played, who sent the game, when the server got it and which side won (for the win bonus), and never a score, a rating, a rank or a pairing.
// Parity with the upstream app (the captain's call): 10 XP a game, 15 for a win, at most 300 XP a (UTC) day, 25 levels. XP only fills a level card and
// the season pass; it changes no rating, score or rule. Pure; _economypass.js and players.js call it.
import { nameKey } from './_names.js';
import { boostedAt } from './_economyboost.js';

export const XP_GAME = 10, XP_WIN = 15, XP_DAY_CAP = 300, LEVEL_MAX = 25;
// XP to go from level n to n+1 (n = 1..24): 40, 50, 60 ... 270. Level 25 needs 3720 XP in all.
export const levelStep = n => 30 + 10 * n;
export const LEVEL_XP = Object.freeze(Array.from({ length: LEVEL_MAX }, (_, i) => { let x = 0; for (let n = 1; n <= i; n++) x += levelStep(n); return x; }));

// Pure: where a total of XP puts a player.
export function levelFor(total) {
  const xp = Math.max(0, Math.trunc(Number(total) || 0));
  let level = 1;
  while (level < LEVEL_MAX && xp >= LEVEL_XP[level]) level++;
  const max = level >= LEVEL_MAX;
  return { xp, level, max: LEVEL_MAX, toNext: max ? 0 : LEVEL_XP[level] - xp, into: xp - LEVEL_XP[level - 1], step: max ? 0 : levelStep(level) };
}

const DAY = 864e5;
// Pure: XP from saved games for one player, optionally only those received in [from, to). Each UTC day is capped at XP_DAY_CAP.
// `boosts` (_economyboost.js, XP ticked): a game received in a boost window gives double, and its day's cap doubles.
export function xpFromGames(games, key, { from = -Infinity, to = Infinity, boosts = [] } = {}) {
  if (!key) return 0;
  const perDay = new Map(), boosted = new Set();
  for (const g of Array.isArray(games) ? games : []) {
    if (!g) continue;
    const by = g.scoredBy ?? g.scored_by, byPlayer = g.scoredByPlayer ?? g.scored_by_player;
    if ((by !== undefined || byPlayer !== undefined) && by !== key && byPlayer !== key) continue;
    const r = Number(g.r ?? g.receivedAt);
    if (!Number.isFinite(r) || r < from || r >= to) continue;
    const teams = Array.isArray(g.teams) ? g.teams : [];
    const side = teams.findIndex(t => Array.isArray(t) && t.some(n => nameKey(n) === key));
    if (side < 0) continue;
    const w = g.winner == null || g.winner === '' ? NaN : Number(g.winner);
    const day = Math.floor(r / DAY);
    const up = boostedAt(boosts, r, 'xp');
    if (up) boosted.add(day);
    perDay.set(day, (perDay.get(day) || 0) + (XP_GAME + (w === side ? XP_WIN - XP_GAME : 0)) * (up ? 2 : 1));
  }
  let total = 0;
  for (const [day, v] of perDay) total += Math.min(XP_DAY_CAP * (boosted.has(day) ? 2 : 1), v);
  return total;
}

// Pass-only items: not in CATALOGUE, so never sold, never in the box. Looked up through itemById in _economyshop.js, so an owned one stays wearable.
// Ids are `<slot>-<word>` (3-12 letters). The phone mirrors the titles and the style name (RW_TITLES / RW_STYLES in src/app/economy.js).
const p = (slot, id, name) => Object.freeze({ id: slot + '-' + id, slot, name, price: 0, rarity: 'rare', pass: true });
export const PASS_ITEMS = Object.freeze([
  p('title', 'grinder', 'The Grinder'),
  p('frame', 'season', 'Season ring'),
  p('sound', 'whistle', "Ref's whistle"),
  p('style', 'courtline', 'Court line name'),
  p('title', 'closer', 'The Closer'),
  p('title', 'rallyking', 'Rally Machine'),
  p('frame', 'trophy', 'Trophy ring')
]);
