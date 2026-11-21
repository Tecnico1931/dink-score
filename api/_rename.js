// Renaming a player and merging two players. A name is stored in several places (the saved player, every game, every event,
// event DUPR references, shop purchases, account links), so these rewrite them all in one transaction.
// The pure part (rewriting one JSON document) is here so it can be tested without a database.
import { nameKey, cleanName } from './_names.js';
import { dropRatings } from './_rating_store.js';
import { repair } from './_court.js';
import { MAX_REACTIONS_PER_MEMBER_PER_GAME } from './_reactions.js';

// Names sit in arrays of strings (teams, players, byes, champion, team info), never under a key of their own, so only strings
// inside arrays are touched: an event or team that happens to be called like a player keeps its title.
// Returns {value, changed, seen}: `seen` is the set of keys from `watch` that appear anywhere.
export function rewriteNames(value, map, watch = []) {
  const seen = new Set();
  let changed = false;
  const walk = v => {
    if (Array.isArray(v)) return v.map(x => {
      if (typeof x === 'string') {
        const k = nameKey(x);
        if (watch.includes(k)) seen.add(k);
        if (map.has(k) && x !== map.get(k)) { changed = true; return map.get(k); }
        return x;
      }
      return walk(x);
    });
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return { value: out, changed, seen };
}

// Event DUPR references are { "player name": id }.
export function rewriteRefs(refs, map) {
  if (!refs || typeof refs !== 'object') return { value: refs, changed: false };
  let changed = false;
  const out = {};
  for (const [name, id] of Object.entries(refs)) {
    const to = map.get(nameKey(name));
    if (to && to !== name) { changed = true; if (!(to in out)) out[to] = id; } else if (!(name in out)) out[name] = id;
  }
  return { value: out, changed };
}

// One game: names in teams, and `scoredBy` (the sender's name key) when it was the renamed player's own phone.
export function rewriteGame(g, map) {
  const r = rewriteNames(g.teams, map);
  const to = typeof g.scoredBy === 'string' && map.get(g.scoredBy);
  if (!r.changed && !to) return null;
  return Object.assign({}, g, { teams: r.value }, to ? { scoredBy: nameKey(to) } : {});
}

const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });

// from: stored name to change; to: the new display name. When `into` is given the two are merged and `to` is that
// player's own display name.
export async function renamePlayer(sql, code, fromRow, toName, intoRow) {
  const fromKey = fromRow.name_key, toKey = nameKey(toName);
  const map = new Map([[fromKey, toName]]);
  const watch = intoRow ? [fromKey, toKey] : [];
  const gameRows = await sql`SELECT id, data FROM games WHERE club = ${code}`;
  const eventRows = await sql`SELECT id, data, refs FROM events WHERE club = ${code}`;
  const leagueRows = await sql`SELECT id, data FROM leagues WHERE club = ${code}`;
  const games = [], events = [], leagues = [];
  for (const r of gameRows) {
    if (intoRow) {
      const s = rewriteNames(r.data.teams, new Map(), watch).seen;
      if (s.size === 2) throw fail(409, `${fromRow.name} and ${intoRow.name} played in the same game, so they are different people and can't be merged.`);
    }
    const next = rewriteGame(r.data, map);
    if (next) games.push({ id: r.id, data: next });
  }
  for (const r of eventRows) {
    if (intoRow && rewriteNames(r.data, new Map(), watch).seen.size === 2) throw fail(409, `${fromRow.name} and ${intoRow.name} are in the same event, so they are different people and can't be merged.`);
    const next = rewriteNames(r.data, map);
    const refs = rewriteRefs(r.refs, map);
    if (next.changed || refs.changed) events.push({ id: r.id, data: next.value, refs: refs.changed ? refs.value : r.refs });
  }
  // Leagues and ladders keep names in their entries, matches and results, like events.
  for (const r of leagueRows) {
    if (intoRow && rewriteNames(r.data, new Map(), watch).seen.size === 2) throw fail(409, `${fromRow.name} and ${intoRow.name} are in the same league or ladder, so they are different people and can't be merged.`);
    const next = rewriteNames(r.data, map);
    if (next.changed) leagues.push({ id: r.id, data: next.value });
  }
  // The open play court board keeps names too (who is here, the queue, the courts, the recent matches).
  let board = null;
  const [boardRow] = await sql`SELECT data FROM court_boards WHERE club = ${code}`;
  if (boardRow) {
    if (intoRow && rewriteNames(boardRow.data.courts, new Map(), watch).seen.size === 2) throw fail(409, `${fromRow.name} and ${intoRow.name} are both on a court right now, so they can't be merged yet.`);
    const next = rewriteNames(boardRow.data, map);
    if (next.changed) board = repair(next.value);
  }
  return { games, events, leagues, board, map, fromKey, toKey, toName };
}

