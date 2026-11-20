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
//   POST watch-finish {game?}                                                                      -> a finished game is saved to the club's games by the server (saveLiveGame, _gamesave.js): {ok, id, saved}
//   POST watch-unlink                                                                              -> this watch stops working
// Phone side (club code): watch-list, watch-attach {link, game, secret}, watch-revoke {link, revokeKey | organizer}. The scoring phone also
// attaches its linked watches when it publishes a game (live.js `state`, body.watch = link ids; attachLinks below).
// A game id is the live game's id, also the id the phone saves under, so a save from the phone after the watch's is a no-op.
// A watch can only read and score the live games a phone attached to its link; it never sees the roster, history or any other game.
//
// Single-game links (no club link, no Home Screen app): a link with `game_id` set belongs to one live game and nothing else in the club. It lasts
// GAME_LINK_HOURS from when the watch collects it (never sliding), ends when the phone ends the game, and lapses GAME_LINK_END_MIN after the watch
// finishes it. Three ways to make one, all of which need the game's secret on the scoring phone or the code it shows:
//   phone  POST {code, action:'watch-claim', pair, confirm4, game, secret, single:true}  the watch's code scanned or typed in the app: like a club link, for one game
//   phone  POST {code, action:'watch-offer', game, secret}  -> {offer:{id, short, confirm4}}: the game code the scoring phone shows (one use, OFFER_TTL_MIN)
//   watch  POST {action:'watch-join', code: short, confirm4}                              -> {status:'linked', token}: the watch types the offer's 6 characters and 4 numbers
//   any    POST {action:'watch-claim-game', offer: id|short, offerConfirm?, pair: id|short, confirm4}  the watch's code and the game's code met on one page
//          (the watch's QR opened by the iPhone Camera in Safari, or the game link opened there); the watch then collects its token with watch-poll
// Typed codes keep the pairing rules: 4 numbers, 3 wrong tries end the code, wrong guesses are counted per network address.
import { fail, clientIp, purgeMarks, requireOrganizer } from './_db.js';
import { FRESH_MS, requireSecret, applyRally } from './_livecore.js';
import { saveLiveGame } from './_gamesave.js';
import * as R from './_watchrules.js';

export const WATCH_ACTIONS = ['watch-register', 'watch-poll', 'watch-state', 'watch-rally', 'watch-unrally', 'watch-finish', 'watch-unlink', 'watch-join', 'watch-claim-game']; // no club code: pairing is open, the rest carry the watch token
export const WATCH_CLUB_ACTIONS = ['watch-claim', 'watch-list', 'watch-attach', 'watch-revoke', 'watch-offer']; // the phone, with the club code

