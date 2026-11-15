// DUPR: link a saved player to their DUPR account, show their DUPR ratings, and send event match scores to DUPR.
// Everything here is switched off (and answers {enabled:false}) unless DUPR_CLIENT_KEY and DUPR_CLIENT_SECRET are set.
// GET  /api/dupr?code=ABC123            -> {enabled, env, loginUrl, loginOrigin, paused, players:{nameKey:{rating, provisional, at, needsRelink}}}
// POST /api/dupr {code, action, ...}
//   link    {playerName, playerToken|pin|ownerToken, userToken}  -> the phone that claimed the name (or an organizer) links it to
//                                                                  the DUPR account that just signed in. userToken is used once and not kept.
//   unlink  {playerName, playerToken|pin|ownerToken}              -> forgets the DUPR id and rating of that player
//   refresh {playerName}                                          -> reads the player's current DUPR ratings (cached for 15 minutes)
//   review  {id, tz?, pin|ownerToken}                             -> organizer: every finished match of event `id`, ready or blocked and why
//   send    {id, tz?, confirm:true, matchIds?, retryFailed?, pin|ownerToken} -> organizer: sends what review says is ready
// DUPR data never goes into /api/club or the events API, so it stays out of anything public. Event matches reach DUPR only
// from here and never write to `games`, so the app's ratings can't double count.
import { db, handler, send, readBody, fail, cleanCode, requireClub, requireOrganizer, tokenMatches, cleanName, clientIp } from './_db.js';
import { config, publicConfig, DuprError, userInfo, entitlements, userRatings, createBatch, updateMatch, deleteMatch } from './_duprapi.js';
import { ensureDuprSchema, linkMap, getPause, setPause } from './_dupr_store.js';
import { listEventMatches, preflight, toDuprMatch, fingerprint, plan, chunk, cleanZone, classify, redact, BATCH_SIZE } from './_dupr_map.js';

const RATING_TTL = 15 * 60 * 1000;   // a player's DUPR rating is read from DUPR at most this often
const LINKS_PER_15_MIN = 12;           // link attempts per network address (each one calls DUPR)

// A DuprError becomes an HTTP error for the app. Never includes tokens.
function upstream(err) {
  if (!(err instanceof DuprError)) return err;
  if (err.consent) return Object.assign(fail(409, 'DUPR says this account has not shared its details with this app. Connect DUPR again and approve the consent screen.'), { relink: true });
  if (err.kind === 'retry') return fail(503, 'DUPR is not reachable right now. Try again in a moment.');
  if (err.kind === 'pause' || err.kind === 'reauth') return fail(502, 'DUPR refused the request' + (err.upstream ? ` (${err.upstream})` : '') + '. Try connecting again; if it keeps happening, this app is not set up with DUPR yet.');
  return fail(400, err.message || 'DUPR could not do that.');
}
const isUnique = e => !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(String(e.message)));

// The phone that claimed this name, or an organizer.
async function requireOwnerOrOrganizer(sql, club, code, body, req) {
  const name = cleanName(body.playerName);
  if (!name) throw fail(400, 'Which player?');
  const [row] = await sql`SELECT name, name_key, claim_hash, dupr_id FROM roster WHERE club = ${code} AND name_key = ${name.toLowerCase()}`;
  if (!row) throw fail(404, 'That player is not saved in this club.');
  if (!(row.claim_hash && tokenMatches(row.claim_hash, body.playerToken))) await requireOrganizer(club, body.pin, req, body.ownerToken);
  return row;
}

const ratingView = s => s && { rating: s.rating || { doubles: null, singles: null }, provisional: s.provisional || { doubles: false, singles: false }, at: s.at || null, needsRelink: !!s.needsRelink };

