// Renaming a player and merging two players. A name is stored in several places (the saved player, every game, every event,
// event DUPR references, shop purchases, account links), so these rewrite them all in one transaction.
// The pure part (rewriting one JSON document) is here so it can be tested without a database.
import { nameKey, cleanName } from './_names.js';
import { dropRatings } from './_rating_store.js';
import { repair } from './_court.js';

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
  const games = [], events = [];
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
  // The open play court board keeps names too (who is here, the queue, the courts, the recent matches).
  let board = null;
  const [boardRow] = await sql`SELECT data FROM court_boards WHERE club = ${code}`;
  if (boardRow) {
    if (intoRow && rewriteNames(boardRow.data.courts, new Map(), watch).seen.size === 2) throw fail(409, `${fromRow.name} and ${intoRow.name} are both on a court right now, so they can't be merged yet.`);
    const next = rewriteNames(boardRow.data, map);
    if (next.changed) board = repair(next.value);
  }
  return { games, events, board, map, fromKey, toKey };
}

// The writes for a computed rename/merge, as one list for sql.transaction.
export function renameWrites(sql, code, plan, extra = []) {
  const { games, events, board, fromKey, toKey } = plan;
  const writes = [];
  if (games.length) writes.push(sql`UPDATE games g SET data = v.data FROM jsonb_to_recordset(${JSON.stringify(games)}::jsonb) AS v(id text, data jsonb) WHERE g.club = ${code} AND g.id = v.id`);
  if (events.length) writes.push(sql`UPDATE events e SET data = v.data, refs = v.refs FROM jsonb_to_recordset(${JSON.stringify(events)}::jsonb) AS v(id text, data jsonb, refs jsonb) WHERE e.club = ${code} AND e.id = v.id`);
  if (board) writes.push(sql`UPDATE court_boards SET data = ${JSON.stringify(board)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code}`);
  writes.push(sql`UPDATE push_subs SET name_key = ${toKey} WHERE club = ${code} AND name_key = ${fromKey}`);
  writes.push(sql`UPDATE purchases SET name_key = ${toKey} WHERE club = ${code} AND name_key = ${fromKey}`);
  writes.push(...dropRatings(sql, code)); // stored ratings carry names: rebuilt from the renamed games on the next read
  return writes.concat(extra);
}
export { cleanName };
