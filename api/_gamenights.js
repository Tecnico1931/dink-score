// Game nights with In / Maybe / Out RSVPs and push reminders (L11).
// Reached through /api/club (GET ?nights=1, POST action: 'night-*'; the function count is at its limit).
// Pure helpers live at the top so `npm test` covers them without a database.
import { randomBytes } from 'node:crypto';
import { cleanName, nameKey } from './_names.js';
import { cleanZone } from './_analytics.js';
import { notify, vapidFromEnv } from './_push.js';

export const NIGHT_ACTIONS = ['night-create', 'night-edit', 'night-cancel', 'night-delete', 'night-rsvp', 'night-remind'];
export const MAX_NIGHTS = 50;
export const MAX_TITLE = 60;
export const MAX_LOCATION = 80;
export const MAX_NOTE = 300;
export const MIN_CAP = 2;
export const MAX_CAP = 128;
export const UPCOMING_GRACE_MS = 4 * 60 * 60 * 1000;
export const PAST_WINDOW_MS = 7 * 864e5;
export const REMIND_COOLDOWN_MS = 30 * 60 * 1000;
export const MAX_REMINDERS_PER_NIGHT = 5;
export const MAX_CLUB_REMINDERS_PER_HOUR = 6;

const fail = (status, message) => Object.assign(new Error(message), { status });
const CTRL_SINGLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;
const CTRL_MULTI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;
const short = (s, n) => String(s || '').slice(0, n);

export function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\s/g, ' ').replace(CTRL_SINGLE, '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, max);
}

export function cleanNightNote(v) {
  const s = String(v == null ? '' : v).normalize('NFC').replace(/\r\n?/g, '\n').replace(CTRL_MULTI, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (s.length > MAX_NOTE) throw fail(400, `The note is too long (at most ${MAX_NOTE} characters).`);
  return s;
}

export function cleanNightInput(raw, { now = Date.now(), edit = false } = {}) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const title = cleanText(b.title, MAX_TITLE);
  if (!title) throw fail(400, 'Give this game night a title.');
  const startsAt = Math.trunc(Number(b.startsAt));
  if (!Number.isFinite(startsAt)) throw fail(400, 'Pick a valid date and time.');
  const earliest = edit ? now - 12 * 3600_000 : now - 5 * 60_000;
  if (startsAt < earliest) throw fail(400, 'Pick a future date and time for this game night.');
  if (startsAt > now + 366 * 864e5) throw fail(400, 'Game nights can be scheduled up to a year ahead.');
  const locationRaw = String(b.location == null ? '' : b.location).replace(/\s/g, ' ').replace(CTRL_SINGLE, '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (locationRaw.length > MAX_LOCATION) throw fail(400, `Location is too long (at most ${MAX_LOCATION} characters).`);
  const note = cleanNightNote(b.note);
  let cap = null;
  if (b.cap !== undefined && b.cap !== null && String(b.cap).trim() !== '') {
    const n = Number(b.cap);
    if (!Number.isInteger(n) || n < MIN_CAP || n > MAX_CAP) throw fail(400, `Player limit must be a whole number from ${MIN_CAP} to ${MAX_CAP}.`);
    cap = n;
  }
  return { title, startsAt, location: locationRaw, note, cap };
}

export function cleanRsvpStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'in' || s === 'maybe' || s === 'out' || s === 'none') return s;
  throw fail(400, 'Answer must be In, Maybe, or Out.');
}

export function cleanAudience(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s === 'all') return 'all';
  if (s === 'going' || s === 'in' || s === 'unanswered') return s;
  throw fail(400, 'Choose who to remind: everyone, in & maybe, in only, or unanswered.');
}

export function formatNight(row, rsvpRows = []) {
  const list = rsvpRows.slice().sort((a, b) => {
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return ta - tb || String(a.name).localeCompare(String(b.name));
  });
  const rsvps = { in: [], maybe: [], out: [] };
  for (const r of list) {
    if (r.status === 'in' || r.status === 'maybe' || r.status === 'out') rsvps[r.status].push(r.name);
  }
  return {
    id: row.id,
    title: row.title,
    startsAt: Number(row.starts_at),
    location: row.location || '',
    note: row.note || '',
    cap: row.cap == null ? null : Number(row.cap),
    status: row.status === 'cancelled' ? 'cancelled' : 'open',
    remindedAt: row.reminded_at ? new Date(row.reminded_at).getTime() : null,
    reminderCount: Number(row.reminder_count) || 0,
    counts: { in: rsvps.in.length, maybe: rsvps.maybe.length, out: rsvps.out.length },
    rsvps
  };
}

