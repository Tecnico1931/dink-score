// Rewards, transparency: "Dinks activity" (the player's own ledger in plain words, with the running balance) and the pace behind the Shop's
// saving goal. Pure (no database, no clock of its own): players.js feeds them the caller's own rows from loadLedger. Read-only and play money
// only (rules in DESIGN.md "Rewards", guard in test/economyguard.test.js): it never reads or changes a score, a rating, a rank or a pairing,
// and a row leaves here without its id, name key or any other player's data.
import { itemById } from './_economyshop.js';

export const ACTIVITY_CAP = 100;   // rows sent to the phone

const nameOf = id => { const it = itemById(id); return it ? it.name : 'an item'; };
const tierOf = r => (/^pass:tier-(\d+)$/.exec(r) || [])[1];

// One ledger row in plain words. Unknown reasons fall back to a kind-only line, so a future reason never leaks its raw text.
export function describe(e) {
  const r = String(e.reason || '');
  if (e.kind === 'earn') {
    if (r === 'day') return 'Earned for a play day';
    if (r === 'day+streak') return 'Earned for a play day, with a streak bonus';
    if (r.startsWith('boxref:')) return `Mystery box refund: you already had ${nameOf(r.slice(7))}`;
    if (r.startsWith('pass:owned:')) return `Season pass tier reward: you already had ${nameOf(r.slice(11))}`;
    if (tierOf(r)) return `Season pass tier ${tierOf(r)}`;
    if (r.startsWith('pass:')) return `Season pass tier reward: ${nameOf(r.slice(5))}`;
    return 'Earned Dinks';
  }
  if (r.startsWith('shop:')) return `Bought ${nameOf(r.slice(5))}`;
  if (r.startsWith('box:')) return `Opened a mystery box: ${nameOf(r.slice(4))}`;
  return 'Spent Dinks';
}

// Newest first, last `cap` rows of the whole ledger, each with the balance right after it. The ledger is oldest first (loadLedger).
export function activityFrom(ledger, cap = ACTIVITY_CAP) {
  let bal = 0;
  const all = ledger.map(e => { bal += Number.isFinite(e.amount) ? e.amount : 0; return { at: new Date(e.at).toISOString(), amount: e.amount, text: describe(e), balance: bal }; });
  return { balance: bal, total: all.length, entries: all.reverse().slice(0, cap) };
}