// A watch left on the QR screen registers a new QR every 5 minutes (12 an hour), and a tournament puts many watches behind one venue Wi-Fi or
// carrier address, so the network limit is only a flood ceiling (125 watches refreshing all hour). What bounds the table is the cap on live
// pairings (5 minute rows, expired ones are deleted on every registration), not a rate that honest watches could use up.
const MAX_NEW_NET = 1500;                   // registrations per network per hour
const MAX_ACTIVE_PAIRINGS = 2000;           // unexpired, unclaimed QR codes across the whole app
const MAX_BAD_CLAIMS = 10;                  // wrong link codes per network per 15 minutes
const MAX_BAD_GAME_CODES = 60;              // wrong game codes per network per 15 minutes: many people at one venue type these, and a wrong guess still faces 4 numbers and 3 tries
const MAX_ACTIVE_OFFERS = 2000;             // unexpired game codes across the whole app
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
    token ? sql`SELECT l.id AS link_id, l.label, l.created_at, l.last_seen_at, l.game_id, c.code, c.name, c.pin_hash, c.owner_hash, c.public_code, c.require_confirmation, c.public_results, c.pay_link, c.pinned_note, c.delete_at
      FROM watch_links l JOIN clubs c ON c.code = l.club
      WHERE l.token_hash = ${R.hashWatchToken(token)} AND l.revoked_at IS NULL AND l.expires_at > now()` : Promise.resolve([])
  ]);
  if (n >= MAX_BAD_TOKENS) throw fail(429, 'Too many wrong watch links. Wait 15 minutes and try again.');
  let found = rows[0];
  if (found && found.delete_at && ms(found.delete_at) <= Date.now()) { await sql`DELETE FROM clubs WHERE code = ${found.code} AND delete_at <= now()`; found = null; }
  if (!found) { await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`; throw fail(401, 'This watch is not linked any more. Link it again from the phone.'); }
  const now = Date.now();
  if (R.touchDue(ms(found.last_seen_at), now)) {
    if (found.game_id) await sql`UPDATE watch_links SET last_seen_at = now() WHERE id = ${found.link_id}`; // a single-game link never slides: it ends with the game
    else await sql`UPDATE watch_links SET last_seen_at = now(), expires_at = ${new Date(R.nextExpiry(ms(found.created_at), now)).toISOString()} WHERE id = ${found.link_id}`;
  }
  const { link_id, label, created_at, last_seen_at, game_id, ...club } = found;
  return { ...club, link: linkInfo(link_id, label, game_id) };
}
const linkInfo = (id, label, game) => ({ id, label, ...(game ? { game } : {}) });

// The live game a watch may see and score: attached to its link and fresh. `game` narrows it to one id; otherwise the latest.
// A single-game link has exactly one game, whatever `game` says.
async function attachedGame(sql, code, link, game) {
  const since = new Date(Date.now() - FRESH_MS).toISOString(), linkId = link.id;
  if (link.game) {
    if (game && String(game) !== link.game) return null;
    const [one] = await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND id = ${link.game} AND updated_at > ${since}`;
    return one || null;
  }
  const [row] = game
    ? await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND id = ${String(game)} AND ${linkId} = ANY(watch_links) AND updated_at > ${since}`
    : await sql`SELECT id, state, stack, version, ops FROM live_games WHERE club = ${code} AND ${linkId} = ANY(watch_links) AND updated_at > ${since} ORDER BY updated_at DESC LIMIT 1`;
  return row || null;
}
// The scoring phone names the watches it linked when it publishes a game; call this only after the game's secret has been checked.
// Only live links of this club count, so another club's ids (or revoked ones) are ignored.
export async function attachLinks(sql, code, gameId, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(x => /^[0-9a-f]{16}$/.test(x)))].slice(0, R.MAX_LINKS_PER_CLUB);
  if (!want.length) return 0;
  const add = (await sql`SELECT id FROM watch_links WHERE club = ${code} AND id = ANY(${want}) AND game_id IS NULL AND revoked_at IS NULL AND expires_at > now()`).map(r => r.id);
  if (!add.length) return 0;
  await sql`UPDATE live_games SET watch_links = ARRAY(SELECT DISTINCT x FROM unnest(watch_links || ${add}::text[]) AS x) WHERE club = ${code} AND id = ${String(gameId)}`;
  return add.length;
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
  await sql`DELETE FROM watch_pairings WHERE expires_at < now()`;
  const [{ n: active }] = await sql`SELECT count(*)::int AS n FROM watch_pairings WHERE claimed_link IS NULL`;
  if (active >= MAX_ACTIVE_PAIRINGS) throw fail(429, 'Many watches are linking just now. Wait a few minutes and try again.');
  await attempt(sql, 'watch-new:' + clientIp(req), MAX_NEW_NET, 60, 'Too many watch links from this connection. Try again in a few minutes.');
  await purgeMarks(sql);
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
  const [link] = await sql`UPDATE watch_links SET token_hash = ${R.hashWatchToken(token)},
      expires_at = CASE WHEN game_id IS NULL THEN now() + make_interval(days => ${R.LINK_TTL_DAYS}) ELSE now() + make_interval(hours => ${R.GAME_LINK_HOURS}) END
    WHERE id = ${gone[0].claimed_link} AND token_hash IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id, label, club, game_id`;
  if (!link) throw fail(404, 'That watch link is no longer valid. Show a new one on the watch.');
  const [c] = link.game_id ? [null] : await sql`SELECT name FROM clubs WHERE code = ${link.club}`; // a single-game link is not told the club's name
  return { ok: true, status: 'linked', token, link: linkInfo(link.id, link.label, link.game_id), club: { name: c ? c.name : '' } };
}

// ---- the watch, with its token ----
export async function watchState(sql, req) {
  const w = await requireWatch(sql, req);
  const game = await attachedGame(sql, w.code, w.link, null);
  return { scope: w.code + ':watch:' + w.link.id, body: { club: { name: w.link.game ? '' : w.name }, link: w.link, game: game ? R.watchGame(game) : null } };
}

async function tap(sql, body, req, kind) {
  const w = await requireWatch(sql, req);
  const opId = R.cleanOpId(body.opId);
  if (!opId) throw fail(400, 'Every tap needs its own id (opId) so a retry is not counted twice.');
  if (kind === 'rally' && body.side !== 0 && body.side !== 1) throw fail(400, 'Say which side scored: side 0 or 1.');
  const row = await attachedGame(sql, w.code, w.link, body.game);
  if (!row) throw fail(404, 'No game is sent to this watch. Send the game to the watch from the scoring phone.');
  return (await applyRally(sql, { code: w.code, row, kind, side: body.side, base: body.base, opId })).body;
}

// The game is over and the watch says so: save it to the club's games. Safe to repeat (the same id is stored once). The live row stays,
// so a retry after a lost answer still finds the game; the phone's own finish removes it, or it expires like any live game.
async function finish(sql, body, req) {
  const w = await requireWatch(sql, req);
  const row = await attachedGame(sql, w.code, w.link, body.game);
  if (!row) throw fail(404, 'No game is sent to this watch. Send the game to the watch from the scoring phone.');
  if (row.state.winner === null || row.state.winner === undefined) throw fail(409, 'That game is not over yet.');
  const saved = await saveLiveGame(sql, w.code, row);
  // The game is over for a single-game link: it ends shortly, long enough for a retry after a lost answer.
  if (w.link.game) await sql`UPDATE watch_links SET expires_at = LEAST(expires_at, now() + make_interval(mins => ${R.GAME_LINK_END_MIN})) WHERE id = ${w.link.id}`;
  return { ok: true, ...saved };
}

export async function watchAction(sql, body, req) {
  switch (body.action) {
    case 'watch-register': return register(sql, body, req);
    case 'watch-poll': return poll(sql, body, req);
    case 'watch-state': return (await watchState(sql, req)).body;
    case 'watch-rally': return tap(sql, body, req, 'rally');
    case 'watch-unrally': return tap(sql, body, req, 'unrally');
    case 'watch-finish': return finish(sql, body, req);
    case 'watch-join': return join(sql, body, req);
    case 'watch-claim-game': return claimGame(sql, body, req);
    case 'watch-unlink': { const w = await requireWatch(sql, req); await revokeLink(sql, w.code, w.link.id); return { ok: true }; }
  }
  throw fail(400, 'Unknown action.');
}

// ---- the phone ----
async function claim(sql, club, body, req) {
  const confirm = R.cleanConfirm(body.confirm4), raw = String(body.pair ?? '').trim();
  const pairId = R.cleanPairId(raw), short = pairId ? null : R.cleanShort(raw);
  if (!confirm || (!pairId && !short)) throw fail(400, 'Scan the code on the watch, or type its 6 characters and the 4 numbers.');
  const code = club.code, single = body.single === true;
  if (single && !(body.game !== undefined && body.game !== null && body.game !== '')) throw fail(400, 'Pick the game this watch is for: start a shared game on this phone first.');
  // Everything that can refuse comes before the pairing's try counter moves: a wrong game secret must not cost a try.
  let game = null;
  if (body.game !== undefined && body.game !== null && body.game !== '') {
    const since = new Date(Date.now() - FRESH_MS).toISOString();
    [game] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game)} AND updated_at > ${since}`;
    if (!game) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
    await requireSecret(sql, req, game, body.secret);
  }
  if (single) await requireGameRoom(sql, code, game.id);
  else {
    const [{ n: active }] = await sql`SELECT count(*)::int AS n FROM watch_links WHERE club = ${code} AND game_id IS NULL AND revoked_at IS NULL AND expires_at > now()`;
    if (active >= R.MAX_LINKS_PER_CLUB) throw fail(409, 'This club already has ' + R.MAX_LINKS_PER_CLUB + ' linked watches. Unlink one first.');
  }
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
  await sql`INSERT INTO watch_links (id, club, revoke_hash, label, expires_at, game_id) VALUES (${id}, ${code}, ${R.hashRevokeKey(revokeKey)}, ${p.label}, now() + make_interval(mins => ${R.PENDING_LINK_MIN}), ${single ? game.id : null})`;
  const set = await sql`UPDATE watch_pairings SET claimed_link = ${id} WHERE id_hash = ${p.id_hash} AND claimed_link IS NULL RETURNING id_hash`;
  if (!set.length) { await sql`DELETE FROM watch_links WHERE id = ${id}`; throw fail(404, 'That watch code was already used. Show a new one on the watch.'); }
  if (game && !single) await sql`UPDATE live_games SET watch_links = array_append(watch_links, ${id}) WHERE club = ${code} AND id = ${game.id}`;
  return { ok: true, link: linkInfo(id, p.label, single ? game.id : null), revokeKey, attached: game ? game.id : null };
}

