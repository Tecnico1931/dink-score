// POST /api/players — a club's saved players: linking a name to a phone, pictures and self-reported DUPR numbers.
// Body: {code, action, ...}
//   claim    {name, pin?|ownerToken?}                 -> links a player name to this phone, returns {playerToken}
//   avatar   {name, playerToken, avatar}              -> sets your picture: {type: emoji|icon|photo, value} or {type: initials}
//   clear-avatar {pin|ownerToken, name}               -> organizer: put a player back to initials
//   paddles-get {name, playerToken}                  -> your saved paddles: {paddles: {list: [{id, name, photo?}], used: {gameId: paddleId}}}. Only that
//                                                       name's phone; never in the club payload or anyone else's view (see _paddles.js)
//   paddles-set {name, playerToken, paddles}         -> replaces your paddle list and the paddle you used in each game
//   rewards-get|rewards-sync {name, playerToken, tz?} -> your rewards balance and streak from the append-only ledger (rewards-sync first adds what the
//                                                       games you saved earned; see _economy.js). Only that name's phone; only where the club has rewards on
//   rewards-catalog|rewards-buy|rewards-wear|rewards-share {name, playerToken, item?, slot?, shiny?, share?} -> the catalogue (fixed prices, server-side
//                                                       only), buy one item through the ledger, choose which owned item is worn (plus weekly shiny coat
//                                                       for a featured pet), or choose whether other members see your worn look. See _economyshop.js and _economypets.js.
//   rewards-looks {}                                  -> club members (when club.rewards is on): allow-listed worn item ids (plus pet stage and weekly
//                                                       shiny flag) for players who opted in to share their look. Never balance, streak, or purchase history.
//   rewards-box-odds {}                               -> club members (when club.rewards and club.mystery_box are on): server odds table for the mystery box.
//   rewards-box-open {name, playerToken, openId}      -> opens one mystery box on the server (idempotent by openId, daily limit, duplicate refund). See _economybox.js.
//   rewards-pass|rewards-pass-claim {name, playerToken, tier?, seasonId?} -> free season pass track per club season (derived from games saved
//                                                       by this phone, idempotent ledger claims; see _economypass.js). Only while rewards are on.
//   dupr     {name, rating, playerToken|pin|ownerToken} -> sets or clears (empty rating) a self-reported DUPR number: that
//                                                       name's phone or an organizer only. Display only.
//   export   {name, playerToken}                      -> your own data as JSON: your player, your games, the events, leagues and ladders you are in
//   anonymise {name, playerToken | pin|ownerToken}    -> replaces the name everywhere in the club with "Former player XXXXX", removes the saved
//                                                       player (picture, DUPR, phone link). Games stay, so other people's ratings don't change.
//   release  {pin|ownerToken, name}                  -> organizer: free a claimed name (new phone, or a mistake)
//   approval-request|approval-status|approval-decide -> a member asks an organizer to approve linking a name instead of using the PIN (see _approvals.js)
//   rename   {pin|ownerToken, name, newName}         -> organizer: changes a player's name everywhere (games, events, rewards, links)
//   merge    {pin|ownerToken, name, into}            -> organizer: folds the player `name` into `into`; games, links, picture, DUPR follow
// A claim for a new name that looks like a saved one ("Jose" / "José") answers 409 with a `similar` list of those names
// until the caller repeats it with confirmNew: true. Rename does the same for its new name.
import { db, handler, send, readBody, fail, cleanCode, requireClub, cleanName, nameKey, similarNames, requireOrganizer, newOwnerToken, hashToken, tokenMatches, clientIp, MAX_PHOTOS } from './_db.js';
import { cleanDupr, duprFrom } from './_dupr.js';
import { newAnonLabel, renameDeep, likeFor } from './_privacy.js';
import { renamePlayer, renameWrites } from './_rename.js';
import { MEMBER_ACTIONS, memberAction, audit, changeRole } from './_members.js';
import { APPROVAL_ACTIONS, approvalAction } from './_approvals.js';
import { undoKind, undoConflict } from './_undo.js';
import { dropRatings } from './_rating_store.js';
import { cleanPaddles, countPaddlePhotos, paddlePhotoRoom } from './_paddles.js';
import { rewardsFor, loadLedger } from './_economysync.js';
import { shopView, buyItem, wearItem, wornSummaryOf, loadItems, clubLooks, shareOf, setShare } from './_economyshop.js';
import { boxOdds, boxStatus, openBox } from './_economybox.js';
import { passView, claimPassTier } from './_economypass.js';

