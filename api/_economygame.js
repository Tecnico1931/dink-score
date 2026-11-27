// Rewards, WI-17: per-game Dinks and weekly challenge rewards (upstream parity, the captain's call: the old rule that rewards never read a result was
// dropped for this, see DESIGN.md "Rewards"). Worked out on the server from the saved games a player is in, never from a request:
//   +2 for playing, and for a game sent from a club player's own phone (`scoredBy` / `scoredByPlayer`, set by the server) also +10 for a win,
//   +3 for beating the forecast (the rating engine's expected share of points, even in a loss) and +5 for each win that is the 3rd or later in a row.
//   At most 300 Dinks a (UTC) day from games. Weekly challenges pay +10, +10, +15 for the week's first, second and third challenge.
// Games that are edited or deleted adjust the Dinks they paid. The ledger stays append-only: each UTC day has ONE target (what its games are worth now,
// capped) and the day's `play:<day>` rows sum to what was paid. A difference becomes one more row, `play:<day>:<n>` (n = rows the day already has), so the
// same sync twice, or two phones at once, insert the same id and nothing is added twice. A take-back never leaves the balance below zero: it takes what
// the balance holds and the rest is taken from later earnings. Only the last LOOKBACK_DAYS days are ever paid or adjusted; older days are final.
// It changes no rating, score, rank or pairing. Pure functions first; the SQL that feeds them is gameEarnState; _economysync.js inserts the rows.
import { nameKey } from './_names.js';
import { likeFor } from './_privacy.js';
import { counts } from './_confirm.js';
import { compute } from './_rating.js';
import { computeProgress, weekOf } from './_progress.js';
import { loadCuts } from './_seasons.js';
import { dayNum, dayKey, ledgerBalance, gameRowDay, LOOKBACK_DAYS } from './_economy.js';
import { boostedAt, loadBoosts } from './_economyboost.js';

export const EARN = Object.freeze({ play: 2, win: 10, beat: 3, hot: 5, hotFrom: 3, cap: 300 });
export const CHALLENGE_PAY = Object.freeze([10, 10, 15]); // the week's challenges in the order the app lists them

// Sent from a club player's own phone (or the creating phone's own player): only those games earn more than the +2.
export const verifiedGame = g => !!g && ((typeof g.scoredBy === 'string' && g.scoredBy !== '' && g.scoredBy !== 'organizer') || (typeof g.scoredByPlayer === 'string' && g.scoredByPlayer !== ''));

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// What each UTC day's games are worth to `key`, before the daily cap: Map(day -> Dinks). `changes` is compute(games).changes of the rating engine.
// The win run is counted over all of the player's games in the order the server received them, so backdating a game cannot move it.
// `boosts` (_economyboost.js): a game received inside a boost window pays double, and its day (listed in the returned map's `.boosted` set) gets a doubled cap.
export function gameDays(games, key, changes = {}, boosts = []) {
  const mine = [];
  for (const g of Array.isArray(games) ? games : []) {
    if (!g || !Array.isArray(g.teams)) continue;
    const side = g.teams.findIndex(t => Array.isArray(t) && t.some(n => nameKey(n) === key)), r = Number(g.receivedAt);
    if (side >= 0 && Number.isFinite(r)) mine.push({ g, side, r });
  }
  mine.sort((a, b) => a.r - b.r || (a.g.id < b.g.id ? -1 : a.g.id > b.g.id ? 1 : 0));
  const days = new Map();
  days.boosted = new Set();
  let run = 0;
  for (const { g, side, r } of mine) {
    const w = g.winner == null || g.winner === '' ? NaN : Number(g.winner), won = w === side;
    run = won ? run + 1 : 0;
    let n = EARN.play;
    if (verifiedGame(g)) {
      const ch = changes[g.id], edge = ch ? (side === 0 ? ch.usedShareA - ch.expected : ch.expected - ch.usedShareA) : 0;
      if (won) n += EARN.win;
      if (edge > 1e-9) n += EARN.beat;
      if (won && run >= EARN.hotFrom) n += EARN.hot;
    }
    const d = utcDay(r);
    if (boostedAt(boosts, r)) { n *= 2; days.boosted.add(d); }
    days.set(d, (days.get(d) || 0) + n);
  }
  return days;
}