async function attach(sql, club, body, req) {
  const code = club.code, linkId = String(body.link || '');
  // A link the watch has not collected yet counts too: the phone attaches its running game the moment it links the watch.
  const [link] = await sql`SELECT id FROM watch_links WHERE id = ${linkId} AND club = ${code} AND game_id IS NULL AND revoked_at IS NULL AND expires_at > now()`;
  if (!link) throw fail(404, 'That watch is not linked to this club.');
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const [game] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game || '')} AND updated_at > ${since}`;
  if (!game) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
  await requireSecret(sql, req, game, body.secret);
  await sql`UPDATE live_games SET watch_links = array_append(watch_links, ${link.id}) WHERE club = ${code} AND id = ${game.id} AND NOT (${link.id} = ANY(watch_links))`;
  return { ok: true };
}

async function list(sql, club) {
  const rows = await sql`SELECT id, label, game_id, created_at, last_seen_at, expires_at FROM watch_links WHERE club = ${club.code} AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`;
  return { links: rows.map(r => ({ id: r.id, label: r.label, ...(r.game_id ? { game: r.game_id } : {}), createdAt: ms(r.created_at), lastSeenAt: ms(r.last_seen_at), expiresAt: ms(r.expires_at) })) };
}

// The phone that linked the watch holds the revokeKey it was given; an organizer can unlink any watch.
async function revoke(sql, club, body, req) {
  const [row] = await sql`SELECT id, revoke_hash, game_id FROM watch_links WHERE id = ${String(body.link || '')} AND club = ${club.code} AND revoked_at IS NULL`;
  if (!row) throw fail(404, 'That watch is not linked to this club.');
  if (!(body.revokeKey && R.hashEq(row.revoke_hash, R.hashRevokeKey(String(body.revokeKey))))) {
    if (row.game_id && body.secret) { // whoever scores that game may unlink the watches on it
      const [g] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${club.code} AND id = ${row.game_id}`;
      await requireSecret(sql, req, g || { secret_hash: '-' }, body.secret);
    } else await requireOrganizer(club, body.pin, req, body.ownerToken);
  }
  await revokeLink(sql, club.code, row.id);
  return { ok: true };
}