const didYouMean = (name, similar) => Object.assign(fail(409, `Did you mean ${similar[0]}? Use ${name} only if they are a different person.`), { extra: { similar } });

const MAX_CLAIMS_PER_DAY = 3; // names one network can link to phones per club per day without an organizer

async function requirePlayer(sql, code, name, token) {
  const k = nameKey(name);
  const [row] = await sql`SELECT name, name_key, claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
  if (!row || !row.claim_hash || !tokenMatches(row.claim_hash, token)) throw fail(403, 'This phone isn\'t linked to that player. Pick your name in the club first.');
  return row;
}
// Avatars: only these shapes are stored, so nothing else can reach other people's screens.
export const AVATAR_ICONS = ['paddle', 'ball', 'paddles', 'net', 'court', 'trophy', 'pickle', 'lightning', 'flame', 'target'];
const MAX_PHOTO = 60000; // characters of base64: a 160px JPEG is usually 6-15 KB
function cleanAvatar(a) {
  if (!a || typeof a !== 'object' || a.type === 'initials') return null;
  const value = String(a.value || '');
  if (a.type === 'icon') {
    if (!AVATAR_ICONS.includes(value)) throw fail(400, 'Pick one of the icons.');
    return { type: 'icon', value };
  }
  if (a.type === 'emoji') {
    // One emoji (it may be several code points, like a flag or skin tone), and nothing else.
    const ok = value.length > 0 && value.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)
      && !/[\p{L}\p{N}\s<>&"'`]/u.test(value.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, ''));
    const graphemes = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length : 1;
    if (!ok || graphemes !== 1) throw fail(400, 'Pick a single emoji.');
    return { type: 'emoji', value };
  }
  if (a.type === 'photo') {
    if (!/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) throw fail(400, 'That photo could not be used. Try a different picture.');
    if (value.length > MAX_PHOTO) throw fail(400, 'That photo is too large. Try a different picture.');
    return { type: 'photo', value };
  }
  throw fail(400, 'Unknown avatar type.');
}

