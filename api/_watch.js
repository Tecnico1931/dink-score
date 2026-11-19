// Apple Watch: linking a watch to a club and scoring with it. Reached through /api/live (see live.js; the function count is at its limit).
// Nothing here runs until a watch registers, so a club that never links one is unaffected. The pure rules are in _watchrules.js.
//
// Linking (no club code on the watch; the phone supplies it):
//   watch  POST {action:'watch-register', idHash, pollHash, confirm4, label?, shortHash?}   -> shows QR https://<site>/#watch=<pairId> + the 4 digits
//   phone  POST {action:'watch-claim', code, pair, confirm4, game?, secret?}                 -> pair: the 32 hex of the QR, or the 6 typed characters
//   watch  POST {action:'watch-poll', pairId, pollSecret}   (every ~2 s)                     -> {status:'waiting'} or, once, {status:'linked', token}
//   idHash = pairHash(pairId), pollHash = pollHash(pollSecret), shortHash = shortHash(shortCode(pairId)), all in _watchrules.js.
// The watch then sends `Authorization: Bearer w_...` (checked by hash; see requireWatch):
//   GET /api/live?watch=state, or POST watch-state   -> {club:{name}, link, game: null | {...}}   (GET answers carry an ETag, see _sync.js)
//   POST watch-rally {opId, side, base?, game?}, watch-unrally {opId, base?, game?}               -> the same answer as rally/unrally, plus duplicate:true for a repeated opId
//   POST watch-unlink                                                                              -> this watch stops working
// Phone side (club code): watch-list, watch-attach {link, game, secret}, watch-revoke {link, revokeKey | organizer}.
// A watch can only read and score the live games a phone attached to its link; it never sees the roster, history or any other game.
import { fail, clientIp, purgeMarks, requireOrganizer } from './_db.js';
import { FRESH_MS, requireSecret, applyRally } from './_livecore.js';
import * as R from './_watchrules.js';

export const WATCH_ACTIONS = ['watch-register', 'watch-poll', 'watch-state', 'watch-rally', 'watch-unrally', 'watch-unlink']; // no club code: pairing is open, the rest carry the watch token
export const WATCH_CLUB_ACTIONS = ['watch-claim', 'watch-list', 'watch-attach', 'watch-revoke']; // the phone, with the club code

const MAX_NEW_NET = 10, MAX_NEW_ALL = 300;  // registrations per network per hour, and across the whole app
const MAX_BAD_CLAIMS = 10;                  // wrong link codes per network per 15 minutes
const MAX_BAD_POLLS = 30;                   // wrong poll secrets per network per 15 minutes
const MAX_BAD_TOKENS = 30;                  // unknown or revoked watch tokens per network per 15 minutes

