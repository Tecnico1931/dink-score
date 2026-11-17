// Public result links for finished games and club sessions (the page is served by _resultpublic.js). Called from api/club.js,
// so it adds no serverless function of its own (the hosting plan allows 12; see test/functions.test.js).
// Off for every club until an organizer turns it on. Anyone in the club may make a link for one game or one day's games once
// it is on; only organizers can turn the feature off, list the links, or revoke one.
// POST /api/club {code, action:'results-set', enabled, pin|ownerToken}          -> organizer: turn public links on or off (off also revokes every link)
// POST /api/club {code, action:'results-create', game}                          -> {token, path}  a link for one saved game
// POST /api/club {code, action:'results-create', from, to}                      -> {token, path}  a link for the games that ended between two times (ms), at most 36 hours apart
// POST /api/club {code, action:'results-revoke', token, pin|ownerToken}         -> organizer: that link stops working at once
// GET  /api/club?code=...&results=list (X-Club-PIN / X-Club-Owner)           -> organizer: the active links
import { db, send, fail, cleanCode, requireClub, requireOrganizer, pinFrom, ownerFrom } from './_db.js';
import { audit, organizerActor } from './_audit.js';
import { newShareToken, isShareToken } from './_share.js';

const MAX_LINKS = 200;
const MAX_SESSION_MS = 36 * 3600 * 1000;
const pathOf = token => `/r/${token}`;
const held = (club, confirmedBy) => !!club.require_confirmation && !confirmedBy; // a game kept out of ratings is not published either

export async function manageResults(req, res, body) {
  const sql = db();
  if (!body) {
    const url = new URL(req.url, 'http://x');
    const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
    await requireOrganizer(club, pinFrom(req), req, ownerFrom(req));
    const rows = await sql`SELECT token, kind, game, from_ms, to_ms, created_at FROM result_shares WHERE club = ${club.code} ORDER BY created_at DESC LIMIT ${MAX_LINKS}`;
    return send(res, 200, { enabled: !!club.public_results, links: rows.map(r => ({ token: r.token, path: pathOf(r.token), kind: r.kind, game: r.game, from: r.from_ms == null ? null : Number(r.from_ms), to: r.to_ms == null ? null : Number(r.to_ms), createdAt: new Date(r.created_at).getTime() })) });
  }
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key
  const creds = [body.pin ?? pinFrom(req), body.ownerToken ?? ownerFrom(req)];

  if (body.action === 'results-set') {
    await requireOrganizer(club, creds[0], req, creds[1]);
    if (typeof body.enabled !== 'boolean') throw fail(400, 'Say whether public links are on.');
    await sql`UPDATE clubs SET public_results = ${body.enabled} WHERE code = ${code}`;
    // Turning it off ends every link for good: turning it on again starts with none, never with old ones coming back.
    if (!body.enabled) await sql`DELETE FROM result_shares WHERE club = ${code}`;
    if (!!club.public_results !== body.enabled) await audit(sql, code, '', 'setting', await organizerActor(club, creds[1]), { publicResults: !!club.public_results }, { publicResults: body.enabled });
    return send(res, 200, { ok: true, publicResults: body.enabled });
  }

  if (body.action === 'results-revoke') {
    await requireOrganizer(club, creds[0], req, creds[1]);
    if (!isShareToken(body.token)) throw fail(404, 'That link is not active.');
    const rows = await sql`DELETE FROM result_shares WHERE club = ${code} AND token = ${body.token} RETURNING game`;
    if (!rows.length) throw fail(404, 'That link is not active.');
    await audit(sql, code, rows[0].game || '', 'unshare', await organizerActor(club, creds[1]), null, null, rows[0].game ? 'public link revoked' : 'public session link revoked');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'results-create') {
    if (!club.public_results) throw fail(403, 'Public links are off for this club. An organizer can turn them on in the club settings.');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM result_shares WHERE club = ${code}`;
    let kind, game = null, from = null, to = null;
    if (body.game != null) {
      kind = 'game'; game = String(body.game);
      const [g] = await sql`SELECT confirmed_by FROM games WHERE club = ${code} AND id = ${game} AND deleted_at IS NULL`;
      if (!g) throw fail(404, 'That game no longer exists.');
      if (held(club, g.confirmed_by)) throw fail(409, 'This game needs confirming before it can be shared.');
    } else {
      kind = 'session'; from = Math.trunc(Number(body.from)); to = Math.trunc(Number(body.to));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_SESSION_MS) throw fail(400, 'A session is the games from one day: give a start and an end less than 36 hours apart.');
      const [c] = await sql`SELECT count(*)::int AS n FROM games WHERE club = ${code} AND deleted_at IS NULL AND ended_at >= ${from} AND ended_at < ${to} AND (${!club.require_confirmation} OR confirmed_by IS NOT NULL)`;
      if (!c.n) throw fail(404, 'There are no shareable games in that time.');
    }
    // One link per game or session: asking again returns the same one.
    const find = () => kind === 'game'
      ? sql`SELECT token FROM result_shares WHERE club = ${code} AND game = ${game}`
      : sql`SELECT token FROM result_shares WHERE club = ${code} AND game IS NULL AND from_ms = ${from} AND to_ms = ${to}`;
    let [row] = await find();
    if (!row) {
      if (n >= MAX_LINKS) throw fail(400, `This club has ${MAX_LINKS} public links. An organizer can revoke old ones.`);
      const token = newShareToken();
      await sql`INSERT INTO result_shares (token, club, kind, game, from_ms, to_ms) VALUES (${token}, ${code}, ${kind}, ${game}, ${from}, ${to}) ON CONFLICT DO NOTHING`;
      [row] = await find();
      await audit(sql, code, game || '', 'share', await organizerActor(club, creds[1]), null, null, kind === 'game' ? 'public link made' : 'public session link made');
    }
    return send(res, 200, { ok: true, token: row.token, path: pathOf(row.token) });
  }
  throw fail(400, 'Unknown action.');
}