// The rename or merge itself (one transaction), shared by the organizer actions and by undoing a rename.
async function applyRename(sql, code, from, into, toName) {
  const merge = !!into;
  const plan = await renamePlayer(sql, code, from, toName, into);
  // Phones that held the old name look it up here to follow the player (see `renamed` in GET /api/club).
  const extra = [sql`INSERT INTO name_changes (club, old_key, new_name) VALUES (${code}, ${from.name_key}, ${toName}) ON CONFLICT (club, old_key) DO UPDATE SET new_name = EXCLUDED.new_name, at = now()`,
    sql`DELETE FROM name_changes WHERE club = ${code} AND old_key = ${plan.toKey} AND old_key <> ${from.name_key}`];
  if (!merge) {
    extra.push(sql`UPDATE roster SET name_key = ${plan.toKey}, name = ${toName} WHERE club = ${code} AND name_key = ${from.name_key}`);
    if (plan.toKey !== from.name_key) extra.push(sql`UPDATE account_identities SET name_key = ${plan.toKey} WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}
      AND NOT EXISTS (SELECT 1 FROM account_identities x WHERE x.club = ${code} AND x.kind = 'player' AND x.name_key = ${plan.toKey})`);
  } else {
    // The kept player takes whatever the other one had that it lacks: the phone link, picture and DUPR details.
    const rewardsPublic = into.claim_hash ? !!into.rewards_public : from.claim_hash ? !!from.rewards_public : !!into.rewards_public;
    extra.push(sql`DELETE FROM roster WHERE club = ${code} AND name_key = ${from.name_key}`);
    extra.push(sql`UPDATE roster SET claim_hash = ${into.claim_hash || from.claim_hash || null},
      role = ${into.role || from.role || null},
      avatar = ${JSON.stringify(into.avatar || from.avatar || null)}::jsonb,
      paddles = ${JSON.stringify(into.paddles || from.paddles || null)}::jsonb,
      rewards_public = ${rewardsPublic},
      dupr_rating = ${into.dupr_rating ?? from.dupr_rating ?? null}, dupr_set_at = ${into.dupr_rating != null ? into.dupr_set_at : from.dupr_set_at ?? null}
      WHERE club = ${code} AND name_key = ${into.name_key}`);
    if ('dupr_id' in from && from.dupr_id) extra.push(sql`UPDATE roster SET dupr_id = ${from.dupr_id}, dupr_linked_at = ${from.dupr_linked_at}, dupr_snapshot = ${JSON.stringify(from.dupr_snapshot ?? null)}::jsonb WHERE club = ${code} AND name_key = ${into.name_key}`);
    if (from.claim_hash && !into.claim_hash) {
      extra.push(sql`INSERT INTO account_identities (account_id, club, kind, name_key, proof) SELECT account_id, club, kind, ${into.name_key}, proof FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}
        ON CONFLICT (club, kind, name_key) DO UPDATE SET account_id = EXCLUDED.account_id, proof = EXCLUDED.proof`);
    }
    extra.push(sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${from.name_key}`);
  }
  try { await sql.transaction(renameWrites(sql, code, plan, extra)); }
  catch (e) { if (e && e.code === '23505') throw fail(409, 'Someone changed this player at the same time. Try again.'); throw e; }
  return plan;
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  const sql = db();
  const body = await readBody(req);
  const club = await requireClub(cleanCode(body.code), req);
  const code = club.code; // the club's permanent key, even when an old club code was used

  if (MEMBER_ACTIONS.includes(body.action)) return send(res, 200, await memberAction(sql, club, body, req));
  if (APPROVAL_ACTIONS.includes(body.action)) return send(res, 200, await approvalAction(sql, club, body, req));

  if (body.action === 'claim') {
    const name = cleanName(body.name);
    if (!name || /^Player \d+$/.test(name)) throw fail(400, 'Enter your name.');
    const k = nameKey(name);
    const saved = await sql`SELECT name, name_key, claim_hash, blocked_at FROM roster WHERE club = ${code}`;
    const existing = saved.find(r => r.name_key === k);
    if (existing && existing.blocked_at) throw fail(403, `${name} was removed from this club by an organizer. Ask an organizer to unblock it.`);
    if (!existing && saved.length >= 300) throw fail(400, 'This club already has 300 saved players.');
    if (!existing && body.confirmNew !== true) {
      const similar = similarNames(name, saved.map(r => r.name));
      if (similar.length) throw didYouMean(name, similar);
    }
    if (existing && existing.claim_hash) throw fail(409, `${name} is already linked to another phone. Ask an organizer to release it.`);
    // A network that has already linked 3 names to phones today needs an organizer to confirm the next one, so one
    // person can't set up a crowd of names to vouch for made-up games.
    const claimKey = 'claim:' + code + ':' + clientIp(req);
    const [{ recent }] = await sql`SELECT count(*)::int AS recent FROM lookup_fails WHERE ip = ${claimKey} AND at > now() - interval '1 day'`;
    const reason = recent >= MAX_CLAIMS_PER_DAY ? `This network has already linked ${MAX_CLAIMS_PER_DAY} names today, so an organizer needs to confirm this one.` : null;
    if (reason) {
      if (!body.pin && !body.ownerToken) throw fail(403, reason + ' Ask them to enter the organizer PIN on this phone.');
      await requireOrganizer(club, body.pin, req, body.ownerToken);
    }
    const token = newOwnerToken();
    await sql`INSERT INTO roster (club, name_key, name) VALUES (${code}, ${k}, ${name}) ON CONFLICT DO NOTHING`;
    // Atomic: only one phone can claim a name, even if two try at once.
    const rows = await sql`UPDATE roster SET claim_hash = ${hashToken(token)}, role = NULL WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NULL AND blocked_at IS NULL RETURNING name`;
    if (!rows.length) throw fail(409, `${name} was just claimed by another phone.`);
    await sql`INSERT INTO lookup_fails (ip) VALUES (${claimKey})`;
    return send(res, 200, { ok: true, name: rows[0].name, playerToken: token });
  }

  if (body.action === 'avatar') {
    // A player sets their own picture: an emoji, one of the app's pickleball icons, a small photo, or back to initials.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const avatar = cleanAvatar(body.avatar);
    if (avatar && avatar.type === 'photo') {
      // A club keeps at most MAX_PHOTOS photos; replacing your own photo is always fine.
      const [{ photos, mine }] = await sql`SELECT count(*)::int AS photos, count(*) FILTER (WHERE name_key = ${player.name_key})::int AS mine FROM roster WHERE club = ${code} AND avatar->>'type' = 'photo'`;
      if (!Number(mine) && Number(photos) >= MAX_PHOTOS) throw fail(409, `This club already has ${MAX_PHOTOS} photo pictures. Pick an emoji or icon instead, or ask an organizer to remove an old photo.`);
    }
    await sql`UPDATE roster SET avatar = ${avatar ? JSON.stringify(avatar) : null}::jsonb WHERE club = ${code} AND name_key = ${player.name_key}`;
    return send(res, 200, { ok: true, avatar });
  }

  if (body.action === 'rewards-looks') {
    // Allow-listed worn item ids for members who opted in; off means 403 and no reward data at all.
    if (!club.rewards) throw fail(403, 'Rewards are off for this club.');
    return send(res, 200, { looks: await clubLooks(sql, code) });
  }

  if (body.action === 'rewards-get' || body.action === 'rewards-sync') {
    // Off means no reward calls at all for that club. The balance is the server's ledger; a phone can only ask for it, never set it.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    if (!club.rewards) throw fail(403, 'Rewards are off for this club.');
    const [rw, { worn, pet }, share] = await Promise.all([
      rewardsFor(sql, code, player.name, { tz: body.tz, sync: body.action === 'rewards-sync' }),
      wornSummaryOf(sql, code, player.name_key),
      shareOf(sql, code, player.name_key)
    ]);
    return send(res, 200, { ...rw, worn, pet, share });
  }

  if (body.action === 'rewards-box-odds') {
    if (!club.rewards || !club.mystery_box) throw fail(403, 'Mystery box is off for this club.');
    return send(res, 200, boxOdds());
  }

  if (body.action === 'rewards-box-open') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    if (!club.rewards || !club.mystery_box) throw fail(403, 'Mystery box is off for this club.');
    try { return send(res, 200, await openBox(sql, code, player.name_key, body.openId)); }
    catch (e) { throw e.status ? fail(e.status, e.message) : e; }
  }

  if (body.action === 'rewards-catalog' || body.action === 'rewards-buy' || body.action === 'rewards-wear' || body.action === 'rewards-share') {
    // Fixed prices live in _economyshop.js only; the phone names an item and the server charges the catalogue price. Same gate as the balance.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    if (!club.rewards) throw fail(403, 'Rewards are off for this club.');
    try {
      const out = body.action === 'rewards-catalog' ? await shopView(sql, code, player.name_key)
        : body.action === 'rewards-buy' ? await buyItem(sql, code, player.name_key, String(body.item || ''))
        : body.action === 'rewards-share' ? await setShare(sql, code, player.name_key, body.share)
        : await wearItem(sql, code, player.name_key, String(body.slot || ''), String(body.item || ''), { shiny: body.shiny });
      if (club.mystery_box) out.box = await boxStatus(sql, code, player.name_key);
      return send(res, 200, out);
    } catch (e) { throw e.status ? fail(e.status, e.message) : e; }
  }

  if (body.action === 'rewards-pass' || body.action === 'rewards-pass-claim') {
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    if (!club.rewards) throw fail(403, 'Rewards are off for this club.');
    try {
      if (body.action === 'rewards-pass') return send(res, 200, await passView(sql, code, player.name_key));
      return send(res, 200, await claimPassTier(sql, code, player.name_key, body.tier, { seasonId: body.seasonId }));
    } catch (e) { throw e.status ? fail(e.status, e.message) : e; }
  }

  if (body.action === 'paddles-get' || body.action === 'paddles-set') {
    // Your paddles are yours alone: only the phone linked to this name reads or writes them, an organizer cannot.
    const player = await requirePlayer(sql, code, body.name, body.playerToken);
    const [{ paddles: mine }] = await sql`SELECT paddles FROM roster WHERE club = ${code} AND name_key = ${player.name_key}`;
    if (body.action === 'paddles-get') return send(res, 200, { paddles: mine || { list: [], used: {} } });
    let doc;
    try { doc = cleanPaddles(body.paddles); } catch (e) { throw fail(e.status || 400, e.message); }
    if (countPaddlePhotos(doc) > countPaddlePhotos(mine)) {
      // Same club cap as photo avatars: 50 photos a club, counting the other players' paddle photos.
      const others = await sql`SELECT paddles FROM roster WHERE club = ${code} AND name_key <> ${player.name_key} AND paddles IS NOT NULL`;
      const n = others.reduce((sum, r) => sum + countPaddlePhotos(r.paddles), 0);
      if (!paddlePhotoRoom(n, mine, doc)) throw fail(409, 'This club already has the most paddle photos it can hold. Save the paddle without a photo, or ask an organizer to make room.');
    }
    await sql`UPDATE roster SET paddles = ${JSON.stringify(doc)}::jsonb WHERE club = ${code} AND name_key = ${player.name_key}`;
    return send(res, 200, { ok: true, paddles: doc });
  }

  if (body.action === 'dupr') {
    // The phone that linked this name, or an organizer (the only way to set one on a guest name). Nobody else.
    const k = nameKey(body.name);
    const [row] = await sql`SELECT claim_hash FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (!row) throw fail(404, 'No saved player has that name.');
    const own = !!row.claim_hash && tokenMatches(row.claim_hash, body.playerToken);
    if (!own) await requireOrganizer(club, body.pin, req, body.ownerToken);
    let rating;
    try { rating = cleanDupr(body.rating); } catch (e) { throw fail(400, e.message); }
    await sql`UPDATE roster SET dupr_rating = ${rating}, dupr_set_at = ${rating === null ? null : new Date().toISOString()} WHERE club = ${code} AND name_key = ${k}`;
    return send(res, 200, { ok: true, dupr: rating });
  }

  if (body.action === 'export' || body.action === 'anonymise') {
    // Your own data: the phone that linked this name. An organizer may also anonymise a name (a guest who never linked one, or
    // someone who asked in person); only the person themselves can export, because an organizer already has the club export.
    const k = nameKey(body.name);
    if (!k) throw fail(400, 'Enter the name.');
    const [found] = await sql`SELECT to_jsonb(r) AS j FROM roster r WHERE club = ${code} AND name_key = ${k}`;
    const row = found && found.j;
    const own = !!(row && row.claim_hash && tokenMatches(row.claim_hash, body.playerToken));
    if (body.action === 'export' && !own) throw fail(403, 'This phone isn\'t linked to that player. Pick your name in the club first.');
    if (!own) await requireOrganizer(club, body.pin, req, body.ownerToken);
    const like = likeFor(k);
    const [games, events, leagues, myReactions, nightRsvps] = await Promise.all([
      sql`SELECT id, data, deleted_at, rally_log FROM games WHERE club = ${code} AND lower(data::text) LIKE ${like}`,
      sql`SELECT id, data, refs FROM events WHERE club = ${code} AND lower(data::text) LIKE ${like}`,
      sql`SELECT id, data FROM leagues WHERE club = ${code} AND lower(data::text) LIKE ${like}`,
      sql`SELECT game_id, reaction, created_at FROM game_reactions WHERE club = ${code} AND name_key = ${k} ORDER BY created_at ASC, game_id ASC`,
      sql`SELECT n.id, n.title, n.starts_at, n.location, n.status AS night_status, r.status, r.updated_at
        FROM game_night_rsvps r JOIN game_nights n ON n.club = r.club AND n.id = r.night_id
        WHERE r.club = ${code} AND r.name_key = ${k} ORDER BY n.starts_at DESC`
    ]);
    const mine = games.filter(r => ((r.data && r.data.teams) || []).flat().some(n => nameKey(n) === k));
    if (body.action === 'export') {
      const ledger = await loadLedger(sql, code, k);
      return send(res, 200, {
        format: 'dink-score-player-export', version: 1, exportedAt: new Date().toISOString(), club: { name: club.name },
        player: row ? { name: row.name, linkedToPhone: true, avatar: row.avatar || null, paddles: row.paddles || null, rewardsPublic: !!row.rewards_public, duprSelfReported: duprFrom(row.dupr_rating),
          duprLink: row.dupr_id ? { duprId: row.dupr_id, linkedAt: row.dupr_linked_at, ratings: row.dupr_snapshot || null } : null } : { name: cleanName(body.name) },
        games: mine.map(r => ({ ...r.data, deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, ...(r.rally_log ? { rallyLog: r.rally_log } : {}) })),
        reactions: myReactions.map(r => ({ gameId: r.game_id, reaction: r.reaction, at: new Date(r.created_at).toISOString() })),
        events: events.filter(r => JSON.stringify(r.data) !== JSON.stringify(renameDeep(r.data, k, 'x'))).map(r => ({ id: r.id, name: r.data.name, format: r.data.format, status: r.data.status })),
        leagues: leagues.filter(r => JSON.stringify(r.data) !== JSON.stringify(renameDeep(r.data, k, 'x'))).map(r => ({ id: r.id, name: r.data.name, kind: r.data.kind, season: r.data.season, status: r.data.status })),
        rewardsItems: (await loadItems(sql, code, k)).map(i => ({ item: i.id, slot: i.slot, worn: i.worn, ...(i.slot === 'pet' ? { shiny: i.shiny, adoptedAt: new Date(i.at).toISOString() } : {}) })),
        rewardsLedger: ledger.map(e => ({ id: e.id, kind: e.kind, amount: e.amount, reason: e.reason, day: e.day, streak: e.streak, at: new Date(e.at).toISOString() })),
        gameNights: nightRsvps.map(r => ({ id: r.id, title: r.title, startsAt: Number(r.starts_at), location: r.location || '', nightStatus: r.night_status, rsvp: r.status, updatedAt: new Date(r.updated_at).toISOString() }))
      });
    }
    // Anonymise: one random label everywhere the name appears, so that person's games stay linked to each other and to the
    // people they played with, and everyone else's ratings come out the same. Then the saved player (picture, DUPR number or
    // link, phone link) and any account link to it are removed. All in one transaction.
    const taken = new Set((await sql`SELECT lower(name) AS n FROM roster WHERE club = ${code}`).map(r => r.n));
    let label = newAnonLabel();
    while (taken.has(label.toLowerCase())) label = newAnonLabel();
    const [live, dupr] = await Promise.all([
      sql`SELECT id, state, stack FROM live_games WHERE club = ${code} AND lower(state::text || stack::text) LIKE ${like}`,
      sql`SELECT to_regclass('dupr_matches') IS NOT NULL AS has`
    ]);
    const json = v => JSON.stringify(v);
    const ops = [];
    let touched = 0;
    for (const r of games) { const d = renameDeep(r.data, k, label); if (json(d) !== json(r.data)) { touched++; ops.push(sql`UPDATE games SET data = ${json(d)}::jsonb WHERE club = ${code} AND id = ${r.id}`); } }
    for (const r of events) {
      const d = renameDeep(r.data, k, label), refs = r.refs && Object.fromEntries(Object.entries(r.refs).filter(([n]) => nameKey(n) !== k));
      if (json(d) !== json(r.data) || json(refs) !== json(r.refs)) { touched++; ops.push(sql`UPDATE events SET data = ${json(d)}::jsonb, refs = ${refs ? json(refs) : null}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND id = ${r.id}`); }
    }
    for (const r of leagues) { const d = renameDeep(r.data, k, label); if (json(d) !== json(r.data)) { touched++; ops.push(sql`UPDATE leagues SET data = ${json(d)}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code} AND id = ${r.id}`); } }
    for (const r of await sql`SELECT data FROM court_boards WHERE club = ${code} AND lower(data::text) LIKE ${like}`) ops.push(sql`UPDATE court_boards SET data = ${json({ ...renameDeep(r.data, k, label), config: r.data.config })}::jsonb, version = version + 1, updated_at = now() WHERE club = ${code}`);
    for (const r of live) ops.push(sql`UPDATE live_games SET state = ${json(renameDeep(r.state, k, label))}::jsonb, stack = ${json(renameDeep(r.stack, k, label))}::jsonb WHERE club = ${code} AND id = ${r.id}`);
    if (dupr[0].has && row && row.dupr_id) ops.push(sql`UPDATE dupr_matches SET payload = NULL WHERE club = ${code} AND payload IS NOT NULL AND payload::text LIKE ${'%' + String(row.dupr_id).replace(/[\\%_]/g, '\\$&') + '%'}`);
    // The history tables keep names too (game audit, club audit, "renamed" pointers), so they get the same label.
    const [gaud, caud, chg] = await Promise.all([
      sql`SELECT id, actor, before, after, note FROM game_audit WHERE club = ${code} AND (lower(coalesce(before::text, '') || coalesce(after::text, '') || coalesce(note, '')) LIKE ${like} OR actor LIKE '%:' || ${k})`,
      sql`SELECT id, actor, actor_name, target, detail FROM club_audit WHERE club = ${code} AND (lower(coalesce(actor_name, '') || coalesce(target, '') || coalesce(detail::text, '')) LIKE ${like} OR actor LIKE '%:' || ${k})`,
      sql`SELECT old_key, new_name FROM name_changes WHERE club = ${code}`
    ]);
    const lk = nameKey(label);
    const actorTo = a => (a && a.endsWith(':' + k) ? a.slice(0, -k.length) + lk : a);
    const noteTo = n => (n && nameKey(n) === k ? label : n);
    for (const r of gaud) {
      const b = renameDeep(r.before, k, label), a = renameDeep(r.after, k, label);
      ops.push(sql`UPDATE game_audit SET actor = ${actorTo(r.actor)}, before = ${r.before ? json(b) : null}::jsonb, after = ${r.after ? json(a) : null}::jsonb, note = ${noteTo(r.note)} WHERE id = ${r.id}`);
    }
    for (const r of caud) {
      ops.push(sql`UPDATE club_audit SET actor = ${actorTo(r.actor)}, actor_name = ${noteTo(r.actor_name)}, target = ${noteTo(r.target)}, detail = ${r.detail ? json(renameDeep(r.detail, k, label)) : null}::jsonb WHERE id = ${r.id}`);
    }
    ops.push(sql`DELETE FROM name_changes WHERE club = ${code} AND old_key = ${k}`, ...dropRatings(sql, code));
    for (const r of chg) if (nameKey(r.new_name) === k) ops.push(sql`UPDATE name_changes SET new_name = ${label} WHERE club = ${code} AND old_key = ${r.old_key}`);
    if (myReactions.length) {
      touched += myReactions.length;
      ops.push(sql`UPDATE game_reactions SET name_key = ${lk}, name = ${label} WHERE club = ${code} AND name_key = ${k}`);
    }
    if (nightRsvps.length) {
      touched += nightRsvps.length;
      const nightIds = nightRsvps.map(r => r.id);
      ops.push(sql`DELETE FROM game_night_rsvps WHERE club = ${code} AND name_key = ${k}`);
      ops.push(sql`UPDATE game_nights SET updated_at = now() WHERE club = ${code} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(nightIds)}::jsonb))`);
    }
    // Data-rights handling for any legacy rows still in `purchases` until the table is manually dropped.
    ops.push(sql`DELETE FROM purchases WHERE club = ${code} AND name_key = ${k}`);
    ops.push(sql`DELETE FROM reward_ledger WHERE club = ${code} AND name_key = ${k}`);
    ops.push(sql`DELETE FROM reward_items WHERE club = ${code} AND name_key = ${k}`);
    ops.push(sql`DELETE FROM push_subs WHERE club = ${code} AND name_key = ${k}`);
    ops.push(sql`UPDATE organizer_devices SET name_key = NULL WHERE club = ${code} AND name_key = ${k}`); // the unlocked phone stays unlocked, just unnamed
    ops.push(sql`DELETE FROM approval_requests WHERE club = ${code} AND name_key = ${k}`);
    if (!row && !touched) throw fail(404, 'No player has that name in this club.');
    ops.push(sql`DELETE FROM account_identities WHERE club = ${code} AND kind = 'player' AND name_key = ${k}`);
    ops.push(sql`DELETE FROM roster WHERE club = ${code} AND name_key = ${k}`);
    await sql.transaction(ops);
    return send(res, 200, { ok: true, label, games: mine.length });
  }

  // Everything below is for organizers.
  const actor = await requireOrganizer(club, body.pin, req, body.ownerToken);

  if (body.action === 'clear-avatar') {
    // Organizer: put someone back to initials (for example a photo that shouldn't be there).
    const rows = await sql`UPDATE roster SET avatar = NULL WHERE club = ${code} AND name_key = ${nameKey(body.name)} RETURNING name`;
    if (!rows.length) throw fail(404, 'No saved player has that name.');
    return send(res, 200, { ok: true });
  }

  if (body.action === 'release') {
    const k = nameKey(body.name);
    // A released name also loses any role, so whoever claims it next starts as an ordinary member.
    const [was] = await sql`SELECT role FROM roster WHERE club = ${code} AND name_key = ${k}`;
    if (was && was.role === 'organizer' && actor.by === 'organizer') throw fail(403, 'Only the phone that created the club, or the organizer PIN, can release an organizer.');
    const rows = await sql`UPDATE roster SET claim_hash = NULL, role = NULL, dupr_rating = NULL, dupr_set_at = NULL WHERE club = ${code} AND name_key = ${k} AND claim_hash IS NOT NULL RETURNING name`;
    if (!rows.length) throw fail(404, 'That name isn\'t linked to a phone.');
    await audit(sql, code, actor, 'release', rows[0].name, was && was.role ? { hadRole: was.role } : null);
    return send(res, 200, { ok: true });
  }

  if (body.action === 'undo') {
    // Reverse a logged role change or rename (see _undo.js). The state is checked again, so a later change is never trampled.
    const [e] = await sql`SELECT id, at, action, target, detail, undone_at FROM club_audit WHERE club = ${code} AND id = ${Number.isSafeInteger(body.id) ? body.id : 0}`;
    if (!e) throw fail(404, 'That change is not in the history.');
    const kind = undoKind(e, Date.now());
    if (!kind) throw fail(409, e.undone_at ? 'That change was already undone.' : 'That change can no longer be undone.');
    if (kind === 'role' && actor.by === 'organizer') throw fail(403, 'Only the phone that created the club, or the organizer PIN, can change roles.');
    const [row] = await sql`SELECT * FROM roster WHERE club = ${code} AND name_key = ${nameKey(e.target)}`;
    const [other] = kind === 'rename' ? await sql`SELECT name, name_key FROM roster WHERE club = ${code} AND name_key = ${nameKey(e.detail.from)}` : [];
    const conflict = undoConflict(e, kind, row, other);
    if (conflict) throw fail(409, conflict);
    if (kind === 'role') await changeRole(sql, code, actor, row, e.detail.from === 'organizer' ? 'organizer' : null);
    else await applyRename(sql, code, row, null, e.detail.from);
    await sql`UPDATE club_audit SET undone_at = now() WHERE club = ${code} AND id = ${e.id} AND undone_at IS NULL`;
    await audit(sql, code, actor, 'undo', kind === 'rename' ? e.detail.from : e.target, { undid: e.action, id: e.id, ...(kind === 'rename' ? { from: e.target, to: e.detail.from } : {}) });
    return send(res, 200, { ok: true });
  }

  if (body.action === 'rename' || body.action === 'merge') {
    const merge = body.action === 'merge';
    const [from] = await sql`SELECT * FROM roster WHERE club = ${code} AND name_key = ${nameKey(body.name)}`;
    if (!from) throw fail(404, 'No saved player has that name.');
    let into = null, toName;
    if (merge) {
      [into] = await sql`SELECT * FROM roster WHERE club = ${code} AND name_key = ${nameKey(body.into)}`;
      if (!into) throw fail(404, 'No saved player has that name to merge into.');
      if (into.name_key === from.name_key) throw fail(400, 'Pick two different players to merge.');
      toName = into.name;
    } else {
      toName = cleanName(body.newName);
      if (!toName || /^Player \d+$/.test(toName)) throw fail(400, 'Enter the new name.');
      if (nameKey(toName) !== from.name_key) {
        const others = await sql`SELECT name, name_key FROM roster WHERE club = ${code} AND name_key <> ${from.name_key}`;
        const clash = others.find(r => r.name_key === nameKey(toName));
        if (clash) throw Object.assign(fail(409, `${clash.name} is already a saved player. Merge the two players instead.`), { extra: { mergeInto: clash.name } });
        const similar = similarNames(toName, others.map(r => r.name));
        if (similar.length && body.confirmNew !== true) throw didYouMean(toName, similar);
      }
    }
    if (merge) {
      if (from.claim_hash && into.claim_hash) throw fail(409, `${from.name} and ${into.name} are both linked to phones. Release one of them first, then merge.`);
      if (from.dupr_id && into.dupr_id) throw fail(409, `${from.name} and ${into.name} are both connected to DUPR. Disconnect one of them first, then merge.`);
    }
    const plan = await applyRename(sql, code, from, into, toName);
    await audit(sql, code, actor, merge ? 'merge' : 'rename', toName, { from: from.name, [merge ? 'into' : 'to']: toName });
    return send(res, 200, { ok: true, name: toName, games: plan.games.length, events: plan.events.length, leagues: plan.leagues.length });
  }

  throw fail(400, 'Unknown action.');
});