// Human-readable date & time in the club/organizer's IANA time zone for a push reminder.
export function formatReminderWhen(startsAt, tz = 'UTC', now = Date.now()) {
  const zone = cleanZone(tz);
  const dayKey = ms => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(startsAt);
  const targetDay = dayKey(startsAt);
  if (targetDay === dayKey(now)) return `today at ${time}`;
  if (targetDay === dayKey(now + 864e5)) return `tomorrow at ${time}`;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(startsAt);
  return `${date} at ${time}`;
}

// Pure: builds Map<playerName, {title, body, tag}> for a game night reminder.
// Never includes the club code or club name (privacy invariant, see push-check.mjs).
export function nightReminderMessages(night, members, rsvpRows, { audience = 'all', tz = 'UTC', now = Date.now() } = {}) {
  const aud = cleanAudience(audience);
  const byKey = new Map();
  for (const r of rsvpRows || []) byKey.set(r.name_key || nameKey(r.name), r.status);
  const when = formatReminderWhen(Number(night.startsAt ?? night.starts_at), tz, now);
  const loc = night.location ? ` (${short(night.location, 36)})` : '';
  const title = short(night.title || 'Game night', 50);
  const tag = 'night-' + night.id;
  const out = new Map();
  for (const m of members || []) {
    const name = typeof m === 'string' ? m : m.name;
    const key = (typeof m === 'object' && m.name_key) || nameKey(name);
    if (!name || !key) continue;
    const st = byKey.get(key) || null;
    if (aud === 'all' && st === 'out') continue;
    if (aud === 'going' && st !== 'in' && st !== 'maybe') continue;
    if (aud === 'in' && st !== 'in') continue;
    if (aud === 'unanswered' && st !== null) continue;
    const who = short(name, 30);
    const body = st === 'in'
      ? `${who}, you're in for ${when}${loc}.`
      : st === 'maybe'
        ? `${who}, still maybe for ${when}${loc}? Tap to update.`
        : `${who}, are you in for ${when}${loc}?`;
    out.set(name, { title, body: short(body, 160), tag });
  }
  return out;
}

// ---- database queries and routes ----

async function loadFormattedNights(sql, code, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const rsvps = await sql`SELECT night_id, name_key, name, status, updated_at FROM game_night_rsvps
    WHERE club = ${code} AND night_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    ORDER BY updated_at ASC, lower(name) ASC`;
  const grouped = new Map();
  for (const r of rsvps) {
    let a = grouped.get(r.night_id);
    if (!a) { a = []; grouped.set(r.night_id, a); }
    a.push(r);
  }
  return rows.map(row => formatNight(row, grouped.get(row.id) || []));
}

async function loadOneNight(sql, code, id) {
  const [row] = await sql`SELECT id, title, starts_at, location, note, cap, status, reminded_at, reminder_count
    FROM game_nights WHERE club = ${code} AND id = ${id}`;
  if (!row) return null;
  const rsvps = await sql`SELECT night_id, name_key, name, status, updated_at FROM game_night_rsvps
    WHERE club = ${code} AND night_id = ${id} ORDER BY updated_at ASC, lower(name) ASC`;
  return formatNight(row, rsvps);
}

// Upcoming open nights shown on the main club payload (GET /api/club?code=...).
export async function upcomingNights(sql, code, now = Date.now()) {
  const cutoff = now - UPCOMING_GRACE_MS;
  const rows = await sql`SELECT id, title, starts_at, location, note, cap, status, reminded_at, reminder_count
    FROM game_nights WHERE club = ${code} AND status = 'open' AND starts_at >= ${cutoff}
    ORDER BY starts_at ASC, id ASC LIMIT 10`;
  return loadFormattedNights(sql, code, rows);
}

// Full list for the Game nights screen (GET /api/club?code=...&nights=1).
export async function nightsGet(sql, club, { now = Date.now() } = {}) {
  const cutoff = now - PAST_WINDOW_MS;
  const rows = await sql`SELECT id, title, starts_at, location, note, cap, status, reminded_at, reminder_count
    FROM game_nights WHERE club = ${club.code} AND starts_at >= ${cutoff}
    ORDER BY starts_at ASC, id ASC LIMIT 30`;
  return { nights: await loadFormattedNights(sql, club.code, rows), pushEnabled: !!vapidFromEnv() };
}

