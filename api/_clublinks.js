// Linking friendly clubs into one leaderboard (L15), reached through /api/club (no new function). Not a route (files starting with "_").
// Two clubs link only when an organizer of each agrees: one makes an invite code, an organizer of the other reads who it is from and accepts.
// Either side can leave at any time; the row is deleted and the other club sees nothing of it from then on.
//   POST /api/club {code, action: 'link-invite', pin|ownerToken}   -> organizer: {id, invite, expiresAt}, good for 7 days (a code is shown to its maker only)
//   POST /api/club {code, action: 'link-preview', invite, ...}     -> organizer of the club that was handed the code: {clubName}, nothing else
//   POST /api/club {code, action: 'link-accept', invite, ...}      -> that organizer: the link is live for both clubs
//   POST /api/club {code, action: 'link-leave', id, ...}           -> an organizer of either club: cancels an invite or ends a link at once
//   GET  /api/club?code=...&links=1                                -> members: {links: [{id, club, since}]}; organizers also get {pending: [{id, invite, expiresAt}]}
//   GET  /api/club?code=...&links=1&link=<id>&mode=doubles|singles -> members of either club: the combined standing (linkStandingView)
// What crosses between the clubs is the club's name and, per player, name, Dink Rating and games played (never avatars, ids, DUPR,
// codes, PINs or games). It leaves only through linkStandingView below, which copies field by field. It is never public: a viewer
// must belong to one of the two clubs. Players removed from a club (blocked) and anonymised players are left out.
import { randomInt } from 'node:crypto';
import { fail, requireOrganizer, clientIp, purgeMarks } from './_db.js';
import { nameKey } from './_names.js';
import { refreshRatings, ratingsFor } from './_rating_store.js';
import { replyTagged } from './_sync.js';
import { audit } from './_members.js';

export const LINK_ACTIONS = ['link-invite', 'link-preview', 'link-accept', 'link-leave'];
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_LINKS = 5; // per club, counting invites not yet accepted
const MAX_TRIES = 20; // invite look-ups per network per 10 minutes
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0 or 1

export const newInviteCode = (rnd = randomInt) => Array.from({ length: 8 }, () => ALPHABET[rnd(ALPHABET.length)]).join('');
export const cleanInvite = v => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
export const isInvite = v => /^[A-HJKMNP-Z2-9]{8}$/.test(v);
const newLinkId = () => 'k' + newInviteCode().toLowerCase();

const str = (v, n = 60) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : d);

// The combined standing, ranked: players with enough games by rating, then the rest (no rank yet). `rows` are
// [{name, club: 0|1, rating, games, provisional}] and `clubs` the two names, the viewer's own first.
// Copied field by field, so a field added to a rating row later stays private until it is listed here.
export function linkStandingView(mode, clubs, rows) {
  const sorted = rows.slice().sort((a, b) => (a.provisional ? 1 : 0) - (b.provisional ? 1 : 0) || b.rating - a.rating || b.games - a.games || String(a.name).localeCompare(String(b.name)));
  let rank = 0;
  return {
    v: 1,
    mode: mode === 'singles' ? 'singles' : 'doubles',
    clubs: clubs.slice(0, 2).map(c => str(c)),
    rows: sorted.slice(0, 200).map(r => ({ rank: r.provisional ? null : ++rank, name: str(r.name), club: r.club === 1 ? 1 : 0, rating: num(r.rating), games: Math.max(0, Math.trunc(Number(r.games)) || 0), provisional: !!r.provisional }))
  };
}

