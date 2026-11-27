// Rewards, organizer tools (M11, upstream parity; the captain's call, DESIGN.md "Rewards"): give or take Dinks with a reason, gift an item, let a
// player spin again today, and run a boost event. Called from players.js as rewards-adjust | rewards-gift | rewards-spin-reset | rewards-boost*,
// all behind requireOrganizer and only where the club has rewards on. Play money only: nothing here reads or changes a score, rating, rank or pairing.
//
// Every change is idempotent and logged. A Dinks change is one reward_ledger row `org:<opId>` (the phone makes the opId once per tap, so a replay
// inserts nothing); the club_audit row is written by the same statement that inserts the ledger row, so an audit row exists exactly when a row was
// added. A take never goes below zero and is refused rather than clamped. Undo (see _undo.js) is another ledger row `orgundo:<audit id>`.
import { fail } from './_db.js';
import { audit } from './_members.js';
import { nameKey } from './_names.js';
import { itemById } from './_economyshop.js';
import { dayKey } from './_economy.js';
import { boostWindow, boostView } from './_economyboost.js';
import { spinState, spinId } from './_economyspin.js';

export const MAX_ADJUST = 5000;
export const REASON_MAX = 60;
const OPID = /^[A-Za-z0-9_-]{8,40}$/;

async function player(sql, code, name) {
  const key = nameKey(name);
  if (!key) throw fail(400, 'Pick a player.');
  const [r] = await sql`SELECT name, name_key FROM roster WHERE club = ${code} AND name_key = ${key} AND blocked_at IS NULL`;
  if (!r) throw fail(404, 'That player isn\'t in the club.');
  return r;
}
const balanceOf = async (sql, code, key) => Number((await sql`SELECT coalesce(sum(amount), 0)::int AS n FROM reward_ledger WHERE club = ${code} AND name_key = ${key}`)[0].n);
const has = async (sql, code, key, id) => (await sql`SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${id}`).length > 0;

// One guarded ledger insert plus its audit row in a single statement, under the player's lock. Returns the audit id, or null when nothing was added
// (a replay, or a take the balance can't cover).
// `actor` null (an undo, whose own 'undo' entry is the record) inserts the ledger row alone and returns 0 when added.
async function ledgerAndAudit(sql, code, r, { id, give, n, reason, actor, action, detail }) {
  const lock = sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + r.name_key}))`;
  const [, rows] = await sql.transaction(actor ? [lock, sql`WITH ins AS (
      INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
      SELECT ${code}, ${r.name_key}, ${id}, ${give ? 'earn' : 'spend'}, ${give ? n : -n}, ${reason}, NULL, NULL
      WHERE ${give}::boolean OR coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${r.name_key}), 0) >= ${n}
      ON CONFLICT DO NOTHING RETURNING id)
      INSERT INTO club_audit (club, actor, actor_name, action, target, detail)
      SELECT ${code}, ${actor.by}, ${actor.name || null}, ${action}, ${r.name}, ${JSON.stringify(detail)}::jsonb FROM ins RETURNING id`]
    : [lock, sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
      SELECT ${code}, ${r.name_key}, ${id}, ${give ? 'earn' : 'spend'}, ${give ? n : -n}, ${reason}, NULL, NULL
      WHERE ${give}::boolean OR coalesce((SELECT sum(amount) FROM reward_ledger WHERE club = ${code} AND name_key = ${r.name_key}), 0) >= ${n}
      ON CONFLICT DO NOTHING RETURNING 0 AS id`]);
  return rows.length ? Number(rows[0].id) : null;
}

// body: { name, mode: 'give' | 'take', amount, reason, opId }
export async function adjustBalance(sql, club, actor, body) {
  const code = club.code, give = body.mode === 'give';
  if (!give && body.mode !== 'take') throw fail(400, 'Choose give or take.');
  const raw = typeof body.amount === 'number' ? body.amount : /^\d{1,5}$/.test(String(body.amount).trim()) ? Number(body.amount) : NaN;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_ADJUST) throw fail(400, `Enter a whole number of Dinks from 1 to ${MAX_ADJUST}.`);
  const reason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
  if (!reason) throw fail(400, 'Say why, in a few words. The player sees it.');
  if (!OPID.test(String(body.opId || ''))) throw fail(400, 'This change needs an id.');
  const r = await player(sql, code, body.name), id = 'org:' + body.opId;
  const auditId = await ledgerAndAudit(sql, code, r, { id, give, n: raw, reason: (give ? 'org:' : 'orgtake:') + reason, actor, action: give ? 'reward-give' : 'reward-take', detail: { amount: raw, reason, ledgerId: id } });
  const balance = await balanceOf(sql, code, r.name_key);
  if (auditId) return { ok: true, name: r.name, balance, replayed: false };
  if (await has(sql, code, r.name_key, id)) return { ok: true, name: r.name, balance, replayed: true };
  throw fail(409, `${r.name} has ${balance} Dinks, so ${raw} can't be taken.`);
}

// body: { name, item }
export async function giftItem(sql, club, actor, body) {
  const code = club.code, item = itemById(String(body.item || ''));
  if (!item) throw fail(400, 'That item isn\'t in the shop.');
  const r = await player(sql, code, body.name);
  const [row] = await sql`WITH ins AS (INSERT INTO reward_items (club, name_key, item, slot) VALUES (${code}, ${r.name_key}, ${item.id}, ${item.slot}) ON CONFLICT DO NOTHING RETURNING item)
    INSERT INTO club_audit (club, actor, actor_name, action, target, detail)
    SELECT ${code}, ${actor.by}, ${actor.name || null}, 'reward-gift', ${r.name}, ${JSON.stringify({ item: item.id, itemName: item.name })}::jsonb FROM ins RETURNING id`;
  if (!row) throw fail(409, `${r.name} already has ${item.name}.`);
  return { ok: true, name: r.name, item: item.id, itemName: item.name };
}