async function playerFrom(sql, club, name, token, tokenMatches) {
  if (!name || !token) return null;
  const [r] = await sql`SELECT name, claim_hash FROM roster WHERE club = ${club.code} AND name_key = ${nameKey(name)} AND blocked_at IS NULL`;
  return r && r.claim_hash && tokenMatches(r.claim_hash, token) ? r.name : null;
}

async function canonName(sql, club, raw) {
  const name = cleanName(raw);
  if (!name || /^Player \d+$/.test(name)) throw fail(400, 'Enter a valid player name.');
  const [r] = await sql`SELECT name FROM roster WHERE club = ${club.code} AND name_key = ${nameKey(name)}`;
  return r ? r.name : name;
}

export async function nightAction(sql, club, body, req, { now = Date.now() } = {}) {
  const { requireOrganizer, tokenMatches } = await import('./_db.js');
  const code = club.code;
  const action = String(body.action || '');

  if (action === 'night-create') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const input = cleanNightInput(body.night || body, { now, edit: false });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM game_nights WHERE club = ${code} AND status = 'open' AND starts_at >= ${now - UPCOMING_GRACE_MS}`;
    if (Number(n) >= MAX_NIGHTS) throw fail(400, `A club can schedule up to ${MAX_NIGHTS} upcoming game nights at once.`);
    const id = 'gn-' + randomBytes(6).toString('hex');
    await sql`INSERT INTO game_nights (club, id, title, starts_at, location, note, cap)
      VALUES (${code}, ${id}, ${input.title}, ${input.startsAt}, ${input.location}, ${input.note}, ${input.cap})`;
    return { status: 201, body: { ok: true, night: await loadOneNight(sql, code, id) } };
  }

  const id = String(body.id || '').trim();
  if (!id || id.length > 40) throw fail(400, 'Pick a game night.');

  if (action === 'night-edit') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const [cur] = await sql`SELECT id, status FROM game_nights WHERE club = ${code} AND id = ${id}`;
    if (!cur) throw fail(404, 'That game night no longer exists.');
    if (cur.status === 'cancelled') throw fail(409, 'That game night was cancelled.');
    const input = cleanNightInput(body.night || body, { now, edit: true });
    await sql`UPDATE game_nights SET title = ${input.title}, starts_at = ${input.startsAt}, location = ${input.location},
      note = ${input.note}, cap = ${input.cap}, updated_at = now() WHERE club = ${code} AND id = ${id}`;
    return { status: 200, body: { ok: true, night: await loadOneNight(sql, code, id) } };
  }

  if (action === 'night-cancel') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const rows = await sql`UPDATE game_nights SET status = 'cancelled', updated_at = now() WHERE club = ${code} AND id = ${id} RETURNING id`;
    if (!rows.length) throw fail(404, 'That game night no longer exists.');
    return { status: 200, body: { ok: true, night: await loadOneNight(sql, code, id) } };
  }

  if (action === 'night-delete') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const rows = await sql`DELETE FROM game_nights WHERE club = ${code} AND id = ${id} RETURNING id`;
    if (!rows.length) throw fail(404, 'That game night no longer exists.');
    return { status: 200, body: { ok: true } };
  }

  if (action === 'night-rsvp') {
    const status = cleanRsvpStatus(body.status);
    const me = await playerFrom(sql, club, body.playerName || body.name, body.playerToken, tokenMatches);
    let targetName;
    if (body.name && (!me || nameKey(body.name) !== nameKey(me))) {
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      targetName = await canonName(sql, club, body.name);
    } else if (me) {
      targetName = me;
    } else if (body.pin || body.ownerToken) {
      await requireOrganizer(club, body.pin, req, body.ownerToken);
      targetName = await canonName(sql, club, body.name || body.playerName);
    } else {
      throw fail(403, 'Pick your name in the club on this phone first to answer.');
    }
    const key = nameKey(targetName);
    if (status === 'none') {
      const [cur] = await sql`SELECT id, status FROM game_nights WHERE club = ${code} AND id = ${id}`;
      if (!cur) throw fail(404, 'That game night no longer exists.');
      if (cur.status === 'cancelled') throw fail(409, 'That game night was cancelled.');
      await sql`DELETE FROM game_night_rsvps WHERE club = ${code} AND night_id = ${id} AND name_key = ${key}`;
      await sql`UPDATE game_nights SET updated_at = now() WHERE club = ${code} AND id = ${id}`;
      return { status: 200, body: { ok: true, night: await loadOneNight(sql, code, id) } };
    }
    // Atomic upsert: checks that the night is open and enforces `cap` when switching into 'in'.
    const saved = await sql`INSERT INTO game_night_rsvps (club, night_id, name_key, name, status, updated_at)
      SELECT ${code}, ${id}, ${key}, ${targetName}, ${status}, now()
      WHERE EXISTS (
        SELECT 1 FROM game_nights n
        WHERE n.club = ${code} AND n.id = ${id} AND n.status = 'open'
          AND (
            ${status} <> 'in'
            OR n.cap IS NULL
            OR EXISTS (SELECT 1 FROM game_night_rsvps r WHERE r.club = ${code} AND r.night_id = ${id} AND r.name_key = ${key} AND r.status = 'in')
            OR (SELECT count(*) FROM game_night_rsvps r WHERE r.club = ${code} AND r.night_id = ${id} AND r.status = 'in') < n.cap
          )
      )
      ON CONFLICT (club, night_id, name_key) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
      RETURNING name_key`;
    if (!saved.length) {
      const [cur] = await sql`SELECT id, status, cap FROM game_nights WHERE club = ${code} AND id = ${id}`;
      if (!cur) throw fail(404, 'That game night no longer exists.');
      if (cur.status === 'cancelled') throw fail(409, 'That game night was cancelled.');
      throw fail(409, `This game night is full (${cur.cap}/${cur.cap} In). You can still mark Maybe or Out.`);
    }
    await sql`UPDATE game_nights SET updated_at = now() WHERE club = ${code} AND id = ${id}`;
    return { status: 200, body: { ok: true, night: await loadOneNight(sql, code, id) } };
  }

  if (action === 'night-remind') {
    await requireOrganizer(club, body.pin, req, body.ownerToken);
    const vapid = vapidFromEnv();
    if (!vapid) {
      return { status: 200, body: { ok: false, enabled: false, sent: 0, message: 'Notifications are not set up on this server yet.' } };
    }
    const [row] = await sql`SELECT id, title, starts_at, location, note, cap, status, reminded_at, reminder_count
      FROM game_nights WHERE club = ${code} AND id = ${id}`;
    if (!row) throw fail(404, 'That game night no longer exists.');
    if (row.status === 'cancelled') throw fail(409, 'That game night was cancelled.');
    if (Number(row.starts_at) < now - 2 * 3600_000) throw fail(400, 'That game night has already passed.');
    if (Number(row.reminder_count) >= MAX_REMINDERS_PER_NIGHT) {
      throw fail(429, `This game night has reached its limit of ${MAX_REMINDERS_PER_NIGHT} reminders.`);
    }
    if (row.reminded_at && now - new Date(row.reminded_at).getTime() < REMIND_COOLDOWN_MS) {
      const mins = Math.max(1, Math.ceil((REMIND_COOLDOWN_MS - (now - new Date(row.reminded_at).getTime())) / 60_000));
      throw fail(429, `A reminder was just sent for this game night. Wait ${mins} minute${mins === 1 ? '' : 's'} before sending another.`);
    }
    const audience = cleanAudience(body.audience);
    const tz = cleanZone(body.tz);
    // Per-club hourly rate limit (shared lookup_fails table, same pattern as _push.js and _db.js).
    const key = 'remind:' + code;
    const [{ id: markId }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - interval '1 hour'`;
    if (Number(n) > MAX_CLUB_REMINDERS_PER_HOUR) {
      await sql`DELETE FROM lookup_fails WHERE id = ${markId}`;
      throw fail(429, 'Too many reminders were sent for this club recently. Try again in an hour.');
    }
    const [members, rsvps] = await Promise.all([
      sql`SELECT name, name_key FROM roster WHERE club = ${code} AND claim_hash IS NOT NULL AND blocked_at IS NULL`,
      sql`SELECT name_key, name, status FROM game_night_rsvps WHERE club = ${code} AND night_id = ${id}`
    ]);
    const messages = nightReminderMessages(row, members, rsvps, { audience, tz, now });
    const sent = await notify(sql, code, messages, vapid);
    if (sent > 0) {
      await sql`UPDATE game_nights SET reminded_at = now(), reminder_count = reminder_count + 1, updated_at = now() WHERE club = ${code} AND id = ${id}`;
    }
    const night = await loadOneNight(sql, code, id);
    return {
      status: 200,
      body: {
        ok: true,
        enabled: true,
        sent,
        recipients: messages.size,
        night,
        ...(sent === 0 ? { message: 'No subscribed members to notify right now. Members can turn on notifications in the club menu.' } : {})
      }
    };
  }

  throw fail(400, 'Unknown action.');
}