// The writes for a computed rename/merge, as one list for sql.transaction.
export function renameWrites(sql, code, plan, extra = []) {
  const { games, events, leagues, board, fromKey, toKey, toName } = plan;
  const writes = [];
  if (games.length) writes.push(sql`UPDATE games g SET data = v.data FROM jsonb_to_recordset(${JSON.stringify(games)}::jsonb) AS v(id text, data jsonb) WHERE g.club = ${code} AND g.id = v.id`);
  if (events.length) writes.push(sql`UPDATE events e SET data = v.data, refs = v.refs FROM jsonb_to_recordset(${JSON.stringify(events)}::jsonb) AS v(id text, data jsonb, refs jsonb) WHERE e.club = ${code} AND e.id = v.id`);
  if (leagues.length) writes.push(sql`UPDATE leagues l SET data = v.data, version = l.version + 1 FROM jsonb_to_recordset(${JSON.stringify(leagues)}::jsonb) AS v(id text, data jsonb) WHERE l.club = ${code} AND l.id = v.id`);
  if (board) writes.push(sql`UPDATE court_boards SET data = ${JSON.stringify(board)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code}`);
  if (fromKey !== toKey) {
    // Drop duplicate reactions before merging two names into one, then keep at most the per-member cap per game.
    writes.push(sql`DELETE FROM game_reactions f WHERE f.club = ${code} AND f.name_key = ${fromKey} AND EXISTS (SELECT 1 FROM game_reactions t WHERE t.club = f.club AND t.game_id = f.game_id AND t.name_key = ${toKey} AND t.reaction = f.reaction)`);
    writes.push(sql`DELETE FROM game_night_rsvps WHERE club = ${code} AND name_key = ${fromKey} AND night_id IN (SELECT night_id FROM game_night_rsvps WHERE club = ${code} AND name_key = ${toKey})`);
  }
  writes.push(sql`UPDATE game_reactions SET name_key = ${toKey}, name = ${toName} WHERE club = ${code} AND name_key = ${fromKey}`);
  if (fromKey !== toKey) {
    writes.push(sql`DELETE FROM game_reactions WHERE club = ${code} AND name_key = ${toKey} AND (game_id, reaction) IN (SELECT game_id, reaction FROM (SELECT game_id, reaction, row_number() OVER (PARTITION BY game_id ORDER BY created_at ASC, reaction ASC) AS rn FROM game_reactions WHERE club = ${code} AND name_key = ${toKey}) s WHERE rn > ${MAX_REACTIONS_PER_MEMBER_PER_GAME})`);
  }
  writes.push(sql`UPDATE game_night_rsvps SET name_key = ${toKey}, name = ${toName} WHERE club = ${code} AND name_key = ${fromKey}`);
  writes.push(sql`UPDATE game_nights SET updated_at = now() WHERE club = ${code} AND id IN (SELECT night_id FROM game_night_rsvps WHERE club = ${code} AND name_key = ${toKey})`);
  writes.push(sql`UPDATE organizer_devices SET name_key = ${toKey} WHERE club = ${code} AND name_key = ${fromKey}`); // the player an unlocked organizer phone is linked to
  writes.push(sql`UPDATE push_subs SET name_key = ${toKey} WHERE club = ${code} AND name_key = ${fromKey}`);
  writes.push(sql`UPDATE purchases SET name_key = ${toKey} WHERE club = ${code} AND name_key = ${fromKey}`);
  writes.push(sql`DELETE FROM approval_requests WHERE club = ${code} AND name_key IN (${fromKey}, ${toKey})`); // short-lived: the asker just asks again for the new name
  writes.push(...dropRatings(sql, code)); // stored ratings carry names: rebuilt from the renamed games on the next read
  return writes.concat(extra);
}
export { cleanName };