// ---- the review of an event: what each finished match would do at DUPR ----
async function loadEvent(sql, code, id) {
  const [row] = await sql`SELECT data FROM events WHERE club = ${code} AND id = ${String(id || '')} AND deleted_at IS NULL`;
  if (!row) throw fail(404, 'That event no longer exists.');
  return row.data;
}
async function buildReview(sql, code, ev, tz) {
  const links = await linkMap(sql, code);
  const like = ev.id + '-%';
  const rows = new Map((await sql`SELECT * FROM dupr_matches WHERE club = ${code} AND game_id LIKE ${like}`).map(r => [r.game_id, r]));
  const live = new Map((await sql`SELECT id, deleted_at IS NULL AS live FROM games WHERE club = ${code} AND id LIKE ${like}`).map(r => [r.id, r.live]));
  const now = Date.now();
  return listEventMatches(ev).map(m => {
    const row = rows.get(m.gameId) || null;
    const reasons = preflight(m, links, { now });
    const fp = reasons.length ? null : fingerprint(toDuprMatch({ club: code, ev, m, links, tz }));
    const p = plan({ row, gameLive: live.get(m.gameId) === true, reasons, fp });
    const payload = (p.state === 'ready' || p.state === 'failed') && (p.action === 'create' || p.action === 'update') ? toDuprMatch({ club: code, ev, m, links, revision: p.revision, tz }) : null;
    const note = [p.note, row && row.error && p.state !== 'sent' && p.state !== 'failed' ? 'Last answer from DUPR: ' + row.error : ''].filter(Boolean).join(' ');
    return { matchId: m.matchId, gameId: m.gameId, round: m.round, teams: m.teams, score: m.score, state: p.state, action: p.action, reasons: p.reasons, note: note || undefined, _row: row, _payload: payload, _fp: fp };
  });
}
const publicItem = ({ _row, _payload, _fp, ...rest }) => rest;
function summarize(items) {
  const s = { ready: 0, blocked: 0, sent: 0, failed: 0, skipped: 0 };
  for (const i of items) s[i.state]++;
  return s;
}
async function reviewBody(sql, code, ev, tz) {
  const items = await buildReview(sql, code, ev, tz);
  const pause = await getPause(sql);
  return { items: items.map(publicItem), summary: summarize(items), rounds: [...new Set(items.map(i => i.round))], paused: pause && { reason: pause.reason, until: pause.until }, items_: items };
}

// ---- sending: every match is written as 'pending' first, then DUPR is called, then the answer is saved ----
// A row is claimed for 2 minutes (lease_at) so two phones pressing Send at once can't send the same match twice.
const markSent = (sql, code, gameId, c, fp, payload, error = null) => sql`UPDATE dupr_matches SET status = 'sent', match_code = ${c.matchCode}, hashed_code = ${c.hashedCode}, error = ${error},
  payload_hash = ${fp}, payload = ${JSON.stringify(payload)}::jsonb, sent_at = now(), lease_at = NULL, updated_at = now() WHERE club = ${code} AND game_id = ${gameId}`;
const markStatus = (sql, code, gameId, status, error) => sql`UPDATE dupr_matches SET status = ${status}, error = ${error ? String(error).slice(0, 300) : null}, lease_at = NULL, updated_at = now() WHERE club = ${code} AND game_id = ${gameId}`;
const markError = (sql, code, gameId, error) => sql`UPDATE dupr_matches SET error = ${String(error).slice(0, 300)}, lease_at = NULL, updated_at = now() WHERE club = ${code} AND game_id = ${gameId}`;

