// Rewards, slice 5: free Season Pass. A short 10-tier track per club season filled by play (games saved by the player's own verified
// phone in the current club season, derived here on the server from saved games — never from client claims). Pays Dinks and a few free
// cosmetic items from the existing shop catalogue (_economyshop.js). No paid tier, no real money, no randomness, no FOMO pressure, and
// nothing here reads or changes a score, a rating, a rank or a pairing (progress counts games played, never results).
//
// Season boundary: uses the club's existing season via seasonAt(now, cuts) from _progress.js / _seasons.js (UTC calendar quarters by
// default, or the club's custom season when an organizer ends a season early).
//
// Claims are idempotent append-only earn rows in reward_ledger (id: `pass:<seasonId>:<tier>`, amount > 0, day: null, streak: null so the
// daily streak is untouched), and any free cosmetic item is inserted into reward_items (ON CONFLICT DO NOTHING). If a player already owns
// a cosmetic tier's item, claiming that tier pays the item's Dinks value instead (shown before tapping Claim). Called from players.js as
// rewards-pass and rewards-pass-claim.
import { nameKey } from './_names.js';
import { likeFor } from './_privacy.js';
import { seasonAt } from './_progress.js';
import { loadCuts } from './_seasons.js';
import { ledgerBalance, validEntry } from './_economy.js';
import { loadLedger } from './_economysync.js';
import { itemById, loadItems, wornFrom, shareOf } from './_economyshop.js';

// 10-tier track per club season. Every `item` id comes from CATALOGUE in _economyshop.js.
// `games` is cumulative games played and saved by this player's verified phone during the current club season.
export const PASS_TIERS = [
  { tier: 1, games: 1, dinks: 2, item: null },
  { tier: 2, games: 3, dinks: 3, item: null },
  { tier: 3, games: 5, dinks: 2, item: 'frame-court' },
  { tier: 4, games: 8, dinks: 4, item: null },
  { tier: 5, games: 11, dinks: 5, item: null },
  { tier: 6, games: 15, dinks: 2, item: 'paddle-court' },
  { tier: 7, games: 19, dinks: 6, item: null },
  { tier: 8, games: 24, dinks: 2, item: 'frame-blue' },
  { tier: 9, games: 29, dinks: 8, item: null },
  { tier: 10, games: 35, dinks: 5, item: 'paddle-stripe' }
];

export const tierByNum = tier => (Number.isInteger(tier) ? PASS_TIERS.find(t => t.tier === tier) || null : null);
export const passClaimId = (seasonId, tier) => `pass:${seasonId}:${tier}`;

// Pure: count games saved by this player's verified phone within the current season where this player played.
// Reads only teams, sender key and server receive time — never scores, winners, ratings or ranks.
export function countSeasonGames(games, key, season) {
  if (!key || !season || !Number.isFinite(season.start) || !Number.isFinite(season.end)) return 0;
  let count = 0;
  for (const g of Array.isArray(games) ? games : []) {
    if (!g) continue;
    const by = g.scoredBy ?? g.scored_by;
    const byPlayer = g.scoredByPlayer ?? g.scored_by_player;
    if ((by !== undefined || byPlayer !== undefined) && by !== key && byPlayer !== key) continue;
    const r = Number(g.r ?? g.receivedAt);
    if (!Number.isFinite(r) || r < season.start || r >= season.end) continue;
    if ((g.teams || []).flat().some(n => nameKey(n) === key)) count++;
  }
  return count;
}

// Pure: build the Season Pass view sent to the player's phone.
export function buildPassView({ season, games, ledger, items, share = false }) {
  const claimedIds = new Set((ledger || []).map(e => e.id));
  const ownedIds = new Set((items || []).map(i => i.id));
  const played = Math.max(0, Math.trunc(Number(games) || 0));
  const tiers = PASS_TIERS.map(t => {
    const cat = t.item ? itemById(t.item) : null;
    const owned = !!(cat && ownedIds.has(cat.id));
    const claimed = claimedIds.has(passClaimId(season.id, t.tier));
    const unlocked = played >= t.games;
    const payoutDinks = cat && owned ? cat.price : t.dinks;
    return {
      tier: t.tier,
      games: t.games,
      dinks: t.dinks,
      payoutDinks,
      item: cat ? { id: cat.id, slot: cat.slot, name: cat.name, price: cat.price, owned } : null,
      unlocked,
      claimed
    };
  });
  const claimable = tiers.filter(t => t.unlocked && !t.claimed).length;
  return {
    season: { id: season.id, name: season.name, start: season.start, end: season.end },
    games: played,
    dinks: ledgerBalance(ledger || []),
    worn: wornFrom(items || []),
    share: !!share,
    claimable,
    tiers
  };
}

