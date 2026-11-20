// Reactions on finished club games (L12): allow-listed set, caps, grouping and pure validation helpers.
// Pure helpers stay DB-free so `npm test` covers them with no install; DB helpers take `sql` as an argument.
import { nameKey } from './_names.js';

export const REACTIONS = [
  { key: 'clap', emoji: '\u{1F44F}', label: 'Great game' },
  { key: 'fire', emoji: '\u{1F525}', label: 'On fire' },
  { key: 'pickle', emoji: '\u{1F952}', label: 'Nice dink' },
  { key: 'sweat', emoji: '\u{1F605}', label: 'Close one' },
  { key: 'trophy', emoji: '\u{1F3C6}', label: 'Clutch' }
];
export const REACTION_KEYS = REACTIONS.map(r => r.key);
export const MAX_REACTIONS_PER_MEMBER_PER_GAME = 3;
export const MAX_REACTIONS_PER_GAME = 60;
export const MAX_REACTS_PER_MEMBER_MIN = 60;
export const MAX_REACTS_PER_NET_MIN = 180;

const ALLOWED = new Set(REACTION_KEYS);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function cleanReaction(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!ALLOWED.has(key)) throw fail(400, 'Pick one of the available reactions.');
  return key;
}

// Turns raw rows [{ game_id?, reaction, name }] into { [reaction]: [name, ...] } in canonical reaction order,
// omitting any reaction with no rows. Unknown reaction keys are ignored.
export function summarizeReactions(rows) {
  const buckets = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !ALLOWED.has(r.reaction) || typeof r.name !== 'string' || !r.name) continue;
    let list = buckets.get(r.reaction);
    if (!list) { list = []; buckets.set(r.reaction, list); }
    list.push(r.name);
  }
  const out = {};
  for (const k of REACTION_KEYS) {
    const list = buckets.get(k);
    if (list && list.length) out[k] = list;
  }
  return out;
}

// Groups club-wide reaction rows by game_id -> { [reaction]: [name, ...] }.
export function groupReactions(rows) {
  const byGame = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.game_id !== 'string' || !ALLOWED.has(r.reaction) || typeof r.name !== 'string' || !r.name) continue;
    let list = byGame.get(r.game_id);
    if (!list) { list = []; byGame.set(r.game_id, list); }
    list.push(r);
  }
  const out = new Map();
  for (const [id, list] of byGame) {
    const summary = summarizeReactions(list);
    if (Object.keys(summary).length) out.set(id, summary);
  }
  return out;
}

// Per-member and per-network rate limit using lookup_fails (same record-first pattern as _db.js and _resultpublic.js).
export async function throttleReaction(sql, code, memberKey, ip) {
  for (const [key, max] of [
    ['reactm:' + code + ':' + memberKey, MAX_REACTS_PER_MEMBER_MIN],
    ['react:' + code + ':' + ip, MAX_REACTS_PER_NET_MIN]
  ]) {
    const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 minute'`;
    if (Number(n) > max) {
      await sql`DELETE FROM lookup_fails WHERE id = ${id}`;
      throw fail(429, 'Too many reactions just now. Wait a minute and try again.');
    }
  }
}

// Reads the summarized reactions for one non-deleted game (404 if the game does not exist or is deleted).
export async function getGameReactions(sql, code, gameId) {
  const id = String(gameId || '');
  const [game] = await sql`SELECT id FROM games WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
  if (!game) throw fail(404, 'That game no longer exists.');
  const rows = await sql`SELECT reaction, name FROM game_reactions WHERE club = ${code} AND game_id = ${id} ORDER BY created_at ASC, name_key ASC`;
  return { gameId: id, reactions: summarizeReactions(rows) };
}

// Toggles one reaction on a saved game for a verified club member. Removing is always allowed, even at a cap.
export async function toggleReaction(sql, { code, gameId, rawReaction, playerName, playerToken, tokenMatches, ip }) {
  const reaction = cleanReaction(rawReaction);
  const id = String(gameId || '');
  if (!id) throw fail(400, 'Choose a game to react to.');
  const k = nameKey(playerName);
  if (!k || !playerToken) throw fail(403, 'Pick your name in the club first to react to games.');
  const [member] = await sql`SELECT name, name_key, claim_hash, blocked_at FROM roster WHERE club = ${code} AND name_key = ${k}`;
  if (member && member.blocked_at) throw fail(403, 'You were removed from this club by an organizer.');
  if (!member || !member.claim_hash || !tokenMatches(member.claim_hash, playerToken)) {
    throw fail(403, 'This phone isn\'t linked to that player. Pick your name in the club first.');
  }
  await throttleReaction(sql, code, member.name_key, ip);
  const [game] = await sql`SELECT id FROM games WHERE club = ${code} AND id = ${id} AND deleted_at IS NULL`;
  if (!game) throw fail(404, 'That game no longer exists.');

  const removed = await sql`DELETE FROM game_reactions WHERE club = ${code} AND game_id = ${id} AND name_key = ${member.name_key} AND reaction = ${reaction} RETURNING reaction`;
  let added = false;
  if (!removed.length) {
    const inserted = await sql`INSERT INTO game_reactions (club, game_id, name_key, name, reaction)
      SELECT ${code}, ${id}, ${member.name_key}, ${member.name}, ${reaction}
      WHERE (SELECT count(*) FROM game_reactions WHERE club = ${code} AND game_id = ${id} AND name_key = ${member.name_key}) < ${MAX_REACTIONS_PER_MEMBER_PER_GAME}
        AND (SELECT count(*) FROM game_reactions WHERE club = ${code} AND game_id = ${id}) < ${MAX_REACTIONS_PER_GAME}
      ON CONFLICT DO NOTHING
      RETURNING reaction`;
    if (inserted.length) {
      added = true;
    } else {
      const [counts] = await sql`SELECT
        count(*) FILTER (WHERE name_key = ${member.name_key})::int AS mine,
        count(*)::int AS total,
        count(*) FILTER (WHERE name_key = ${member.name_key} AND reaction = ${reaction})::int AS already
        FROM game_reactions WHERE club = ${code} AND game_id = ${id}`;
      if (Number(counts.already) > 0) {
        added = true;
      } else if (Number(counts.mine) >= MAX_REACTIONS_PER_MEMBER_PER_GAME) {
        throw fail(409, `You can add at most ${MAX_REACTIONS_PER_MEMBER_PER_GAME} reactions to a game.`);
      } else {
        throw fail(409, 'This game already has the maximum number of reactions.');
      }
    }
  }
  const rows = await sql`SELECT reaction, name FROM game_reactions WHERE club = ${code} AND game_id = ${id} ORDER BY created_at ASC, name_key ASC`;
  return { ok: true, gameId: id, reaction, added, reactions: summarizeReactions(rows) };
}