// ---- single-game links ----
// The game must still be live and not already carry MAX_GAME_LINKS watches.
async function requireGameRoom(sql, code, gameId) {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const [live] = await sql`SELECT id FROM live_games WHERE club = ${code} AND id = ${gameId} AND updated_at > ${since}`;
  if (!live) throw fail(404, 'That game is over or is not shared. Start it again on the scoring phone.');
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM watch_links WHERE club = ${code} AND game_id = ${gameId} AND revoked_at IS NULL AND expires_at > now()`;
  if (n >= R.MAX_GAME_LINKS) throw fail(409, 'This game already has ' + R.MAX_GAME_LINKS + ' watches. Unlink one first.');
}
// The phone that scores a game ends it: its single-game links and codes end with it.
export async function endGameLinks(sql, code, gameId) {
  await sql`UPDATE watch_links SET revoked_at = now() WHERE club = ${code} AND game_id = ${gameId} AND revoked_at IS NULL`;
  await sql`DELETE FROM watch_offers WHERE club = ${code} AND game_id = ${gameId}`;
}

// The scoring phone shows a code for the game: 6 characters and 4 numbers to type on the watch (or the game link, for a phone that opens it). A new code replaces the last.
async function offer(sql, club, body, req) {
  const code = club.code, since = new Date(Date.now() - FRESH_MS).toISOString();
  const [game] = await sql`SELECT id, secret_hash FROM live_games WHERE club = ${code} AND id = ${String(body.game || '')} AND updated_at > ${since}`;
  if (!game) throw fail(404, 'No live game with that name. Check the game and secret on the scoring phone.');
  await requireSecret(sql, req, game, body.secret);
  await sql`DELETE FROM watch_offers WHERE expires_at < now()`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM watch_offers`;
  if (n >= MAX_ACTIVE_OFFERS) throw fail(429, 'Many games are showing watch codes just now. Wait a few minutes and try again.');
  await sql`DELETE FROM watch_offers WHERE club = ${code} AND game_id = ${game.id}`;
  const id = R.newOfferId(), confirm = R.newConfirm();
  await sql`INSERT INTO watch_offers (id_hash, short_hash, club, game_id, confirm, expires_at) VALUES (${R.offerHash(id)}, ${R.offerShortHash(R.shortCode(id))}, ${code}, ${game.id}, ${confirm}, now() + make_interval(mins => ${R.OFFER_TTL_MIN}))`;
  return { ok: true, offer: { id, short: R.shortCode(id), confirm4: confirm, expiresInMinutes: R.OFFER_TTL_MIN } };
}

