// GET  /api/club?code=ABC123                         -> club name, whether it has a PIN, games (newest first), saved players, recently deleted
// POST /api/club {name, pin?}                        -> creates a club with an organizer PIN (the one given, or a generated 8-digit organizer code returned once as organizerCode), returns its code
// POST /api/club {code, action: 'rotate-code', pin?, ownerToken?, graceMinutes?} -> organizer only: gives the club a new code; the old one keeps working for graceMinutes (default 60, at most 1440), then stops
// POST /api/club {code, action: 'export', format?: 'csv', pin|ownerToken} -> organizer: the whole club as JSON, or its games as CSV
// POST /api/club {code, action: 'delete-club', confirm, pin|ownerToken}     -> organizer: schedules the club for deletion in 24 hours (confirm = the club's name)
// POST /api/club {code, action: 'cancel-delete-club', pin|ownerToken}       -> organizer: undoes that while the window is open
// POST /api/club {room: true}                      -> {room: code}: a throwaway room for one shared game with no club (watch linking); no name, PIN or organizer, removed when the game ends or after 24 hours
// POST /api/club {code, action: 'verify-pin', pin}   -> checks an organizer PIN
// POST /api/club {code, action: 'reset-allowance', pin|ownerToken} -> organizer: ends a "too many games just now" pause
// GET  /api/club?code=ABC123&avatars=1               -> the photo avatars, kept out of the main response: {photos: {name: {v, value}}}
//   GET answers carry an ETag; If-None-Match with it gets an empty 304 when nothing changed (Sync v2, see _sync.js). No tag sent: the full answer, as before.
// POST /api/club {code, action: 'set-confirmation', required, pin|ownerToken} -> organizer: whether games without a confirmation count toward ratings, achievements and seasons (default: they count)
// GET  /api/club?code=ABC123&analytics=1&tz=Europe/London (X-Club-PIN / X-Club-Owner) -> organizer: attendance by week, retention and busiest hours (totals only, see _analytics.js)
// GET answers also carry, for each game, confirmed {by, at} and hold (true: left out of ratings until confirmed), plus dupes: pairs of game ids that look like one game recorded twice.
// POST /api/club {code, action: 'set-pay-link', link, pin|ownerToken} -> organizer: an optional https "how to pay" link for dues or court fees (empty clears it); the app takes no payments
// POST /api/club {code, action: 'set-note', note, pin|ownerToken}      -> organizer: a pinned note (plain text, 500 characters, empty clears it) shown to every member
//   Both come back to members as payLink and note on `club` in GET answers.
// POST /api/club {code, action: 'set-pin', pin, oldPin?, ownerToken?} -> sets the organizer PIN (the first needs the creator token; changing needs the current PIN)
import { manageResults } from './_resultsadmin.js';
import { analyticsRoute } from './_analytics.js';
import { tagOf, sameTag, notModified, clubDigest, BUCKET_MS } from './_sync.js';
import { cleanPayLink, cleanNote } from './_clubinfo.js';
import { db, handler, send, readBody, fail, newCode, cleanCode, requireClub, publicClub, codeTaken, requireOrganizer, pinFrom, ownerFrom, cleanPin, hashPin, requirePin, deviceKey, throttleClubCreate, resetAllowance, MAX_LIVE_GAMES, MAX_PHOTOS, newOwnerToken, hashToken, tokenMatches, cleanName } from './_db.js';
import { randomInt } from 'node:crypto';
import { duprFrom } from './_dupr.js';
import { audit, organizerActor } from './_audit.js';
import { counts, findDuplicates } from './_confirm.js';
import { DELETE_UNDO_HOURS, gamesCsv } from './_privacy.js';
import { computeProgress, ACHIEVEMENTS, CHALLENGES, challengesFor, weekOf, seasonOf, SEASON_MIN_GAMES } from './_progress.js';
import { refreshRatings, ratingsFor } from './_rating_store.js';

