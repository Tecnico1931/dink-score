// Rewards, transparency: "Dinks activity" (the player's own ledger in plain words, with the running balance) and the pace behind the Shop's
// saving goal. Pure (no database, no clock of its own): players.js feeds them the caller's own rows from loadLedger. Read-only and play money
// only (rules in DESIGN.md "Rewards", guard in test/economyguard.test.js): it never reads or changes a score, a rating, a rank or a pairing,
// and a row leaves here without its id, name key or any other player's data.
import { itemById } from './_economyshop.js';
import { ACHIEVEMENTS } from './_progress.js';
import { shinyPetOf } from './_economypets.js';

export const ACTIVITY_CAP = 100;   // rows sent to the phone

const nameOf = id => { const it = itemById(id) || shinyPetOf(id); return it ? (id.startsWith('shiny-') ? 'Shiny ' + it.name.toLowerCase() : it.name) : 'an item'; };
const tierOf = r => (/^pass:tier-(\d+)$/.exec(r) || [])[1];

// One ledger row in plain words. Unknown reasons fall back to a kind-only line, so a future reason never leaks its raw text.
export function describe(e) {
  const r = String(e.reason || '');
  if (e.kind === 'earn') {
    if (r === 'day') return 'Earned for a play day';
    if (r === 'day+streak') return 'Earned for a play day, with a streak bonus';
    if (r === 'spin') return 'Daily spin';
    if (r.startsWith('org:')) return `From an organizer: ${r.slice(4)}`; // the reason an organizer typed, shown to the player it is about
    if (r === 'game') return 'Earned from games';
    if (r === 'challenge') return 'Weekly challenge reward';
    if (r.startsWith('ach:')) return `Achievement: ${(ACHIEVEMENTS.find(a => a.id === r.slice(4)) || {}).name || 'unlocked'}`;
    if (/^sprz:[1-3]$/.test(r)) return `Season prize: ${['1st', '2nd', '3rd'][r.slice(5) - 1]} place`;
    if (r === 'prestige') return 'Prestige: back to level 1 with a star';
    if (r.startsWith('boxref:')) return `Mystery box refund: you already had ${nameOf(r.slice(7))}`;
    if (r.startsWith('pass:owned:')) return `Season pass tier reward: you already had ${nameOf(r.slice(11))}`;
    if (tierOf(r)) return `Season pass tier ${tierOf(r)}`;
    if (r.startsWith('pass:')) return `Season pass tier reward: ${nameOf(r.slice(5))}`;
    return 'Earned Dinks';
  }
  if (r.startsWith('orgtake:')) return `Taken by an organizer: ${r.slice(8)}`;
  if (r === 'game-adj') return 'Taken back: a game was edited or removed';
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
