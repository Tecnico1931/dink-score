// Self-reported DUPR rating: one optional number per saved player, shown for reference only. Never used for the
// Dink Rating, XP, achievements, leaderboard order or event seeding, and never sent to DUPR.
export const DUPR_MIN = 2, DUPR_MAX = 8;

// Returns the rating as a Number with at most 3 decimals, or null to clear it (empty input). Throws a plain
// Error with a message fit for the app on anything else.
export function cleanDupr(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(',', '.');
  if (!text) return null;
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(text)) throw new Error('Enter a DUPR rating like 3.52, with up to 3 decimals.');
  const n = Number(text);
  if (n < DUPR_MIN || n > DUPR_MAX) throw new Error(`A DUPR rating is from ${DUPR_MIN}.000 to ${DUPR_MAX}.000.`);
  return n;
}

// Database numeric (text) -> Number, or null.
export const duprFrom = v => (v === null || v === undefined ? null : Number(v));