async function claimNew(sql, code, it) {
  const p = it._payload, row = it._row, json = JSON.stringify(p);
  if (!row) {
    const r = await sql`INSERT INTO dupr_matches (club, game_id, revision, identifier, status, payload_hash, payload, attempts, lease_at)
      VALUES (${code}, ${it.gameId}, 1, ${p.identifier}, 'pending', ${it._fp}, ${json}::jsonb, 1, now()) ON CONFLICT (club, game_id) DO NOTHING RETURNING game_id`;
    return r.length > 0;
  }
  const revision = Number(p.identifier.split('-r').pop());
  const r = await sql`UPDATE dupr_matches SET revision = ${revision}, identifier = ${p.identifier}, status = 'pending',
      match_code = CASE WHEN status = 'deleted' THEN NULL ELSE match_code END, hashed_code = CASE WHEN status = 'deleted' THEN NULL ELSE hashed_code END,
      payload_hash = ${it._fp}, payload = ${json}::jsonb, attempts = attempts + 1, lease_at = now(), updated_at = now()
    WHERE club = ${code} AND game_id = ${it.gameId} AND status = ${row.status} AND revision = ${row.revision}
      AND (lease_at IS NULL OR lease_at < now() - interval '2 minutes') RETURNING game_id`;
  return r.length > 0;
}
async function claimSent(sql, code, it) {
  const r = await sql`UPDATE dupr_matches SET lease_at = now(), attempts = attempts + 1 WHERE club = ${code} AND game_id = ${it.gameId} AND status = 'sent' AND match_code = ${it._row.match_code}
    AND (lease_at IS NULL OR lease_at < now() - interval '2 minutes') RETURNING game_id`;
  return r.length > 0;
}

async function sendEvent(sql, cfg, code, ev, body) {
  const pause = await getPause(sql);
  if (pause) throw fail(503, `Sending to DUPR is paused: ${pause.reason} It will try again after ${new Date(pause.until).toISOString().slice(11, 16)} UTC.`);
  const items = await buildReview(sql, code, ev, cleanZone(body.tz));
  const only = Array.isArray(body.matchIds) ? new Set(body.matchIds.map(String)) : null;
  const todo = items.filter(i => (!only || only.has(i.matchId)) && (i.state === 'ready' || (body.retryFailed === true && i.state === 'failed')));
  const out = { created: 0, updated: 0, deleted: 0, failed: 0, retryLater: 0, alreadyAtDupr: 0, busy: 0, paused: null };
  const secrets = [cfg.key, cfg.secret];
  const stop = { v: false };

  // A failure of a whole call: the account is refused (pause everything), DUPR is unreachable (stop and keep the rows
  // pending), or the match itself is refused.
  async function wholeFailure(err, rows, onPermanent) {
    if (!(err instanceof DuprError)) throw err;
    const msg = redact(err.message, secrets);
    if (err.kind === 'pause' || err.kind === 'reauth') {
      const reason = err.upstream === 417 ? 'DUPR says the app\'s account has expired (417).' : err.upstream === 403 ? 'DUPR refused this app\'s request (403): the app may lack permission to send matches.' : 'DUPR did not accept the app\'s credentials.';
      await setPause(sql, reason, err.upstream);
      out.paused = { reason }; stop.v = true;
      for (const it of rows) await markError(sql, code, it.gameId, reason);
      out.retryLater += rows.length;
    } else if (err.kind === 'retry') {
      stop.v = true;
      for (const it of rows) await markError(sql, code, it.gameId, 'DUPR was not reachable. It will be retried.');
      out.retryLater += rows.length;
    } else {
      for (const it of rows) await onPermanent(it, msg, err);
    }
  }

  // 1. New matches, in batches of 100.
  const claimed = [];
  for (const it of todo.filter(i => i.action === 'create')) { if (await claimNew(sql, code, it)) claimed.push(it); else out.busy++; }
  for (const part of chunk(claimed, BATCH_SIZE)) {
    if (stop.v) { for (const it of part) await markError(sql, code, it.gameId, out.paused ? out.paused.reason : 'DUPR was not reachable. It will be retried.'); out.retryLater += part.length; continue; }
    try {
      const r = await createBatch(cfg, part.map(i => i._payload));
      for (const it of part) {
        const id = it._payload.identifier;
        if (r.created.has(id)) {
          const c = r.created.get(id);
          await markSent(sql, code, it.gameId, { matchCode: c.matchCode, hashedCode: c.hashedMatchCode }, it._fp, it._payload); out.created++;
        } else if (r.errors.has(id)) {
          const text = r.errors.get(id), kind = classify({ message: text });
          if (kind === 'duplicate') { // DUPR has it already (an earlier reply was lost), but we never saw its match code
            await markSent(sql, code, it.gameId, { matchCode: null, hashedCode: null }, it._fp, it._payload, 'DUPR already had this match, but its match code was not saved.'); out.alreadyAtDupr++;
          } else if (kind === 'retry') { await markStatus(sql, code, it.gameId, 'pending', text); out.retryLater++; }
          else { await markStatus(sql, code, it.gameId, 'failed', text); out.failed++; }
        } else { await markStatus(sql, code, it.gameId, 'pending', 'DUPR did not answer for this match.'); out.retryLater++; }
      }
    } catch (err) {
      await wholeFailure(err, part, async (it, msg) => { await markStatus(sql, code, it.gameId, 'failed', msg); out.failed++; });
    }
  }

  // 2. Matches whose score changed after they were sent, one at a time.
  for (const it of todo.filter(i => i.action === 'update')) {
    if (stop.v) break;
    const matchId = /^\d{1,15}$/.test(String(it._row.match_code || '')) ? Number(it._row.match_code) : null;
    if (matchId === null) { await markError(sql, code, it.gameId, 'The match code from DUPR is not a number, so it cannot be updated until checked in UAT.'); out.failed++; continue; }
    if (!(await claimSent(sql, code, it))) { out.busy++; continue; }
    try {
      await updateMatch(cfg, matchId, it._payload);
      await markSent(sql, code, it.gameId, { matchCode: it._row.match_code, hashedCode: it._row.hashed_code }, it._fp, it._payload); out.updated++;
    } catch (err) {
      await wholeFailure(err, [it], async (row, msg) => { await markError(sql, code, row.gameId, msg); out.failed++; });
    }
  }

  // 3. Matches deleted from the club record after they were sent.
  for (const it of todo.filter(i => i.action === 'delete')) {
    if (stop.v) break;
    if (!(await claimSent(sql, code, it))) { out.busy++; continue; }
    try {
      await deleteMatch(cfg, { matchCode: it._row.match_code, identifier: it._row.identifier });
      await markStatus(sql, code, it.gameId, 'deleted', null); out.deleted++;
    } catch (err) {
      await wholeFailure(err, [it], async (row, msg, e) => {
        if (e.upstream === 404) { await markStatus(sql, code, row.gameId, 'deleted', null); out.deleted++; } // already gone at DUPR
        else { await markError(sql, code, row.gameId, msg); out.failed++; }
      });
    }
  }
  return out;
}