// Rate limit on invite look-ups: the code is the only credential, so guessing is slowed per network like club codes are.
async function throttle(sql, req) {
  await purgeMarks(sql);
  const key = 'lnk:' + clientIp(req);
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '10 minutes'`;
  if (Number(n) > MAX_TRIES) { await sql`DELETE FROM lookup_fails WHERE id = ${id}`; throw fail(429, 'Too many tries. Wait a few minutes and try again.'); }
}

const countFor = async (sql, code) => (await sql`SELECT count(*)::int AS n FROM club_links WHERE club_a = ${code} OR club_b = ${code}`)[0].n;
const gone = () => fail(404, "That invite code isn't valid or has expired.");

async function isOrganizer(club, body, req) {
  try { await requireOrganizer(club, body.pin, req, body.ownerToken); return true; } catch (e) { if (e.status === 429) throw e; return false; }
}

// Returns { body, status? }, or throws.
export async function linkAction(sql, club, body, req, now = Date.now()) {
  const code = club.code; // the permanent key
  const [{ quick }] = await sql`SELECT quick FROM clubs WHERE code = ${code}`; // not on the club row requireClub loads
  if (quick) throw fail(400, 'A quick game room cannot be linked to a club.');
  const who = await requireOrganizer(club, body.pin, req, body.ownerToken);
  const action = body.action;

  if (action === 'link-invite') {
    if ((await countFor(sql, code)) >= MAX_LINKS) throw fail(400, `A club can link with up to ${MAX_LINKS} others. Unlink one first.`);
    for (let i = 0; i < 5; i++) {
      const invite = newInviteCode(), id = newLinkId();
      const rows = await sql`INSERT INTO club_links (id, club_a, invite, invite_expires) VALUES (${id}, ${code}, ${invite}, ${new Date(now + INVITE_TTL_MS).toISOString()}) ON CONFLICT DO NOTHING RETURNING id`;
      if (rows.length) return { status: 201, body: { id, invite, expiresAt: now + INVITE_TTL_MS } };
    }
    throw fail(500, 'Could not make an invite code.');
  }

  if (action === 'link-leave') {
    const rows = await sql`DELETE FROM club_links WHERE id = ${String(body.id || '')} AND (club_a = ${code} OR club_b = ${code}) RETURNING club_a, club_b`;
    if (!rows.length) throw fail(404, 'That link is already gone.');
    await audit(sql, code, who, 'link-leave', null, { pending: !rows[0].club_b });
    return { body: { ok: true } };
  }

  // preview and accept: the invite code is looked up the same way, and a bad one never says why it is bad
  await throttle(sql, req);
  const invite = cleanInvite(body.invite);
  if (!isInvite(invite)) throw gone();
  const [row] = await sql`SELECT l.id, l.club_a, c.name FROM club_links l JOIN clubs c ON c.code = l.club_a
    WHERE l.invite = ${invite} AND l.club_b IS NULL AND l.invite_expires > now() AND c.delete_at IS NULL AND NOT c.quick`;
  if (!row) throw gone();
  if (row.club_a === code) throw fail(400, 'That is your own club\'s invite. Give it to the other club\'s organizer.');
  if (action === 'link-preview') return { body: { clubName: str(row.name, 60) } };

  if ((await countFor(sql, code)) >= MAX_LINKS) throw fail(400, `A club can link with up to ${MAX_LINKS} others. Unlink one first.`);
  let done;
  try {
    done = await sql`UPDATE club_links SET club_b = ${code}, invite = NULL, invite_expires = NULL, accepted_at = now()
      WHERE id = ${row.id} AND club_b IS NULL AND invite = ${invite} AND invite_expires > now() RETURNING id`;
  } catch (e) {
    if (e && e.code === '23505') throw fail(409, 'Your clubs are already linked.');
    throw e;
  }
  if (!done.length) throw gone();
  await audit(sql, code, who, 'link-accept', str(row.name, 60), null);
  await audit(sql, row.club_a, { by: 'link' }, 'link-accepted', club.name, null);
  return { status: 200, body: { ok: true, id: row.id, club: str(row.name, 60) } };
}

// Members' view. Pending invites (with their codes) only for an organizer.
export async function linksGet(sql, club, req, res, params) {
  const code = club.code;
  const id = params.get('link');
  if (id) {
    const [l] = await sql`SELECT l.club_a, l.club_b, l.accepted_at FROM club_links l WHERE l.id = ${id} AND l.club_b IS NOT NULL AND (l.club_a = ${code} OR l.club_b = ${code})`;
    if (!l) throw fail(404, 'That link is no longer active.');
    const other = l.club_a === code ? l.club_b : l.club_a;
    const [partner] = await sql`SELECT code, name, require_confirmation FROM clubs WHERE code = ${other} AND delete_at IS NULL AND NOT quick`;
    if (!partner) throw fail(404, 'That link is no longer active.');
    const mode = params.get('mode') === 'singles' ? 'singles' : 'doubles';
    const rows = [];
    for (const [i, c] of [club, partner].entries()) {
      await refreshRatings(sql, c);
      const [r, blocked] = await Promise.all([ratingsFor(sql, c), sql`SELECT name_key FROM roster WHERE club = ${c.code} AND blocked_at IS NOT NULL`]);
      const off = new Set(blocked.map(b => b.name_key));
      for (const p of Object.values(r.players[mode])) if (!off.has(nameKey(p.name))) rows.push({ name: p.name, club: i, rating: p.rating, games: p.games, provisional: p.provisional });
    }
    return replyTagged(req, res, code + ':link:' + id + ':' + mode, linkStandingView(mode, [club.name, partner.name], rows));
  }
  const mine = await sql`SELECT l.id, l.club_a, l.club_b, l.invite, l.invite_expires, l.accepted_at, a.name AS a_name, b.name AS b_name, a.delete_at AS a_del, b.delete_at AS b_del
    FROM club_links l JOIN clubs a ON a.code = l.club_a LEFT JOIN clubs b ON b.code = l.club_b WHERE l.club_a = ${code} OR l.club_b = ${code} ORDER BY l.created_at`;
  const links = mine.filter(l => l.club_b && !l.a_del && !l.b_del).map(l => ({ id: l.id, club: str(l.club_a === code ? l.b_name : l.a_name), since: new Date(l.accepted_at).getTime() }));
  const body = { links };
  const hdr = n => (req.headers || {})[n];
  // Only a caller that sent credentials is checked: a member's plain read must not count as a wrong PIN.
  if ((hdr('x-club-pin') || hdr('x-club-owner')) && await isOrganizer(club, { pin: hdr('x-club-pin'), ownerToken: hdr('x-club-owner') }, req)) {
    body.pending = mine.filter(l => !l.club_b && l.club_a === code && new Date(l.invite_expires).getTime() > Date.now()).map(l => ({ id: l.id, invite: l.invite, expiresAt: new Date(l.invite_expires).getTime() }));
  }
  return replyTagged(req, res, code + ':links', body);
}