// Pure: plan a single tier claim. Throws { status, message } when invalid or not yet earned; returns { already: true } on replay.
export function planPassClaim({ ledger = [], owned = [], games = 0, season, tier }) {
  const t = tierByNum(tier);
  if (!t) throw Object.assign(new Error('Pick a tier from the season pass.'), { status: 400 });
  if (!season || typeof season.id !== 'string' || !/^[A-Za-z0-9_-]{4,24}$/.test(season.id)) {
    throw Object.assign(new Error('Season pass is not ready right now.'), { status: 400 });
  }
  const id = passClaimId(season.id, t.tier);
  if (ledger.some(e => e.id === id)) return { tier: t, already: true, entry: null, item: null, alreadyOwned: false };
  const played = Math.max(0, Math.trunc(Number(games) || 0));
  if (played < t.games) {
    const need = t.games - played;
    throw Object.assign(new Error(`Play ${need} more ${need === 1 ? 'game' : 'games'} this season to unlock tier ${t.tier}.`), { status: 409 });
  }
  const cat = t.item ? itemById(t.item) : null;
  const alreadyOwned = !!(cat && owned.includes(cat.id));
  const amount = cat && alreadyOwned ? cat.price : t.dinks;
  const grantItem = cat && !alreadyOwned ? cat : null;
  const reason = grantItem ? 'pass:' + grantItem.id : cat ? 'pass:owned:' + cat.id : 'pass:tier-' + t.tier;
  const entry = { id, kind: 'earn', amount, reason: reason.slice(0, 40), day: null, streak: null };
  if (!validEntry(entry)) throw Object.assign(new Error('Could not build season pass reward.'), { status: 500 });
  return { tier: t, already: false, entry, item: grantItem, alreadyOwned };
}

async function loadSeasonState(sql, code, key, now) {
  const cuts = await loadCuts(sql, code);
  const season = seasonAt(now, cuts);
  const [rows, ledger, items, share] = await Promise.all([
    sql`SELECT data->'teams' AS teams, data->>'receivedAt' AS r, data->>'scoredBy' AS scored_by, data->>'scoredByPlayer' AS scored_by_player
      FROM games
      WHERE club = ${code} AND deleted_at IS NULL
        AND (data->>'scoredBy' = ${key} OR data->>'scoredByPlayer' = ${key})
        AND data->>'receivedAt' IS NOT NULL
        AND (data->>'receivedAt')::bigint >= ${season.start}
        AND (data->>'receivedAt')::bigint < ${season.end}
        AND lower(data->>'teams') LIKE ${likeFor(key)}
      ORDER BY ended_at DESC LIMIT 2000`,
    loadLedger(sql, code, key),
    loadItems(sql, code, key),
    shareOf(sql, code, key)
  ]);
  return { season, games: countSeasonGames(rows, key, season), ledger, items, share };
}

export async function passView(sql, code, key, now = Date.now()) {
  const st = await loadSeasonState(sql, code, key, now);
  return buildPassView(st);
}

// Claim one unlocked tier in the current club season. Atomic under a per-player advisory lock: a replay or race adds nothing twice.
export async function claimPassTier(sql, code, key, tierNum, { seasonId, now = Date.now() } = {}) {
  const st = await loadSeasonState(sql, code, key, now);
  if (typeof seasonId === 'string' && seasonId && seasonId !== st.season.id) {
    throw Object.assign(new Error('The season has changed since you opened this. Reload and check the current season.'), { status: 409 });
  }
  const plan = planPassClaim({ ledger: st.ledger, owned: st.items.map(i => i.id), games: st.games, season: st.season, tier: tierNum });
  if (plan.already) return { ...buildPassView(st), claimed: false, gained: 0, granted: null };
  const ops = [
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason)
      VALUES (${code}, ${key}, ${plan.entry.id}, 'earn', ${plan.entry.amount}, ${plan.entry.reason})
      ON CONFLICT DO NOTHING RETURNING id`
  ];
  if (plan.item) {
    ops.push(sql`INSERT INTO reward_items (club, name_key, item, slot)
      SELECT ${code}, ${key}, ${plan.item.id}, ${plan.item.slot}
      WHERE EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${plan.entry.id})
      ON CONFLICT DO NOTHING`);
  }
  const [, ins] = await sql.transaction(ops);
  const claimed = Array.isArray(ins) && ins.length > 0;
  const next = await passView(sql, code, key, now);
  return {
    ...next,
    claimed,
    gained: claimed ? plan.entry.amount : 0,
    granted: claimed && plan.item ? { id: plan.item.id, slot: plan.item.slot, name: plan.item.name } : null
  };
}