// Records an attempt, then counts; an attempt over the limit takes its own mark back off. Same idea as transfer.js.
async function attempt(sql, key, limit, minutes, message) {
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - make_interval(mins => ${minutes})`;
  if (n > limit) { await sql`DELETE FROM lookup_fails WHERE id = ${id}`; throw fail(429, message); }
  return id;
}
const ms = t => (t ? new Date(t).getTime() : null);

// The caller is a linked watch: a live token, not revoked, not expired, on a club that still exists. Returns the club's columns
// (as requireClub does, `code` is the permanent key: query with it) plus `link`. Wrong tokens are counted per network address.
export async function requireWatch(sql, req) {
  const key = 'watch:' + clientIp(req), token = R.tokenFrom(req);
  const [[{ n }], rows] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '15 minutes'`,
    token ? sql`SELECT l.id AS link_id, l.label, l.created_at, l.last_seen_at, c.code, c.name, c.pin_hash, c.owner_hash, c.public_code, c.require_confirmation, c.public_results, c.pay_link, c.pinned_note, c.delete_at
      FROM watch_links l JOIN clubs c ON c.code = l.club
      WHERE l.token_hash = ${R.hashWatchToken(token)} AND l.revoked_at IS NULL AND l.expires_at > now()` : Promise.resolve([])
  ]);
  if (n >= MAX_BAD_TOKENS) throw fail(429, 'Too many wrong watch links. Wait 15 minutes and try again.');
  let found = rows[0];
  if (found && found.delete_at && ms(found.delete_at) <= Date.now()) { await sql`DELETE FROM clubs WHERE code = ${found.code} AND delete_at <= now()`; found = null; }
  if (!found) { await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`; throw fail(401, 'This watch is not linked any more. Link it again from the phone.'); }
  const now = Date.now();
  if (R.touchDue(ms(found.last_seen_at), now)) {
    await sql`UPDATE watch_links SET last_seen_at = now(), expires_at = ${new Date(R.nextExpiry(ms(found.created_at), now)).toISOString()} WHERE id = ${found.link_id}`;
  }
  const { link_id, label, created_at, last_seen_at, ...club } = found;
  return { ...club, link: { id: link_id, label } };
}

// The live game a watch may see and score: attached to its link and fresh. `game` narrows it to one id; otherwise the latest.
async function attachedGame(sql, code, linkId, game) {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const [row] = game
    ? await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND id = ${String(game)} AND ${linkId} = ANY(watch_links) AND updated_at > ${since}`
    : await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND ${linkId} = ANY(watch_links) AND updated_at > ${since} ORDER BY updated_at DESC LIMIT 1`;
  return row || null;
}
async function revokeLink(sql, code, linkId) {
  await sql`UPDATE watch_links SET revoked_at = now() WHERE id = ${linkId} AND club = ${code} AND revoked_at IS NULL`;
  await sql`UPDATE live_games SET watch_links = array_remove(watch_links, ${linkId}) WHERE club = ${code} AND ${linkId} = ANY(watch_links)`;
}

// ---- the watch, before it has a token ----
async function register(sql, body, req) {
  const idHash = R.cleanHash(body.idHash), pollHash = R.cleanHash(body.pollHash), confirm = R.cleanConfirm(body.confirm4);
  const shortHash = body.shortHash === undefined || body.shortHash === null ? null : R.cleanHash(body.shortHash);
  if (!idHash || !pollHash || !confirm || (body.shortHash != null && !shortHash)) throw fail(400, 'That watch link was not valid.');
  await attempt(sql, 'watch-new:' + clientIp(req), MAX_NEW_NET, 60, 'Too many watch links from this connection. Try again in an hour.');
  await attempt(sql, 'watch-new:*', MAX_NEW_ALL, 60, 'Too many watches are linking just now. Try again in an hour.');
  await purgeMarks(sql);
  await sql`DELETE FROM watch_pairings WHERE expires_at < now()`;
  await sql`DELETE FROM watch_links WHERE (token_hash IS NULL AND expires_at < now()) OR expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`;
  const rows = await sql`INSERT INTO watch_pairings (id_hash, poll_hash, short_hash, confirm, label, expires_at) VALUES (${idHash}, ${pollHash}, ${shortHash}, ${confirm}, ${R.cleanLabel(body.label)}, now() + make_interval(mins => ${R.PAIR_TTL_MIN})) ON CONFLICT DO NOTHING RETURNING id_hash`;
  if (!rows.length) throw fail(409, 'That watch link is already in use. Make a new one.');
  return { ok: true, expiresInMinutes: R.PAIR_TTL_MIN };
}

async function poll(sql, body, req) {
  const pairId = R.cleanPairId(body.pairId), secret = R.cleanPollSecret(body.pollSecret);
  if (!pairId || !secret) throw fail(400, 'That watch link was not valid.');
  const idHash = R.pairHash(pairId);
  const [row] = await sql`UPDATE watch_pairings SET polls = polls + 1 WHERE id_hash = ${idHash} AND expires_at > now() RETURNING poll_hash, polls, claimed_link`;
  if (!row) throw fail(404, 'That watch link has expired. Show a new one on the watch.');
  if (!R.hashEq(row.poll_hash, R.pollHash(secret))) { await attempt(sql, 'watch-poll:' + clientIp(req), MAX_BAD_POLLS, 15, 'Too many wrong tries. Wait 15 minutes.'); throw fail(403, 'That watch link is not yours.'); }
  if (Number(row.polls) > R.MAX_POLLS) throw fail(429, 'This watch is asking too often. Show a new link code on the watch.');
  if (!row.claimed_link) return { ok: true, status: 'waiting' };
  // One statement both checks and deletes, so the token can only ever be collected once (the same pattern as transfer.js).
  const gone = await sql`DELETE FROM watch_pairings WHERE id_hash = ${idHash} AND claimed_link IS NOT NULL RETURNING claimed_link`;
  if (!gone.length) throw fail(404, 'That watch link was already used. Show a new one on the watch.');
  const token = R.newWatchToken();
  const [link] = await sql`UPDATE watch_links SET token_hash = ${R.hashWatchToken(token)}, expires_at = now() + make_interval(days => ${R.LINK_TTL_DAYS})
    WHERE id = ${gone[0].claimed_link} AND token_hash IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id, label, club`;
  if (!link) throw fail(404, 'That watch link is no longer valid. Show a new one on the watch.');
  const [c] = await sql`SELECT name FROM clubs WHERE code = ${link.club}`;
  return { ok: true, status: 'linked', token, link: { id: link.id, label: link.label }, club: { name: c ? c.name : '' } };
}

// ---- the watch, with its token ----
export async function watchState(sql, req) {
  const w = await requireWatch(sql, req);
  const game = await attachedGame(sql, w.code, w.link.id, null);
  return { scope: w.code + ':watch:' + w.link.id, body: { club: { name: w.name }, link: w.link, game: game ? R.watchGame(game) : null } };
}

async function tap(sql, body, req, kind) {
  const w = await requireWatch(sql, req);
  const opId = R.cleanOpId(body.opId);
  if (!opId) throw fail(400, 'Every tap needs its own id (opId) so a retry is not counted twice.');
  if (kind === 'rally' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
  const row = await attachedGame(sql, w.code, w.link.id, body.game);
  if (!row) throw fail(404, 'No game is sent to this watch. Send the game to the watch from the scoring phone.');
  return (await applyRally(sql, { code: w.code, row, kind, side: body.side, base: body.base, opId })).body;
}

export async function watchAction(sql, body, req) {
  switch (body.action) {
    case 'watch-register': return register(sql, body, req);
    case 'watch-poll': return poll(sql, body, req);
    case 'watch-state': return (await watchState(sql, req)).body;
    case 'watch-rally': return tap(sql, body, req, 'rally');
    case 'watch-unrally': return tap(sql, body, req, 'unrally');
    case 'watch-unlink': { const w = await requireWatch(sql, req); await revokeLink(sql, w.code, w.link.id); return { ok: true }; }
  }
  throw fail(400, 'Unknown action.');
}

// ---- the phone ----
async function claim(sql, club, body, req) {
  const confirm = R.cleanConfirm(body.confirm4), raw = String(body.pair ?? '').trim();
  const pairId = R.cleanPairId(raw), short = pairId ? null : R.cleanShort(raw);
  if (!confirm || (!pairId && !short)) throw fail(400, 'Scan the code on the watch, or type its 6 characters and the 4 numbers.');
  const code = club.code;
  // Everything that can refuse comes before the pairing's try counter moves: a wrong game secret must not cost a try.
  let game = null;
  if (body.game !== undefined && body.game !== null && body.game !== '') {
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    [game] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game)} AND updated_at > ${since}`;
    if (!game) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
    await requireSecret(sql, req, game, body.secret);
  }
  const [{ n: active }] = await sql`SELECT count(*)::int AS n FROM watch_links WHERE club = ${code} AND revoked_at IS NULL AND expires_at > now()`;
  if (active >= R.MAX_LINKS_PER_CLUB) throw fail(409, 'This club already has ' + R.MAX_LINKS_PER_CLUB + ' linked watches. Unlink one first.');
  const mark = await attempt(sql, 'watch-claim:' + clientIp(req), MAX_BAD_CLAIMS, 15, 'Too many wrong watch codes. Wait 15 minutes and try again.');
  const rows = pairId
    ? await sql`UPDATE watch_pairings SET tries = tries + 1 WHERE id_hash = ${R.pairHash(pairId)} AND expires_at > now() AND claimed_link IS NULL RETURNING id_hash, confirm, tries, label`
    : await sql`UPDATE watch_pairings SET tries = tries + 1 WHERE short_hash = ${R.shortHash(short)} AND expires_at > now() AND claimed_link IS NULL RETURNING id_hash, confirm, tries, label`;
  if (rows.length !== 1) throw fail(404, 'That watch code is wrong, already used, or has expired. Show a new one on the watch.');
  const p = rows[0], verdict = R.confirmVerdict(Number(p.tries), p.confirm, confirm);
  if (verdict !== 'ok') {
    if (verdict === 'locked') { await sql`DELETE FROM watch_pairings WHERE id_hash = ${p.id_hash}`; throw fail(403, 'Too many wrong numbers. Show a new code on the watch.'); }
    throw fail(403, 'Those 4 numbers do not match the watch. Check the watch screen.');
  }
  await sql`DELETE FROM lookup_fails WHERE id = ${mark}`;
  const id = R.newLinkId(), revokeKey = R.newRevokeKey();
  // The link exists now but has no token until the watch collects it (watch-poll); a link nobody collects expires.
  await sql`INSERT INTO watch_links (id, club, revoke_hash, label, expires_at) VALUES (${id}, ${code}, ${R.hashRevokeKey(revokeKey)}, ${p.label}, now() + make_interval(mins => ${R.PENDING_LINK_MIN}))`;
  const set = await sql`UPDATE watch_pairings SET claimed_link = ${id} WHERE id_hash = ${p.id_hash} AND claimed_link IS NULL RETURNING id_hash`;
  if (!set.length) { await sql`DELETE FROM watch_links WHERE id = ${id}`; throw fail(404, 'That watch code was already used. Show a new one on the watch.'); }
  if (game) await sql`UPDATE live_games SET watch_links = array_append(watch_links, ${id}) WHERE club = ${code} AND id = ${game.id}`;
  return { ok: true, link: { id, label: p.label }, revokeKey, attached: game ? game.id : null };
}