// Link attempts call DUPR three times, so they are limited per network address.
async function limitLinks(sql, req) {
  const key = 'dupr:' + clientIp(req);
  await sql`INSERT INTO lookup_fails (ip) VALUES (${key})`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '15 minutes'`;
  if (n > LINKS_PER_15_MIN) throw fail(429, 'Too many DUPR connection attempts. Wait 15 minutes and try again.');
}

export default handler(async (req, res) => {
  const cfg = config();
  if (!cfg) { // switched off: no database use, nothing to see
    if (req.method === 'GET') return send(res, 200, { enabled: false });
    throw fail(404, 'Not found.');
  }
  const sql = db();
  await ensureDuprSchema();

  if (req.method === 'GET') {
    const code = cleanCode(new URL(req.url, 'http://x').searchParams.get('code'));
    await requireClub(code, req);
    const rows = await sql`SELECT name_key, dupr_snapshot FROM roster WHERE club = ${code} AND dupr_id IS NOT NULL`;
    const pause = await getPause(sql);
    return send(res, 200, Object.assign({ enabled: true }, publicConfig(cfg), {
      paused: pause && { reason: pause.reason, until: pause.until },
      players: Object.fromEntries(rows.map(r => [r.name_key, ratingView(r.dupr_snapshot) || { rating: { doubles: null, singles: null }, provisional: { doubles: false, singles: false }, at: null, needsRelink: false }]))
    }));
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const body = await readBody(req);
  const code = cleanCode(body.code);
  const club = await requireClub(code, req);
  const action = String(body.action || '');

  if (action === 'link') {
    const row = await requireOwnerOrOrganizer(sql, club, code, body, req);
    const userToken = String(body.userToken || '');
    if (!/^[\w.~+/=-]{20,6000}$/.test(userToken)) throw fail(400, 'DUPR did not send a sign-in. Try connecting again.');
    await limitLinks(sql, req);
    try {
      // The browser's message from the login iframe can't be trusted, so DUPR is asked who this token belongs to.
      const { duprId } = await userInfo(cfg, userToken);
      const [other] = await sql`SELECT name FROM roster WHERE club = ${code} AND dupr_id = ${duprId} AND name_key <> ${row.name_key}`;
      if (other) throw fail(409, `That DUPR account is already linked to ${other.name}.`);
      const ents = await entitlements(cfg, userToken);
      let rating = { doubles: null, singles: null }, provisional = { doubles: false, singles: false };
      try { ({ rating, provisional } = await userRatings(cfg, duprId)); } catch { /* the link still works without a rating */ }
      const snapshot = { at: Date.now(), rating, provisional, basic: ents ? ents.includes('BASIC_L1') : null };
      try {
        await sql`UPDATE roster SET dupr_id = ${duprId}, dupr_linked_at = now(), dupr_snapshot = ${JSON.stringify(snapshot)}::jsonb WHERE club = ${code} AND name_key = ${row.name_key}`;
      } catch (err) { if (isUnique(err)) throw fail(409, 'That DUPR account is already linked to another player in this club.'); throw err; }
      return send(res, 200, { ok: true, linked: true, duprId, name: row.name, snapshot: ratingView(snapshot), basic: snapshot.basic });
    } catch (err) { throw upstream(err); }
  }

  if (action === 'unlink') {
    const row = await requireOwnerOrOrganizer(sql, club, code, body, req);
    await sql`UPDATE roster SET dupr_id = NULL, dupr_linked_at = NULL, dupr_snapshot = NULL WHERE club = ${code} AND name_key = ${row.name_key}`;
    return send(res, 200, { ok: true });
  }

  if (action === 'refresh') {
    const name = cleanName(body.playerName);
    const [row] = await sql`SELECT name_key, dupr_id, dupr_snapshot FROM roster WHERE club = ${code} AND name_key = ${name.toLowerCase()} AND dupr_id IS NOT NULL`;
    if (!row) throw fail(404, 'That player is not linked to DUPR.');
    const snap = row.dupr_snapshot || {};
    if (snap.at && Date.now() - snap.at < RATING_TTL && !snap.needsRelink) return send(res, 200, { ok: true, cached: true, snapshot: ratingView(snap) });
    try {
      const { rating, provisional } = await userRatings(cfg, row.dupr_id);
      const next = Object.assign({}, snap, { at: Date.now(), rating, provisional, needsRelink: false });
      await sql`UPDATE roster SET dupr_snapshot = ${JSON.stringify(next)}::jsonb WHERE club = ${code} AND name_key = ${row.name_key}`;
      return send(res, 200, { ok: true, cached: false, snapshot: ratingView(next) });
    } catch (err) {
      // 403 (or a consent message) means this player no longer shares their DUPR details with the app: ask them to connect again.
      if (err instanceof DuprError && (err.kind === 'pause' || err.consent)) {
        const next = Object.assign({}, snap, { needsRelink: true, at: Date.now() });
        await sql`UPDATE roster SET dupr_snapshot = ${JSON.stringify(next)}::jsonb WHERE club = ${code} AND name_key = ${row.name_key}`;
        return send(res, 200, { ok: true, needsRelink: true, snapshot: ratingView(next) });
      }
      throw upstream(err);
    }
  }

  if (action === 'review' || action === 'send') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const ev = await loadEvent(sql, code, body.id);
    if (action === 'send') {
      if (body.confirm !== true) throw fail(400, 'Confirm before sending scores to DUPR.');
      const results = await sendEvent(sql, cfg, code, ev, body);
      const r = await reviewBody(sql, code, ev, cleanZone(body.tz));
      delete r.items_;
      return send(res, 200, Object.assign({ ok: true, results }, r));
    }
    const r = await reviewBody(sql, code, ev, cleanZone(body.tz));
    delete r.items_;
    return send(res, 200, r);
  }
  throw fail(400, 'Unknown action.');
});