// New ledger rows that bring each recent day's paid Dinks to its target. Idempotent: planning again from the ledger that includes these rows gives [].
export function planGameRows({ ledger = [], days, now }) {
  const today = dayNum(dayKey(now, 0)), paid = new Map(), rows = new Map();
  for (const e of ledger) {
    const d = gameRowDay(e.id);
    if (d) { paid.set(d, (paid.get(d) || 0) + e.amount); rows.set(d, (rows.get(d) || 0) + 1); }
  }
  const recent = [...new Set([...days.keys(), ...paid.keys()])].filter(d => dayNum(d) >= today - LOOKBACK_DAYS && dayNum(d) <= today).sort();
  let bal = ledgerBalance(ledger);
  const out = [];
  for (const d of recent) {
    const delta = Math.min(EARN.cap * (days.boosted && days.boosted.has(d) ? 2 : 1), days.get(d) || 0) - (paid.get(d) || 0);
    if (!delta) continue;
    const n = rows.get(d) || 0, id = n ? `play:${d}:${n}` : `play:${d}`;
    if (delta > 0) { out.push({ id, kind: 'earn', amount: delta, reason: 'game', day: null, streak: null }); bal += delta; continue; }
    const take = Math.min(-delta, bal);
    if (take > 0) { out.push({ id, kind: 'spend', amount: -take, reason: 'game-adj', day: null, streak: null }); bal -= take; }
  }
  return out;
}

// Weekly challenge rewards: `weeks` is { weekId: [{ id, done }] } in the week's challenge order. One row per finished challenge, paid once.
export function planChallengeRows({ ledger = [], weeks = {} }) {
  const have = new Set(ledger.map(e => e.id)), out = [];
  for (const [wk, items] of Object.entries(weeks)) (items || []).forEach((c, i) => {
    const id = `chal:${wk}:${c.id}`;
    if (c.done && !have.has(id)) out.push({ id, kind: 'earn', amount: CHALLENGE_PAY[Math.min(i, CHALLENGE_PAY.length - 1)], reason: 'challenge', day: null, streak: null });
  });
  return out;
}

// Reads what the plans need. Cheap when the player has no game in the last LOOKBACK_DAYS and nothing paid there (the common idle phone); otherwise it
// replays the club's counted games once (as a club answer does) for the forecast and the challenge progress.
export async function gameEarnState(sql, club, key, { ledger, now }) {
  const code = club.code, required = !!club.require_confirmation;
  const rows = await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND deleted_at IS NULL AND lower(data->>'teams') LIKE ${likeFor(key)} ORDER BY ended_at DESC LIMIT 3000`;
  const mine = rows.map(r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: true } : {}) })).filter(g => counts(g, required));
  const floor = dayNum(dayKey(now, 0)) - LOOKBACK_DAYS;
  // Any game at all: achievements and season prizes can come due with no recent game (a season ending).
  if (!mine.length && !ledger.some(e => { const d = gameRowDay(e.id); return d && dayNum(d) >= floor; })) return { days: new Map(), weeks: {}, me: null };
  const all = (await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at, id`)
    .map(r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: true } : {}) })).filter(g => counts(g, required));
  const { changes } = compute(all);
  const me = computeProgress(all, now, await loadCuts(sql, code)).get(key), weeks = {};
  for (const id of [weekOf(now).id, weekOf(now - 7 * 864e5).id]) if (me && me.weeks[id]) weeks[id] = me.weeks[id];
  // Achievements and season prizes pay only for games that earn more than the +2 (sent from a club player's own phone), so they are
  // worked out again over those games alone; the badge a phone shows may rest on others.
  const paid = me && (me.achievements.length || me.trophies.length) ? computeProgress(all.filter(verifiedGame), now, await loadCuts(sql, code)).get(key) : null;
  return { days: gameDays(mine, key, changes, await loadBoosts(sql, code)), weeks, me: paid || null };
}