async function attach(sql, club, body, req) {
  const code = club.code, linkId = String(body.link || '');
  const [link] = await sql`SELECT id FROM watch_links WHERE id = ${linkId} AND club = ${code} AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`;
  if (!link) throw fail(404, 'That watch is not linked to this club.');
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const [game] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game || '')} AND updated_at > ${since}`;
  if (!game) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
  await requireSecret(sql, req, game, body.secret);
  await sql`UPDATE live_games SET watch_links = array_append(watch_links, ${link.id}) WHERE club = ${code} AND id = ${game.id} AND NOT (${link.id} = ANY(watch_links))`;
  return { ok: true };
}

async function list(sql, club) {
  const rows = await sql`SELECT id, label, created_at, last_seen_at, expires_at FROM watch_links WHERE club = ${club.code} AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`;
  return { links: rows.map(r => ({ id: r.id, label: r.label, createdAt: ms(r.created_at), lastSeenAt: ms(r.last_seen_at), expiresAt: ms(r.expires_at) })) };
}

// The phone that linked the watch holds the revokeKey it was given; an organizer can unlink any watch.
async function revoke(sql, club, body, req) {
  const [row] = await sql`SELECT id, revoke_hash FROM watch_links WHERE id = ${String(body.link || '')} AND club = ${club.code} AND revoked_at IS NULL`;
  if (!row) throw fail(404, 'That watch is not linked to this club.');
  if (!(body.revokeKey && R.hashEq(row.revoke_hash, R.hashRevokeKey(String(body.revokeKey))))) await requireOrganizer(club, body.pin, req, body.ownerToken);
  await revokeLink(sql, club.code, row.id);
  return { ok: true };
}

export async function watchClubAction(sql, club, body, req) {
  switch (body.action) {
    case 'watch-claim': return claim(sql, club, body, req);
    case 'watch-attach': return attach(sql, club, body, req);
    case 'watch-list': return list(sql, club);
    case 'watch-revoke': return revoke(sql, club, body, req);
  }
  throw fail(400, 'Unknown action.');
}
