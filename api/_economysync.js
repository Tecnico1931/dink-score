// Rewards sync (slice 2): reads a player's saved-game times, appends their new earn rows to reward_ledger, returns the balance. Not a
// route (files starting with "_"); players.js calls it for the rewards-sync and rewards-get actions. It reads only a game's players,
// who sent it and when the server got it, never a score or a rating.
import { nameKey } from './_names.js';
import { likeFor } from './_privacy.js';
import { deriveEarnings, summary, validEntry, cleanTz, LOOKBACK_DAYS, RECENT } from './_economy.js';
import { gameEarnState, planGameRows, planChallengeRows } from './_economygame.js';

export async function loadLedger(sql, code, key) {
  return (await sql`SELECT id, kind, amount, reason, day, streak, at FROM reward_ledger WHERE club = ${code} AND name_key = ${key} ORDER BY at ASC, id ASC`)
    .map(r => ({ id: r.id, kind: r.kind, amount: Number(r.amount), reason: r.reason, day: r.day, streak: r.streak == null ? null : Number(r.streak), at: r.at }));
}

const view = (ledger, tz, now, gained = 0) => ({ ...summary(ledger, tz, now), gained, entries: ledger.slice(-RECENT).reverse().map(({ id, kind, amount, reason, day, streak }) => ({ id, kind, amount, reason, day, streak })) });

// Appends the rows, each at most once (the id is the key); returns the Dinks that came in (a take-back is not a gain).
async function append(sql, code, key, rows) {
  let gained = 0;
  for (const e of rows.filter(validEntry)) {
    const ins = await sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
      VALUES (${code}, ${key}, ${e.id}, ${e.kind}, ${e.amount}, ${e.reason}, ${e.day}, ${e.streak}) ON CONFLICT DO NOTHING RETURNING id`;
    if (ins.length && e.amount > 0) gained += e.amount;
  }
  return gained;
}

// sync: true appends what the saved games earn since the last paid day, then (WI-17, given the club row) what each recent day's games and the week's
// challenges are worth now, adjusting for games edited or deleted since; false only reads.
export async function rewardsFor(sql, code, name, { tz, sync, now = Date.now(), club }) {
  const key = nameKey(name), zone = cleanTz(tz);
  let ledger = await loadLedger(sql, code, key);
  if (!sync) return view(ledger, zone, now);
  const since = now - (LOOKBACK_DAYS + 2) * 864e5;
  const rows = await sql`SELECT data->'teams' AS teams, data->>'receivedAt' AS r FROM games
    WHERE club = ${code} AND deleted_at IS NULL AND (data->>'scoredBy' = ${key} OR data->>'scoredByPlayer' = ${key}) AND (data->>'receivedAt')::bigint >= ${since}
      AND lower(data->>'teams') LIKE ${likeFor(key)} ORDER BY ended_at DESC LIMIT 2000`;
  const mine = rows.filter(g => (g.teams || []).flat().some(n => nameKey(n) === key)).map(g => Number(g.r));
  let gained = await append(sql, code, key, deriveEarnings({ ledger, receivedAt: mine, tz: zone, now }));
  if (gained) ledger = await loadLedger(sql, code, key);
  if (club) {
    const st = await gameEarnState(sql, club, key, { ledger, now });
    const n = await append(sql, code, key, [...planGameRows({ ledger, days: st.days, now }), ...planChallengeRows({ ledger, weeks: st.weeks })]);
    gained += n;
    ledger = await loadLedger(sql, code, key);
  }
  return view(ledger, zone, now, gained);
}
