// Rewards, slice 2: the Dinks ledger and balance, as pure functions (no database; the SQL is in _economysync.js, the actions live in
// players.js as rewards-*). Play money only (rules in DESIGN.md "Rewards", guard in test/economyguard.test.js): no purchase path, nothing
// converts to anything, and nothing here reads or changes a score, a rating, a rank or a pairing.
//
// The server is the source of truth. A player's earnings are worked out HERE from games that player's own phone saved (the game's
// `scoredBy` is the verified roster name key, set by games.js, never taken from the phone's say-so) and from the server's own
// `receivedAt` clock, so a phone cannot claim Dinks, set its clock back or backdate a log to earn.
//
// The ledger is append-only: a row is `{id, kind: 'earn'|'spend', amount, reason, day, streak}`. `amount` is > 0 for an earn and < 0 for
// a spend, `id` is unique per player per club (a replay or a second device re-sends the same id and nothing is added twice), and the
// balance is only ever the sum. Rows are never edited or deleted, except that a rename/merge moves them to the new name and anonymise or
// deleting the club removes them. spendEntry() is the one place the rule "never below zero" lives.

// The daily streak (WI-17, upstream parity): the first game a day sent from your own phone pays what the streak day is worth. Day 1 to 7 pay the
// ladder, every day after the 7th pays the last rung, and two milestone days pay extra on top. A missed day restarts the streak at day 1.
export const LADDER = [5, 8, 10, 12, 15, 20, 25];
export const MILESTONES = [[30, 100], [100, 250]];            // streak day -> extra Dinks on exactly that day
export const LOOKBACK_DAYS = 14;                            // a first sync pays at most this many past days, so an old history is never back-paid
export const MAX_BALANCE = 1e6;
export const RECENT = 20;                                   // ledger rows sent back to the phone

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dayNum = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
// The local day of a server timestamp for a phone `tz` minutes east of UTC. The phone says its offset; it can only move a game between
// neighbouring days, never create one (a game exists only because the server received it).
export const cleanTz = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(-720, Math.min(840, n)) : 0; };
export const dayKey = (ms, tz = 0) => new Date(ms + cleanTz(tz) * 60000).toISOString().slice(0, 10);
export const bonusFor = day => { const hit = MILESTONES.find(m => m[0] === day); return hit ? hit[1] : 0; };
export const dayPay = day => (day >= 1 ? LADDER[Math.min(day, LADDER.length) - 1] + bonusFor(day) : 0);

// The newest earn row by day: where the streak stands.
const lastEarn = ledger => ledger.reduce((a, e) => (e.kind === 'earn' && e.day && (!a || e.day > a.day) ? e : a), null);

// New earn rows for the given receive times (ms): one per local day on which the player saved a game, strictly after the last day already
// paid and not older than LOOKBACK_DAYS. A gap of more than a day restarts the streak at 1. Pure and deterministic, so two phones syncing
// at once produce the same ids and amounts, and a replay produces nothing new.
export function deriveEarnings({ ledger = [], receivedAt = [], tz = 0, now }) {
  const today = dayKey(now, tz);
  const last = lastEarn(ledger);
  const floor = dayNum(today) - LOOKBACK_DAYS;
  const days = [...new Set(receivedAt.filter(Number.isFinite).map(ms => dayKey(ms, tz)))].filter(d => d <= today && dayNum(d) >= floor && (!last || d > last.day)).sort();
  const out = [];
  let prev = last ? { day: last.day, streak: last.streak || 1 } : null;
  for (const day of days) {
    const streak = prev && dayNum(day) - dayNum(prev.day) === 1 ? prev.streak + 1 : 1;
    out.push({ id: 'day:' + day, kind: 'earn', amount: dayPay(streak), reason: bonusFor(streak) ? 'day+streak' : 'day', day, streak });
    prev = { day, streak };
  }
  return out;
}

// What the Shop header shows beside the balance: all Dinks ever earned and all spent (balance = earned - spent, before the 1e6 cap).
// A 'game-adj' row takes back Dinks a game paid before it was edited or deleted, so it lowers what was earned rather than counting as spent.
export const totals = ledger => ledger.reduce((t, e) => { const n = Number.isFinite(e.amount) ? e.amount : 0; if (n > 0 || e.reason === 'game-adj' || String(e.reason).startsWith('orgtake:')) t.earned += n; else t.spent -= n; return t; }, { earned: 0, spent: 0 });

export const ledgerBalance = ledger => Math.min(MAX_BALANCE, ledger.reduce((n, e) => n + (Number.isFinite(e.amount) ? e.amount : 0), 0));

// A spend row (used by the shop). Refuses a spend that would take the balance below zero, and a repeat of an id already used.
export function spendEntry(ledger, { id, amount, reason }) {
  const n = Math.trunc(Number(amount));
  if (!/^[a-z0-9:_-]{4,64}$/.test(String(id || ''))) throw new Error('A spend needs an id.');
  if (!(n > 0)) throw new Error('A spend must be a positive number of Dinks.');
  if (ledger.some(e => e.id === id)) return null; // already recorded: idempotent
  if (n > ledgerBalance(ledger)) throw new Error('Not enough Dinks.');
  return { id, kind: 'spend', amount: -n, reason: String(reason || 'spend').slice(0, 40), day: null, streak: null };
}

// What the phone shows: balance, the streak as it stands today (broken after a missed day), the best run, the last paid day.
export function summary(ledger, tz, now) {
  const last = lastEarn(ledger), today = dayKey(now, tz);
  const alive = last && dayNum(today) - dayNum(last.day) <= 1 ? last.streak : 0;
  const best = ledger.reduce((m, e) => Math.max(m, e.streak || 0), 0);
  return { dinks: ledgerBalance(ledger), streak: alive, best, last: last ? last.day : '' };
}

// A stored or incoming row, checked. Used before an insert so a bad row can never reach the table.
export const validEntry = e => !!e && typeof e.id === 'string' && /^[A-Za-z0-9:_-]{4,80}$/.test(e.id) && (e.kind === 'earn' ? e.amount > 0 : e.kind === 'spend' && e.amount < 0)
  && Number.isInteger(e.amount) && (e.day === null || DAY.test(e.day));

export const PACE_DAYS = 30;     // how far back "your usual pace" looks (Shop saving goal)
export const PACE_MIN_DAYS = 3;  // fewer play days than this is too little to call a pace
// Dinks earned per play day over the last PACE_DAYS: only the rows paid for playing (a play day with its streak pay, and the day's game earnings with
// their adjustments), so a box refund, a spin or a pass reward never skews it. null until there are PACE_MIN_DAYS play days to go on.
// The UTC day a game-earnings row belongs to (`play:<day>` or `play:<day>:<n>`), also when a merge moved the row under `m:<name key>:`; else null.
export const gameRowDay = id => (/(?:^|:)play:(\d{4}-\d{2}-\d{2})(?::\d+)?$/.exec(String(id)) || [])[1] || null;
export function paceFrom(ledger, now) {
  const floor = dayNum(dayKey(now, 0)) - PACE_DAYS, per = new Map();
  for (const e of ledger) {
    const d = e.reason === 'day' || e.reason === 'day+streak' ? e.day : e.reason === 'game' || e.reason === 'game-adj' ? gameRowDay(e.id) : null;
    if (d && dayNum(d) >= floor) per.set(d, (per.get(d) || 0) + e.amount);
  }
  const days = [...per.values()].filter(n => n > 0);
  if (days.length < PACE_MIN_DAYS) return null;
  return Math.round(days.reduce((n, v) => n + v, 0) / days.length * 100) / 100;
}
