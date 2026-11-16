// Data rights helpers (pure, no database): anonymising a name inside stored JSON, and the club export formats.
// Used by players.js (player export / anonymise) and club.js (organizer export / delete club).
import { randomInt } from 'node:crypto';
import { nameKey } from './_names.js';

export const DELETE_UNDO_HOURS = 24; // how long a deleted club can still be brought back
const LABEL_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// A new anonymous name, "Former player K7M2Q". Random, never derived from the name it replaces, so it can't be reversed by
// trying likely names. Every place a person's name was gets this same label, which is what keeps their games linked.
export function newAnonLabel() {
  let s = '';
  for (let i = 0; i < 5; i++) s += LABEL_ALPHA[randomInt(0, LABEL_ALPHA.length)];
  return 'Former player ' + s;
}
export const isAnonLabel = s => /^Former player [A-Z0-9]{5}$/.test(String(s));

// Returns a copy of `value` with every string (and object key) whose nameKey equals `key` replaced by `label`.
// Whole strings only: a team called "Ana & Ben" is free text and is left alone. `scoredBy` holds a name key, so it gets the label's key.
export function renameDeep(value, key, label) {
  const hit = s => typeof s === 'string' && nameKey(s) === key;
  const walk = v => {
    if (hit(v)) return label;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [hit(k) ? label : k, k === 'scoredBy' && hit(x) ? nameKey(label) : walk(x)]));
    return v;
  };
  return walk(value);
}
// SQL LIKE pattern that finds `name` inside the JSON text of a jsonb column (a cheap pre-filter; renameDeep is the real check).
// Spaces match any text, since stored names may have extra spaces. Names with non-ASCII letters match everything: SQL and JavaScript lower-casing can disagree there, and a miss would leave the name behind.
export const likeFor = name => /^[\x20-\x7e]*$/.test(name)
  ? '%' + JSON.stringify(String(name)).slice(1, -1).toLowerCase().replace(/[\\%_]/g, '\\$&').replace(/ /g, '%') + '%'
  : '%';

// A spreadsheet treats a cell starting with = + - @ (or a tab or return) as a formula, so those get a leading apostrophe.
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function gamesCsv(rows) {
  const head = ['id', 'ended_at', 'mode', 'team1', 'team2', 'score1', 'score2', 'winner_team', 'scoring', 'target', 'win_by', 'deleted_at'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const g = r.data || {}, t = g.teams || [[], []];
    lines.push([g.id, new Date(Number(g.endedAt)).toISOString(), g.mode, (t[0] || []).join(' & '), (t[1] || []).join(' & '),
      (g.score || [])[0], (g.score || [])[1], Number(g.winner) + 1, g.scoring, g.target, g.winBy, r.deleted_at ? new Date(r.deleted_at).toISOString() : ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