// The game's code, found by its id (a game link: 128 bits, nothing more to type) or by the 6 typed characters, which must come with the 4 numbers:
// the same tries as a watch's code (3 wrong numbers end it). Nothing is used up yet.
async function checkOffer(sql, ref, confirm) {
  const rows = ref.id
    ? await sql`SELECT id_hash, club, game_id, confirm, tries FROM watch_offers WHERE id_hash = ${R.offerHash(ref.id)} AND expires_at > now()`
    : await sql`UPDATE watch_offers SET tries = tries + 1 WHERE short_hash = ${R.offerShortHash(ref.short)} AND expires_at > now() RETURNING id_hash, club, game_id, confirm, tries`;
  if (rows.length !== 1) throw fail(404, 'That game code is wrong, already used, or has expired. Show a new one on the scoring phone.');
  const o = rows[0];
  if (!ref.id) {
    const verdict = R.confirmVerdict(Number(o.tries), o.confirm, confirm);
    if (verdict === 'locked') { await sql`DELETE FROM watch_offers WHERE id_hash = ${o.id_hash}`; throw fail(403, 'Too many wrong numbers. Show a new game code on the scoring phone.'); }
    if (verdict !== 'ok') throw fail(403, 'Those 4 numbers do not match the scoring phone. Check its screen.');
  }
  return o;
}
// A game code is good for one watch.
async function useOffer(sql, o) {
  const gone = await sql`DELETE FROM watch_offers WHERE id_hash = ${o.id_hash} RETURNING id_hash`;
  if (!gone.length) throw fail(404, 'That game code was already used. Show a new one on the scoring phone.');
}

// The watch types the game's code and numbers and gets its token at once: it holds a link for that one game.
async function join(sql, body, req) {
  const short = R.cleanShort(body.code ?? body.short), confirm = R.cleanConfirm(body.confirm4);
  if (!short || !confirm) throw fail(400, 'Type the 6 characters and the 4 numbers shown on the scoring phone.');
  const mark = await attempt(sql, 'watch-join:' + clientIp(req), MAX_BAD_GAME_CODES, 15, 'Too many wrong game codes. Wait 15 minutes and try again.');
  await attempt(sql, 'watch-new:' + clientIp(req), MAX_NEW_NET, 60, 'Too many watch links from this connection. Try again in a few minutes.');
  const o = await checkOffer(sql, { short }, confirm);
  await requireGameRoom(sql, o.club, o.game_id);
  await useOffer(sql, o);
  await sql`DELETE FROM lookup_fails WHERE id = ${mark}`;
  const id = R.newLinkId(), token = R.newWatchToken();
  await sql`INSERT INTO watch_links (id, club, token_hash, revoke_hash, label, expires_at, game_id) VALUES (${id}, ${o.club}, ${R.hashWatchToken(token)}, ${R.hashRevokeKey(R.newRevokeKey())}, ${R.cleanLabel(body.label)}, now() + make_interval(hours => ${R.GAME_LINK_HOURS}), ${o.game_id})`;
  return { ok: true, status: 'linked', token, link: linkInfo(id, R.cleanLabel(body.label), o.game_id), club: { name: '' } };
}

