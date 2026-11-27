// Undo for organizer changes (L19), pure so test/undo.test.js needs no database. An organizer can reverse a role change (promote or
// demote), a rename, a rewards change by hand (points given or taken, an item gifted) or a boost, once, within UNDO_DAYS of it being logged in club_audit. The undo is itself logged ('undo'). A merge is never
// undoable: it folds two players' games, phone links and DUPR details into one, which can't be pulled apart again safely.
export const UNDO_DAYS = 7;
export const UNDO_ACTIONS = { promote: 'role', demote: 'role', rename: 'rename', 'reward-give': 'points', 'reward-take': 'points', 'reward-gift': 'gift', boost: 'boost' };

// What kind of undo a log row allows ('role' | 'rename'), or null. `at` is a Date or ms; undone_at set means it was already undone.
export function undoKind(entry, now) {
  if (!entry || entry.undone_at || !UNDO_ACTIONS[entry.action]) return null;
  const at = new Date(entry.at).getTime();
  if (!(now - at <= UNDO_DAYS * 86400000)) return null;
  const d = entry.detail || {};
  if (UNDO_ACTIONS[entry.action] === 'points') return Number.isInteger(d.amount) && d.amount > 0 && entry.target ? 'points' : null;
  if (UNDO_ACTIONS[entry.action] === 'gift') return typeof d.item === 'string' && d.item && entry.target ? 'gift' : null;
  if (entry.action === 'boost') return Number.isInteger(d.boostId) ? 'boost' : null;
  if (entry.action === 'rename') return typeof d.from === 'string' && d.from && entry.target ? 'rename' : null;
  return (d.from === 'organizer' || d.from === 'player') && (d.to === 'organizer' || d.to === 'player') ? 'role' : null;
}

// Whether the roster still matches what the logged change left behind, so reversing it can't trample a later change.
// row: the target's roster row (or undefined); other: the roster row now holding the old name (rename only).
export function undoConflict(entry, kind, row, other) {
  const d = entry.detail || {};
  if (!row) return kind === 'role' ? 'That member is gone, so there is nothing to undo.' : `${entry.target} is no longer a saved player, so the rename can't be undone.`;
  if (kind === 'role') {
    if ((row.role || 'player') !== d.to) return `${row.name}'s role has changed since, so this can't be undone.`;
    if (d.from === 'organizer' && !row.claim_hash) return `${row.name} is no longer linked to a phone, so they can't be an organizer again.`;
    return null;
  }
  if (other && other.name_key !== row.name_key) return `${other.name} is a saved player now, so ${entry.target} can't go back to that name.`;
  return null;
}
