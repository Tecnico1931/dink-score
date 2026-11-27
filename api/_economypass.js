// Rewards, WI-14: the XP season pass. An 8-tier track per club season, 125 season XP a tier (1000 in all). Season XP is the XP (_economyxp.js) from games
// the player's own verified phone saved in the current club season, derived on the server from saved games, never from a client claim. Every tier
// pays 25 Dinks; a tier with an item also grants it the first time (the items are pass-only: not in the shop, not in the box, so they can't be bought).
// A tier whose item is already owned pays just the 25 Dinks. No paid tier, no real money, no randomness, and nothing here changes a rating, a rank
// or a pairing.
//
// Season boundary: uses the club's existing season via seasonAt(now, cuts) from _progress.js / _seasons.js (UTC calendar quarters by
// default, or the club's custom season when an organizer ends a season early).
//
// Claims are idempotent append-only earn rows in reward_ledger (id: `xpass:<seasonId>:<tier>`, amount > 0, day: null, streak: null so the
// daily streak is untouched), and any item is inserted into reward_items (ON CONFLICT DO NOTHING). Called from players.js as rewards-pass and
// rewards-pass-claim. The old games-played pass used `pass:` ids; those rows stay in the ledger untouched.
import { likeFor } from './_privacy.js';
import { seasonAt } from './_progress.js';
import { loadCuts } from './_seasons.js';
import { ledgerBalance, validEntry } from './_economy.js';
import { loadLedger } from './_economysync.js';
import { itemById, loadItems, wornFrom, shareOf } from './_economyshop.js';
import { xpFromGames, levelFor } from './_economyxp.js';
import { loadBoosts } from './_economyboost.js';

export const PASS_XP_TIER = 125, PASS_DINKS = 25;
// 8 tiers. Every `item` id comes from PASS_ITEMS in _economyxp.js (null = Dinks only).
const ITEMS = ['title-grinder', 'frame-season', 'sound-whistle', 'style-courtline', 'title-closer', null, 'title-rallyking', 'frame-trophy'];
export const PASS_TIERS = ITEMS.map((item, i) => ({ tier: i + 1, xp: PASS_XP_TIER * (i + 1), dinks: PASS_DINKS, item }));
export const PASS_MAX_XP = PASS_TIERS[PASS_TIERS.length - 1].xp;

export const tierByNum = tier => (Number.isInteger(tier) ? PASS_TIERS.find(t => t.tier === tier) || null : null);
export const passClaimId = (seasonId, tier) => `xpass:${seasonId}:${tier}`;

// Pure: build the Season Pass view sent to the player's phone. `xp` is this season's XP, `allXp` the player's XP over all games (the level card).
export function buildPassView({ season, xp, allXp = 0, ledger, items, share = false }) {
  const claimedIds = new Set((ledger || []).map(e => e.id));
  const ownedIds = new Set((items || []).map(i => i.id));
  const earned = Math.max(0, Math.trunc(Number(xp) || 0));
  const tiers = PASS_TIERS.map(t => {
    const cat = t.item ? itemById(t.item) : null;
    const owned = !!(cat && ownedIds.has(cat.id));
    return {
      tier: t.tier,
      xp: t.xp,
      dinks: t.dinks,
      payoutDinks: t.dinks,
      item: cat ? { id: cat.id, slot: cat.slot, name: cat.name, owned } : null,
      unlocked: earned >= t.xp,
      claimed: claimedIds.has(passClaimId(season.id, t.tier))
    };
  });
  return {
    season: { id: season.id, name: season.name, start: season.start, end: season.end },
    xp: earned,
    maxXp: PASS_MAX_XP,
    tierXp: PASS_XP_TIER,
    level: levelFor(allXp),
    dinks: ledgerBalance(ledger || []),
    worn: wornFrom(items || []),
    share: !!share,
    claimable: tiers.filter(t => t.unlocked && !t.claimed).length,
    tiers
  };
}

// Pure: plan a single tier claim. Throws { status, message } when invalid or not yet earned; returns { already: true } on replay.
export function planPassClaim({ ledger = [], owned = [], xp = 0, season, tier }) {
  const t = tierByNum(tier);
  if (!t) throw Object.assign(new Error('Pick a tier from the season pass.'), { status: 400 });
  if (!season || typeof season.id !== 'string' || !/^[A-Za-z0-9_-]{4,24}$/.test(season.id)) {
    throw Object.assign(new Error('Season pass is not ready right now.'), { status: 400 });
  }
  const id = passClaimId(season.id, t.tier);
  if (ledger.some(e => e.id === id)) return { tier: t, already: true, entry: null, item: null, alreadyOwned: false };
  const earned = Math.max(0, Math.trunc(Number(xp) || 0));
  if (earned < t.xp) {
    throw Object.assign(new Error(`Earn ${t.xp - earned} more season XP to unlock tier ${t.tier}.`), { status: 409 });
  }
  const cat = t.item ? itemById(t.item) : null;
  const alreadyOwned = !!(cat && owned.includes(cat.id));
  const grantItem = cat && !alreadyOwned ? cat : null;
  const reason = grantItem ? 'pass:' + grantItem.id : cat ? 'pass:owned:' + cat.id : 'pass:tier-' + t.tier;
  const entry = { id, kind: 'earn', amount: t.dinks, reason: reason.slice(0, 40), day: null, streak: null };
  if (!validEntry(entry)) throw Object.assign(new Error('Could not build season pass reward.'), { status: 500 });
  return { tier: t, already: false, entry, item: grantItem, alreadyOwned };
}

async function loadSeasonState(sql, code, key, now) {
  const cuts = await loadCuts(sql, code);
  const season = seasonAt(now, cuts);
  const [rows, ledger, items, share, boosts] = await Promise.all([
    sql`SELECT data->'teams' AS teams, data->>'receivedAt' AS r, data->>'winner' AS winner, data->>'scoredBy' AS scored_by, data->>'scoredByPlayer' AS scored_by_player
      FROM games
      WHERE club = ${code} AND deleted_at IS NULL
        AND (data->>'scoredBy' = ${key} OR data->>'scoredByPlayer' = ${key})
        AND data->>'receivedAt' IS NOT NULL
        AND lower(data->>'teams') LIKE ${likeFor(key)}
      ORDER BY ended_at DESC LIMIT 5000`,
    loadLedger(sql, code, key),
    loadItems(sql, code, key),
    shareOf(sql, code, key),
    loadBoosts(sql, code)
  ]);
  return { season, xp: xpFromGames(rows, key, { from: season.start, to: season.end, boosts }), allXp: xpFromGames(rows, key, { boosts }), ledger, items, share };
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
  const plan = planPassClaim({ ledger: st.ledger, owned: st.items.map(i => i.id), xp: st.xp, season: st.season, tier: tierNum });
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
