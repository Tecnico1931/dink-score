// Rewards, boost events (M11, upstream parity): an organizer opens a window in which every Dinks payment from games is doubled and the day's
// cap with it (optionally XP too). Pure rules first (no database), then the SQL. Play money only (DESIGN.md "Rewards", test/economyguard.test.js).
//
// The pay is worked out from the games' `receivedAt` (the server's clock), so a window is a plain history: a game received inside [from, to) is
// boosted for good, and ending a boost early only stops later games. Rows are never edited except to end one early. A UTC day that holds any
// boosted game of a player gets a doubled cap (600 Dinks, 600 XP); the boosted game's own pay is doubled.
export const BOOST_CHOICES = Object.freeze(['today', 'weekend', '1', '3', '7']);
const DAY = 864e5;

// The window a choice opens, starting now: `today` runs to the end of the UTC day, `weekend` covers Saturday and Sunday (UTC; starts now when it
// is already the weekend), a number is that many days from now. null for anything else.
export function boostWindow(choice, now) {
  const sod = Math.floor(now / DAY) * DAY, dow = new Date(now).getUTCDay();
  if (choice === 'today') return { from: now, to: sod + DAY };
  if (choice === 'weekend') return { from: dow === 6 || dow === 0 ? now : sod + (6 - dow) * DAY, to: sod + ((7 - dow) % 7 + 1) * DAY };
  const n = { 1: 1, 3: 3, 7: 7 }[choice];
  return n ? { from: now, to: now + n * DAY } : null;
}

// Is `ms` inside a boost window that doubles `kind` ('dinks' always when boosted, 'xp' only when the organizer ticked it)? `boosts`: [{from, to, xp}].
export const boostedAt = (boosts, ms, kind = 'dinks') => Array.isArray(boosts) && boosts.some(b => ms >= b.from && ms < b.to && (kind === 'xp' ? b.xp : true));

// What the Shop shows: the boost running now (or null), and the next one waiting to start.
export function boostState(boosts, now) {
  const live = (boosts || []).filter(b => b.to > now).sort((a, b) => a.from - b.from);
  const cur = live.find(b => b.from <= now), next = live.find(b => b.from > now);
  const out = b => b && { id: b.id, from: b.from, until: b.to, dinks: 2, xp: b.xp ? 2 : 1 };
  return { active: out(cur) || null, upcoming: out(next) || null };
}

export async function loadBoosts(sql, code) {
  return (await sql`SELECT id, (extract(epoch FROM starts_at) * 1000)::bigint AS f, (extract(epoch FROM ends_at) * 1000)::bigint AS t, xp
    FROM club_boosts WHERE club = ${code} ORDER BY id DESC LIMIT 200`).map(r => ({ id: Number(r.id), from: Number(r.f), to: Number(r.t), xp: !!r.xp }));
}

export const boostView = async (sql, code, now = Date.now()) => boostState(await loadBoosts(sql, code), now);