// Achievements, this week's challenges, and trophies for every player, as the server counts them.
function progressFor(games) {
  const now = Date.now(), week = weekOf(now), season = seasonOf(now);
  const players = {};
  for (const [k, p] of computeProgress(games, now)) {
    players[k] = { name: p.name, achievements: p.achievements, trophies: p.trophies, week: p.weeks[week.id] || null };
  }
  return {
    players,
    achievements: ACHIEVEMENTS,
    week: { id: week.id, end: week.end, challenges: challengesFor(week.id) },
    challenges: CHALLENGES,
    season: Object.assign({}, season, { minGames: SEASON_MIN_GAMES })
  };
}

export default handler(async (req, res) => {
  const sql = db();
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (String(body.action || '').startsWith('results-')) return manageResults(req, res, body);
    if (body.action === 'reset-allowance') {
      const club = await requireClub(cleanCode(body.code), req);
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      await resetAllowance(club.code);
      const [n] = await sql`SELECT count(*)::int AS live FROM games WHERE club = ${club.code} AND deleted_at IS NULL`;
      return send(res, 200, { ok: true, games: Number(n.live), limit: MAX_LIVE_GAMES });
    }
    if (body.action === 'set-confirmation') {
      const club = await requireClub(cleanCode(body.code), req);
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      if (typeof body.required !== 'boolean') throw fail(400, 'Say whether confirmation is required.');
      await sql`UPDATE clubs SET require_confirmation = ${body.required} WHERE code = ${club.code}`;
      if (!!club.require_confirmation !== body.required) await audit(sql, club.code, '', 'setting', await organizerActor(club, body.ownerToken), { requireConfirmation: !!club.require_confirmation }, { requireConfirmation: body.required });
      return send(res, 200, { ok: true, requireConfirmation: body.required });
    }
    if (body.action === 'set-pay-link' || body.action === 'set-note') {
      const club = await requireClub(cleanCode(body.code), req);
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      const isLink = body.action === 'set-pay-link';
      let value;
      try { value = (isLink ? cleanPayLink : cleanNote)(isLink ? body.link : body.note); } catch (e) { throw fail(400, e.message); }
      if (isLink) await sql`UPDATE clubs SET pay_link = ${value || null} WHERE code = ${club.code}`;
      else await sql`UPDATE clubs SET pinned_note = ${value || null} WHERE code = ${club.code}`;
      return send(res, 200, isLink ? { ok: true, payLink: value } : { ok: true, note: value });
    }
    if (body.action === 'export' || body.action === 'delete-club' || body.action === 'cancel-delete-club') {
      const club = await requireClub(cleanCode(body.code), req);
      const who = await requireOrganizer(club, body.pin, req, body.ownerToken);
      // Exporting is for any organizer. Deleting the club is for the creating phone or the PIN only: a co-organizer can't remove the club.
      if (body.action !== 'export' && who.by === 'organizer') throw fail(403, 'Only the club creator or the organizer PIN can delete the club.');
      const code = club.code;
      if (body.action === 'export') {
        const [games, roster, events, leagues, trail, gameTrail] = await Promise.all([
          sql`SELECT data, deleted_at, rally_log FROM games WHERE club = ${code} ORDER BY ended_at DESC`,
          sql`SELECT name, claim_hash IS NOT NULL AS claimed, avatar, dupr_rating, role, blocked_at FROM roster WHERE club = ${code} ORDER BY lower(name)`,
          sql`SELECT id, data, status, created_at, updated_at, deleted_at FROM events WHERE club = ${code} ORDER BY created_at`,
          sql`SELECT id, data, status, created_at, deleted_at FROM leagues WHERE club = ${code} ORDER BY created_at`,
          sql`SELECT at, actor, actor_name, action, target, detail FROM club_audit WHERE club = ${code} ORDER BY id`,
          sql`SELECT game, action, actor, at, before, after, note FROM game_audit WHERE club = ${code} ORDER BY id`
        ]);
        // Not exported: the PIN and phone tokens, public bracket tokens, and DUPR links and IDs (those stay out of every club export).
        if (body.format === 'csv') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="dink-score-games.csv"');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(gamesCsv(games));
        }
        return send(res, 200, {
          format: 'dink-score-club-export', version: 1, exportedAt: new Date().toISOString(),
          club: { name: club.name, code: club.public_code || club.code },
          players: roster.map(r => ({ name: r.name, linkedToPhone: r.claimed, avatar: r.avatar || null, duprSelfReported: duprFrom(r.dupr_rating), role: r.role || 'player', removed: !!r.blocked_at })),
          games: games.map(r => ({ ...r.data, deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, ...(r.rally_log ? { rallyLog: r.rally_log } : {}) })),
          events: events.map(r => ({ id: r.id, status: r.status, createdAt: new Date(r.created_at).toISOString(), deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, event: r.data })),
          leagues: leagues.map(r => ({ id: r.id, status: r.status, createdAt: new Date(r.created_at).toISOString(), deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, league: r.data })),
          // Who changed what. Actors are kinds of credential ('creator', 'organizer-pin', 'player:<name>'), never tokens or PINs.
          memberLog: trail.map(r => ({ at: new Date(r.at).toISOString(), actor: r.actor, actorName: r.actor_name, action: r.action, target: r.target, detail: r.detail })),
          gameLog: gameTrail.map(r => ({ game: r.game, at: new Date(r.at).toISOString(), action: r.action, actor: r.actor, before: r.before, after: r.after, note: r.note }))
        });
      }
      if (body.action === 'delete-club') {
        // Typing the club's name is the confirmation. The club keeps working during the undo window, then everything in it is removed.
        if (cleanName(body.confirm) !== club.name) throw fail(400, 'Type the club name exactly to confirm.');
        const rows = await sql`UPDATE clubs SET delete_at = coalesce(delete_at, now() + ${DELETE_UNDO_HOURS + ' hours'}::interval) WHERE code = ${code} RETURNING delete_at`;
        return send(res, 200, { ok: true, deleteAt: new Date(rows[0].delete_at).getTime() });
      }
      await sql`UPDATE clubs SET delete_at = NULL WHERE code = ${code}`;
      return send(res, 200, { ok: true });
    }
    if (body.action === 'verify-pin' || body.action === 'set-pin' || body.action === 'rotate-code') {
      const club = await requireClub(cleanCode(body.code), req);
      const code = club.code; // permanent key
      if (body.action === 'verify-pin') {
        if (!club.pin_hash) throw fail(400, "This club doesn't have an organizer PIN yet.");
        await requirePin(club, body.pin, req);
        // deviceKey: lets this phone keep working when others guess wrong (see requirePin). shortPin: this PIN predates
        // the 6-digit minimum, so the app asks the organizer to change it.
        return send(res, 200, { ok: true, deviceKey: deviceKey(club), shortPin: String(body.pin).split(':')[0].length < 6 });
      }
      if (body.action === 'rotate-code') {
        await requireOrganizer(club, body.pin, req, body.ownerToken);
        const grace = body.graceMinutes === undefined ? 60 : Math.trunc(Number(body.graceMinutes));
        if (!Number.isFinite(grace) || grace < 0 || grace > 1440) throw fail(400, 'The overlap must be between 0 and 1,440 minutes.');
        const current = club.public_code || club.code;
        let fresh = null;
        for (let i = 0; i < 8 && !fresh; i++) { const c = newCode(); if (!(await codeTaken(sql, c))) fresh = c; }
        if (!fresh) throw fail(500, 'Could not create a club code.');
        // Retire the old code first, then switch: a failure in between leaves the club on its old code.
        const until = await sql`INSERT INTO club_aliases (code, club, expires_at) VALUES (${current}, ${code}, now() + ${grace + ' minutes'}::interval) ON CONFLICT (code) DO UPDATE SET expires_at = EXCLUDED.expires_at RETURNING expires_at`;
        const rows = await sql`UPDATE clubs SET public_code = ${fresh} WHERE code = ${code} AND coalesce(public_code, code) = ${current} RETURNING code, name, pin_hash, owner_hash, public_code, require_confirmation, public_results, pay_link, pinned_note, delete_at`;
        if (!rows.length) throw fail(409, 'The club code was just changed by someone else. Reload and check the new code.');
        return send(res, 200, { ok: true, club: publicClub(rows[0]), oldCode: current, oldCodeUntil: new Date(until[0].expires_at).getTime() });
      }
      const pin = cleanPin(body.pin);
      if (club.pin_hash) {
        // Changing a PIN needs the current one.
        await requirePin(club, body.oldPin, req, body.ownerToken); // the creating phone can reset a forgotten PIN
        const pinHash = hashPin(pin);
        await sql`UPDATE clubs SET pin_hash = ${pinHash} WHERE code = ${code}`;
        return send(res, 200, { ok: true, club: Object.assign(publicClub(club), { hasPin: true, openClaim: false }), deviceKey: deviceKey({ code, pin_hash: pinHash }) });
      }
      // The first PIN: only the phone that created the club (it holds the creator token) may set it.
      // Older clubs made before creator tokens existed can be claimed once by any member, who then becomes the creator.
      let ownerToken = null;
      if (club.owner_hash) {
        if (!tokenMatches(club.owner_hash, body.ownerToken)) throw fail(403, 'Only the phone that created this club can set its first organizer PIN.');
      } else {
        ownerToken = newOwnerToken();
      }
      // Atomic: succeeds only while the club still has no PIN, so two people can't both set the first one.
      const pinHash = hashPin(pin);
      const rows = ownerToken
        ? await sql`UPDATE clubs SET pin_hash = ${pinHash}, owner_hash = ${hashToken(ownerToken)} WHERE code = ${code} AND pin_hash IS NULL AND owner_hash IS NULL RETURNING code`
        : await sql`UPDATE clubs SET pin_hash = ${pinHash} WHERE code = ${code} AND pin_hash IS NULL RETURNING code`;
      if (!rows.length) throw fail(409, 'Someone just set a PIN for this club. Ask your organizer for it.');
      return send(res, 200, { ok: true, club: Object.assign(publicClub(club), { hasPin: true, openClaim: false }), deviceKey: deviceKey({ code, pin_hash: pinHash }), ...(ownerToken ? { ownerToken } : {}) });
    }
    if (body.room === true) { // a phone with no club shares one game: a nameless room with no organizer that goes with the game, or after 24 hours
      await throttleClubCreate(req, true);
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        if (await codeTaken(sql, code)) continue;
        const rows = await sql`INSERT INTO clubs (code, name, quick, delete_at) VALUES (${code}, 'Quick game', true, now() + interval '24 hours') ON CONFLICT DO NOTHING RETURNING code`;
        if (rows.length) return send(res, 201, { room: rows[0].code });
      }
      throw fail(500, 'Could not create a game code.');
    }
    const name = cleanName(body.name); // same cleanup as player names: no control or invisible characters
    if (!name) throw fail(400, 'Give your club a name.');
    // Every new club has an organizer credential: the PIN given, or a generated 8-digit organizer code shown once.
    const organizerCode = body.pin ? null : String(randomInt(0, 1e8)).padStart(8, '0');
    const pinPlain = organizerCode || cleanPin(body.pin); // a bad PIN is refused before it uses up a creation
    await throttleClubCreate(req);
    const pinHash = hashPin(pinPlain);
    const ownerToken = newOwnerToken();
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      if (await codeTaken(sql, code)) continue;
      const rows = await sql`INSERT INTO clubs (code, name, pin_hash, owner_hash) VALUES (${code}, ${name}, ${pinHash}, ${hashToken(ownerToken)}) ON CONFLICT DO NOTHING RETURNING code, name, pin_hash, owner_hash, public_code`;
      if (rows.length) return send(res, 201, { club: publicClub(rows[0]), ownerToken, ...(organizerCode ? { organizerCode } : {}) });
    }
    throw fail(500, 'Could not create a club code.');
  }
  if (req.method !== 'GET') throw fail(405, 'Method not allowed.');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('results') === 'list') return manageResults(req, res, null);
  const club = await requireClub(cleanCode(url.searchParams.get('code')), req);
  const code = club.code;
  if (url.searchParams.get('analytics')) {
    await requireOrganizer(club, pinFrom(req), req, ownerFrom(req));
    return send(res, 200, await analyticsRoute(sql, club, url.searchParams.get('tz')));
  }
  if (url.searchParams.get('avatars')) {
    // Photos are the only large part of a player, so they come separately; `v` is a short fingerprint the app compares
    // with the one in the main response to know when a cached photo is stale. The browser keeps this answer and
    // revalidates it with its ETag, so photos cross the network once per change, not once per launch.
    const prints = await sql`SELECT name, left(md5(avatar->>'value'), 8) AS v FROM roster WHERE club = ${code} AND avatar->>'type' = 'photo' ORDER BY lower(name) LIMIT ${MAX_PHOTOS}`;
    const tag = tagOf(code + ':avatars', JSON.stringify(prints));
    if (sameTag(req, tag)) return notModified(res, tag, 'private, no-cache');
    const rows = await sql`SELECT name, left(md5(avatar->>'value'), 8) AS v, avatar->>'value' AS value FROM roster WHERE club = ${code} AND avatar->>'type' = 'photo' ORDER BY lower(name) LIMIT ${MAX_PHOTOS}`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', tag);
    return res.end(JSON.stringify({ photos: Object.fromEntries(rows.map(r => [r.name, { v: r.v, value: r.value }])) }));
  }
  // Nothing changed since the caller's last answer: say so before reading any game (see _sync.js). The tag is made from a
  // digest taken first, so a change landing mid-request only ever makes the next poll fetch once more, never miss it.
  const now = Date.now();
  const tag = tagOf(code, [await clubDigest(sql, code), JSON.stringify(publicClub(club)), weekOf(now).id, seasonOf(now).id, Math.floor(now / BUCKET_MS)].join('#'));
  if (sameTag(req, tag)) return notModified(res, tag);
  res.setHeader('ETag', tag);
  const [games, deleted, roster, renamed] = await Promise.all([
    // rally_log itself stays out of this payload (GET /api/games?id= has it); a game just says whether it can be replayed.
    sql`SELECT data, rally_log IS NOT NULL AS replay, confirmed_by, confirmed_at, dup_ok FROM games WHERE club = ${code} AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT 2000`,
    sql`SELECT data, deleted_at FROM games WHERE club = ${code} AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC LIMIT 50`,
    sql`SELECT name, claim_hash IS NOT NULL AS claimed, role, CASE WHEN avatar->>'type' = 'photo' THEN jsonb_build_object('type', 'photo', 'v', left(md5(avatar->>'value'), 8)) ELSE avatar END AS avatar, dupr_rating FROM roster WHERE club = ${code} ORDER BY lower(name) LIMIT 300`,
    sql`SELECT old_key, new_name FROM name_changes WHERE club = ${code} AND at > now() - interval '90 days' ORDER BY at DESC LIMIT 100`,
  ]);
  // Confirmation lives beside the game, never inside its data. With the club setting on, games nobody has confirmed are
  // marked `hold` and left out of achievements here and of ratings in the app.
  const required = !!club.require_confirmation;
  const gamesIn = games.map(r => ({ ...r.data, ...(r.confirmed_by ? { confirmed: { by: r.confirmed_by, at: new Date(r.confirmed_at).getTime() } } : {}), ...(r.dup_ok ? { dupOk: true } : {}) }));
  // Stored Dink Rating v2 history (rebuilt first if the games changed); the app falls back to its own replay if this fails.
  const ratings = await refreshRatings(sql, club).then(() => ratingsFor(sql, club)).catch(() => null);
  const gamesOut = gamesIn.map((g, i) => { const o = { ...g }; if (games[i].replay) o.replay = true; if (!counts(g, required)) o.hold = true; return o; });
  send(res, 200, {
    club: publicClub(club),
    games: gamesOut,
    dupes: findDuplicates(gamesIn).slice(0, 100),
    deleted: deleted.map(r => Object.assign({}, r.data, { deletedAt: new Date(r.deleted_at).getTime() })),
    roster: roster.map(r => r.name),
    // Players renamed or merged in the last 90 days: { old name key: new name }, so a phone holding the old name can follow.
    renamed: Object.fromEntries(renamed.map(r => [r.old_key, r.new_name])),
    // Who has claimed a name (never the claim itself), plus pictures and self-reported DUPR numbers.
    players: roster.map(r => ({ name: r.name, claimed: r.claimed, ...(r.role ? { role: r.role } : {}), avatar: r.avatar || null, dupr: duprFrom(r.dupr_rating) })),
    progress: progressFor(gamesIn.filter(g => counts(g, required))),
    ratings
  });
});