// Lets a player who has used today's daily spin spin once more. Refused while they still have a spin waiting, so a double tap grants one.
export async function resetSpin(sql, club, actor, body, now = Date.now()) {
  const code = club.code;
  if (!club.mystery_box) throw fail(403, 'The daily spin is off for this club.');
  const r = await player(sql, code, body.name);
  const st = await spinState(sql, code, r.name_key, now);
  if (st.used < st.allowed) throw fail(409, st.used ? `${r.name} already has a spin waiting.` : `${r.name} hasn't spun today yet.`);
  // The check again, in the insert and under the player's lock, so two taps at once grant one spin.
  const day = dayKey(now, 0), id = spinId(day), start = Date.parse(day + 'T00:00:00Z') / 1000;
  const [, ins] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + r.name_key}))`,
    sql`INSERT INTO club_audit (club, actor, actor_name, action, target, detail)
      SELECT ${code}, ${actor.by}, ${actor.name || null}, 'reward-spin-reset', ${r.name}, ${JSON.stringify({ day })}::jsonb
      WHERE (SELECT count(*) FROM reward_ledger WHERE club = ${code} AND name_key = ${r.name_key} AND (id = ${id} OR id LIKE ${id + ':%'}))
        >= 1 + (SELECT count(*) FROM club_audit WHERE club = ${code} AND action = 'reward-spin-reset' AND lower(target) = lower(${r.name}) AND at >= to_timestamp(${start}))
      RETURNING id`
  ]);
  if (!ins.length) throw fail(409, `${r.name} already has a spin waiting.`);
  return { ok: true, name: r.name };
}

// body: { choice, xp? }. One boost at a time: a running or waiting one must be ended first.
export async function startBoost(sql, club, actor, body, now = Date.now()) {
  const code = club.code, w = boostWindow(String(body.choice), now);
  if (!w) throw fail(400, 'Pick Today, This weekend, 1 day, 3 days or 7 days.');
  if (body.xp !== undefined && typeof body.xp !== 'boolean') throw fail(400, 'Say whether XP is doubled too.');
  const xp = body.xp === true;
  const [row] = await sql`INSERT INTO club_boosts (club, starts_at, ends_at, xp)
    SELECT ${code}, to_timestamp(${w.from / 1000}), to_timestamp(${w.to / 1000}), ${xp}::boolean
    WHERE NOT EXISTS (SELECT 1 FROM club_boosts WHERE club = ${code} AND ends_at > to_timestamp(${now / 1000})) RETURNING id`;
  if (!row) throw fail(409, 'A boost is already running or waiting. End it first.');
  await audit(sql, code, actor, 'boost', null, { boostId: Number(row.id), choice: String(body.choice), from: w.from, until: w.to, xp });
  return boostView(sql, code, now);
}

// Ends whatever is running or waiting, now. Games already received inside it stay boosted.
export async function endBoost(sql, club, actor, now = Date.now()) {
  const code = club.code;
  const ended = await sql`UPDATE club_boosts SET ends_at = to_timestamp(${now / 1000}), starts_at = LEAST(starts_at, to_timestamp(${now / 1000}))
    WHERE club = ${code} AND ends_at > to_timestamp(${now / 1000}) RETURNING id`;
  if (!ended.length) throw fail(409, 'No boost is running.');
  await audit(sql, code, actor, 'boost-end', null, { boostId: Number(ended[0].id) });
  return boostView(sql, code, now);
}

// Reverses a logged organizer change (kind from _undo.js: 'points' | 'gift' | 'boost'); the caller marks the audit row undone and logs the undo.
// The state is checked again, so a later change is never trampled.
export async function undoOrganizerChange(sql, club, actor, e, kind, now = Date.now()) {
  const code = club.code, d = e.detail || {};
  if (kind === 'boost') {
    const ended = await sql`UPDATE club_boosts SET ends_at = to_timestamp(${now / 1000}), starts_at = LEAST(starts_at, to_timestamp(${now / 1000}))
      WHERE club = ${code} AND id = ${d.boostId} AND ends_at > to_timestamp(${now / 1000}) RETURNING id`;
    if (!ended.length) throw fail(409, 'That boost is over already.');
    return;
  }
  const r = await player(sql, code, e.target);
  if (kind === 'gift') {
    const gone = await sql`DELETE FROM reward_items WHERE club = ${code} AND name_key = ${r.name_key} AND item = ${d.item} RETURNING item`;
    if (!gone.length) throw fail(409, `${r.name} no longer has that item.`);
    return;
  }
  const give = e.action === 'reward-give', id = 'orgundo:' + e.id;
  const added = await ledgerAndAudit(sql, code, r, { id, give: !give, n: d.amount, reason: (give ? 'orgtake:' : 'org:') + 'undone: ' + String(d.reason || '').slice(0, 40), actor: null });
  if (added === null && !(await has(sql, code, r.name_key, id))) throw fail(409, give ? `${r.name} has spent some of those Dinks already, so this can't be undone.` : 'This can\'t be undone.');
}
