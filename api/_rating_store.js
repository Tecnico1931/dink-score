// Dink Rating v2, kept on the server. Not a route (files starting with "_"). Each club's rating history is rebuilt from its full
// game list (not the 2000 newest the club answer carries) whenever the games, the club's confirmation setting or the engine
// version change, and stored in rating_history (one row per player and game, the newest HISTORY_KEEP kept). The first rebuild
// under a new engine version also writes one rating_changelog row: each player's rating under the old and the new rules.
// The changelog holds name keys and numbers only; rename and anonymise call dropRatings so no old name stays.
import { createHash } from 'node:crypto';
import { VERSION, PROVISIONAL, compute, key } from './_rating.js';
import { counts } from './_confirm.js';

export const HISTORY_KEEP = 200;

// Changes whenever anything a rating depends on does; cheap enough to run on every club answer that is not a 304.
async function digestOf(sql, code, required) {
  const [r] = await sql`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(id || '|' || data::text || '|' || coalesce(confirmed_by, '')), ',' ORDER BY ended_at, id)), '') AS h FROM games WHERE club = ${code} AND deleted_at IS NULL`;
  return createHash('sha256').update(`${VERSION}|${required}|${r.n}|${r.h}`).digest('hex').slice(0, 32);
}

// One row per player per game, in game order, with the player's running game count (n); only the newest HISTORY_KEEP of each kept.
function rowsOf(sorted, changes) {
  const seen = new Map(), out = [];
  for (const g of sorted) {
    const ch = changes[g.id];
    if (!ch) continue;
    const mode = g.mode === 'singles' ? 'singles' : 'doubles';
    for (const c of ch.list) {
      const k = key(c.name), id = mode + '|' + k, n = (seen.get(id) || 0) + 1;
      seen.set(id, n);
      out.push({ mode, k, n, id: g.id, at: g.endedAt, rating: c.after, name: c.name });
    }
  }
  return out.filter(r => r.n > seen.get(r.mode + '|' + r.k) - HISTORY_KEEP);
}

// Rebuilds a club's stored ratings when they are out of date. Returns true when it rebuilt.
export async function refreshRatings(sql, club) {
  const code = club.code, required = !!club.require_confirmation;
  const digest = await digestOf(sql, code, required);
  const [state] = await sql`SELECT version, digest FROM rating_state WHERE club = ${code}`;
  if (state && state.version === VERSION && state.digest === digest) return false;
  const rows = await sql`SELECT data, confirmed_by FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at, id`;
  const games = rows.map(r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: true } : {}) })).filter(g => counts(g, required));
  const sorted = [...games].sort((a, b) => a.endedAt - b.endedAt);
  const now = compute(games);
  const hist = rowsOf(sorted, now.changes);
  const ops = [
    sql`DELETE FROM rating_history WHERE club = ${code}`,
    sql`INSERT INTO rating_history (club, mode, pkey, n, game_id, at, rating, name)
        SELECT ${code}, mode, pkey, n, game_id, at, rating, name FROM unnest(${hist.map(r => r.mode)}::text[], ${hist.map(r => r.k)}::text[], ${hist.map(r => r.n)}::int[], ${hist.map(r => r.id)}::text[], ${hist.map(r => r.at)}::bigint[], ${hist.map(r => r.rating)}::float8[], ${hist.map(r => r.name)}::text[]) AS t(mode, pkey, n, game_id, at, rating, name)`,
    sql`INSERT INTO rating_state (club, version, digest, built_at) VALUES (${code}, ${VERSION}, ${digest}, now())
        ON CONFLICT (club) DO UPDATE SET version = EXCLUDED.version, digest = EXCLUDED.digest, built_at = now()`
  ];
  // Moving to a new engine version for a club that already has rated games: say once how everyone moved.
  if ((!state || state.version < VERSION) && games.length) {
    const old = compute(games, { cap: 1 });
    const moves = { doubles: {}, singles: {} };
    let any = false;
    for (const mode of ['doubles', 'singles']) for (const [k, p] of now.tables[mode]) {
      const was = old.tables[mode].get(k);
      if (was && Math.abs(was.rating - p.rating) >= 0.005) { moves[mode][k] = [Math.round(was.rating * 100) / 100, Math.round(p.rating * 100) / 100]; any = true; }
    }
    if (any) ops.push(sql`INSERT INTO rating_changelog (club, version, at, moves) VALUES (${code}, ${VERSION}, now(), ${JSON.stringify(moves)}::jsonb) ON CONFLICT DO NOTHING`);
  }
  await sql.transaction(ops);
  return true;
}

// What the club answer carries: each player's stored rating and games, the provisional line, and the changelog.
export async function ratingsFor(sql, club) {
  const code = club.code;
  const [latest, [log]] = await Promise.all([
    sql`SELECT DISTINCT ON (mode, pkey) mode, pkey, name, n, rating FROM rating_history WHERE club = ${code} ORDER BY mode, pkey, n DESC`,
    sql`SELECT version, at, moves FROM rating_changelog WHERE club = ${code} ORDER BY version DESC LIMIT 1`.then(r => r.length ? r : [null])
  ]);
  const players = { doubles: {}, singles: {} };
  for (const r of latest) players[r.mode][r.pkey] = { name: r.name, rating: Math.round(r.rating * 100) / 100, games: r.n, provisional: r.n < PROVISIONAL };
  return { version: VERSION, provisionalBelow: PROVISIONAL, players, changelog: log ? { version: log.version, at: new Date(log.at).getTime(), moves: log.moves } : null };
}

// One player's stored points, oldest first: [[ended at, rating after]]. For a profile's rating line.
export async function historyOf(sql, club, mode, pkey) {
  const rows = await sql`SELECT at, rating FROM rating_history WHERE club = ${club.code} AND mode = ${mode === 'singles' ? 'singles' : 'doubles'} AND pkey = ${pkey} ORDER BY n`;
  return rows.map(r => [Number(r.at), Math.round(r.rating * 100) / 100]);
}

// Rename, merge and anonymise change what a name is: the stored copy is dropped and rebuilt from the games on the next read.
// The changelog row stays (so it is not written again) but loses its names.
export const dropRatings = (sql, code) => [sql`DELETE FROM rating_history WHERE club = ${code}`, sql`DELETE FROM rating_state WHERE club = ${code}`, sql`UPDATE rating_changelog SET moves = '{"doubles":{},"singles":{}}'::jsonb WHERE club = ${code}`];
