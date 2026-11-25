// Rewards, daily spin (WI-15; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js).
// One free spin per UTC day, shown only where clubs.rewards AND clubs.mystery_box are on (no new column). Play money only: it never
// reads or changes a score, rating, rank or pairing. The draw happens only here, with node:crypto randomInt (CSPRNG); the wheel the
// phone draws and the odds line it prints come from SPIN_SEGMENTS / SPIN_CHANCES below, so what is shown can't differ from what is drawn.
//
// Idempotent without a table: the win is one reward_ledger row with id `spin:<UTC day>` (kind earn, day NULL so play streaks are untouched).
// The insert is guarded by NOT EXISTS under the per-player advisory lock, so a double tap or a replay returns the same win.
import { randomInt } from 'node:crypto';
import { dayKey } from './_economy.js';

// Wheel order, clockwise from the pointer (the phone draws exactly this).
export const SPIN_SEGMENTS = Object.freeze([5, 10, 3, 15, 5, 25, 3, 50]);
// Integer percentage per prize value, summing to 100. The wheel shows the win on the first segment that holds the value.
export const SPIN_CHANCES = Object.freeze([
  Object.freeze({ value: 3, chance: 30 }),
  Object.freeze({ value: 5, chance: 30 }),
  Object.freeze({ value: 10, chance: 20 }),
  Object.freeze({ value: 15, chance: 10 }),
  Object.freeze({ value: 25, chance: 7 }),
  Object.freeze({ value: 50, chance: 3 })
]);
export const SPIN_MAX = Math.max(...SPIN_SEGMENTS);
export const spinId = day => 'spin:' + day;

export const spinOdds = () => ({ segments: [...SPIN_SEGMENTS], chances: SPIN_CHANCES.map(c => ({ ...c })), max: SPIN_MAX });

// Pure draw. `randInt(max)` is a uniform integer in [0, max); tests inject a deterministic one.
export function drawSpin(randInt = randomInt) {
  const total = SPIN_CHANCES.reduce((n, c) => n + c.chance, 0);
  if (total !== 100) throw new Error('Spin odds must sum to 100.');
  const roll = randInt(total);
  if (!Number.isInteger(roll) || roll < 0 || roll >= total) throw new Error('Random source out of range.');
  let acc = 0, won = SPIN_CHANCES[SPIN_CHANCES.length - 1];
  for (const c of SPIN_CHANCES) { acc += c.chance; if (roll < acc) { won = c; break; } }
  return { value: won.value };
}

// Today's state for this player: has the spin been used, and what did it win.
export async function spinStatus(sql, code, key, now = Date.now()) {
  const today = dayKey(now, 0);
  const [row] = await sql`SELECT amount FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${spinId(today)}`;
  return { ...spinOdds(), spunToday: !!row, wonToday: row ? Number(row.amount) : 0 };
}

// Spin once: the draw is made first, then one guarded insert. A second call the same day finds the row and returns the stored win.
export async function doSpin(sql, code, key, { now = Date.now(), randInt = randomInt } = {}) {
  const today = dayKey(now, 0), id = spinId(today), drawn = drawSpin(randInt);
  const [, ins, rows] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${code + '/' + key}))`,
    sql`INSERT INTO reward_ledger (club, name_key, id, kind, amount, reason, day, streak)
      SELECT ${code}, ${key}, ${id}, 'earn', ${drawn.value}, 'spin', NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${id})
      RETURNING amount`,
    sql`SELECT amount FROM reward_ledger WHERE club = ${code} AND name_key = ${key} AND id = ${id}`
  ]);
  const value = Number(rows[0].amount);
  const replayed = !ins.length;
  return { ...spinOdds(), spunToday: true, wonToday: value, result: { value, replayed } };
}