// A page with no club (Safari, opened from the watch's QR or from the game link) brings the two halves together: the watch's code and the game's.
async function claimGame(sql, body, req) {
  const offerRaw = String(body.offer ?? '').trim(), offerId = R.cleanPairId(offerRaw), offerShort = offerId ? null : R.cleanShort(offerRaw);
  const offerConfirm = R.cleanConfirm(body.offerConfirm), confirm = R.cleanConfirm(body.confirm4);
  const pairRaw = String(body.pair ?? '').trim(), pairId = R.cleanPairId(pairRaw), short = pairId ? null : R.cleanShort(pairRaw);
  if (!offerId && !(offerShort && offerConfirm)) throw fail(400, 'Type the 6 characters and the 4 numbers shown on the scoring phone.');
  if (!confirm || (!pairId && !short)) throw fail(400, 'Scan the code on the watch, or type its 6 characters and the 4 numbers.');
  const mark = await attempt(sql, 'watch-gamecode:' + clientIp(req), MAX_BAD_GAME_CODES, 15, 'Too many wrong watch codes. Wait 15 minutes and try again.');
  const o = await checkOffer(sql, offerId ? { id: offerId } : { short: offerShort }, offerConfirm);
  await requireGameRoom(sql, o.club, o.game_id);
  const rows = pairId
    ? await sql`UPDATE watch_pairings SET tries = tries + 1 WHERE id_hash = ${R.pairHash(pairId)} AND expires_at > now() AND claimed_link IS NULL RETURNING id_hash, confirm, tries, label`
    : await sql`UPDATE watch_pairings SET tries = tries + 1 WHERE short_hash = ${R.shortHash(short)} AND expires_at > now() AND claimed_link IS NULL RETURNING id_hash, confirm, tries, label`;
  if (rows.length !== 1) throw fail(404, 'That watch code is wrong, already used, or has expired. Show a new one on the watch.');
  const p = rows[0], verdict = R.confirmVerdict(Number(p.tries), p.confirm, confirm);
  if (verdict !== 'ok') {
    if (verdict === 'locked') { await sql`DELETE FROM watch_pairings WHERE id_hash = ${p.id_hash}`; throw fail(403, 'Too many wrong numbers. Show a new code on the watch.'); }
    throw fail(403, 'Those 4 numbers do not match the watch. Check the watch screen.');
  }
  await useOffer(sql, o);
  await sql`DELETE FROM lookup_fails WHERE id = ${mark}`;
  const id = R.newLinkId();
  await sql`INSERT INTO watch_links (id, club, revoke_hash, label, expires_at, game_id) VALUES (${id}, ${o.club}, ${R.hashRevokeKey(R.newRevokeKey())}, ${p.label}, now() + make_interval(mins => ${R.PENDING_LINK_MIN}), ${o.game_id})`;
  const set = await sql`UPDATE watch_pairings SET claimed_link = ${id} WHERE id_hash = ${p.id_hash} AND claimed_link IS NULL RETURNING id_hash`;
  if (!set.length) { await sql`DELETE FROM watch_links WHERE id = ${id}`; throw fail(404, 'That watch code was already used. Show a new one on the watch.'); }
  return { ok: true, linked: true, label: p.label };
}

export async function watchClubAction(sql, club, body, req) {
  switch (body.action) {
    case 'watch-offer': return offer(sql, club, body, req);
    case 'watch-claim': return claim(sql, club, body, req);
    case 'watch-attach': return attach(sql, club, body, req);
    case 'watch-list': return list(sql, club);
    case 'watch-revoke': return revoke(sql, club, body, req);
  }
  throw fail(400, 'Unknown action.');
}
