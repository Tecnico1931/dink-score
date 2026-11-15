// Export finished event results as CSV / plain text, for an organizer to import into DUPR (or anywhere else).
// Pure functions on the event object the app already shows (api/_events.js view()); no network, no storage.
//
// NOTE: DUPR's official club CSV import template could not be read when this was written, so DUPR_COLUMNS is a
// clearly named generic layout, not DUPR's. When the real template is known, changing DUPR_COLUMNS is the whole fix.
// DUPR IDs are deliberately not exported: DUPR forbids manually typed IDs for partner integrations.

export const MIN_WINNING_SCORE = 6; // DUPR rated matches need a winner with at least 6 points

// [header, value(row)]. A row is { event, round, date, teams: [[a, b], [c, d]], score: [x, y], winner: 0 | 1 }.
export const DUPR_COLUMNS = [
  ['Event', r => r.event],
  ['Bracket/Round', r => r.round],
  ['Date', r => r.date],
  ['Match format', () => 'DOUBLES'],
  ['Team A player 1', r => r.teams[0][0]],
  ['Team A player 2', r => r.teams[0][1]],
  ['Team B player 1', r => r.teams[1][0]],
  ['Team B player 2', r => r.teams[1][1]],
  ['Game score A', r => r.score[0]],
  ['Game score B', r => r.score[1]],
  ['Winner', r => (r.winner === 0 ? 'Team A' : 'Team B')]
];

const pad = n => String(n).padStart(2, '0');
// yyyy-MM-dd in the device's local time, which is where the organizer's games were played.
export const dateOf = ms => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''; };

// Every match of the event with its round title, in the order the event shows them (pool rounds, then knockout).
function allMatches(ev) {
  const out = [];
  for (const r of ev.rounds || []) for (const m of r.matches || []) out.push({ m, round: r.title || '' });
  for (const r of ev.knockout || []) for (const m of r.matches || []) out.push({ m, round: r.title || '' });
  return out;
}

const names = t => Array.isArray(t) && t.length === 2 && t.every(n => typeof n === 'string' && n.trim()) ? t : null;

// Splits an event into rows that can be exported and matches that cannot, each with the reason.
// rows are ordered by when they finished (then started), then by their place in the event.
export function exportRows(ev) {
  const rows = [], skipped = [];
  allMatches(ev).forEach(({ m, round }, i) => {
    const label = `${round ? round + ': ' : ''}${(m.teams || []).map(t => (t ? t.join(' & ') : 'To be decided')).join(' vs ')}`;
    const sc = m.score;
    if (m.status !== 'done' || !Array.isArray(sc)) return skipped.push({ id: m.id, label, reason: 'Not played yet' });
    if (!names(m.teams && m.teams[0]) || !names(m.teams && m.teams[1])) return skipped.push({ id: m.id, label, reason: 'Players are not known' });
    if (sc[0] === sc[1]) return skipped.push({ id: m.id, label, reason: 'Tied, so there is no winner' });
    const winner = sc[0] > sc[1] ? 0 : 1;
    if (sc[winner] < MIN_WINNING_SCORE) return skipped.push({ id: m.id, label, reason: `Winner has under ${MIN_WINNING_SCORE} points` });
    const at = m.endedAt || m.startedAt || ev.updatedAt || ev.createdAt;
    rows.push({ id: m.id, event: ev.name, round, date: dateOf(at), teams: m.teams, score: sc, winner, at: at || 0, i });
  });
  rows.sort((a, b) => a.at - b.at || a.i - b.i);
  return { rows, skipped };
}

// A spreadsheet runs a cell that starts with = + - @ (or a tab / carriage return) as a formula, so those get a leading quote.
const neutralise = s => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);
// RFC 4180: quote a field holding a comma, quote or line break; double any quote inside it.
export function csvField(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number') s = neutralise(s);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// UTF-8 byte order mark so Excel opens accented names correctly; CRLF line ends per RFC 4180.
export function toCsv(rows, columns = DUPR_COLUMNS) {
  const lines = [columns.map(c => csvField(c[0])).join(','), ...rows.map(r => columns.map(c => csvField(c[1](r))).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Plain text for pasting into a message: one line per match, in the same order as the CSV.
export function toText(ev, rows) {
  return `${ev.name}\n` + rows.map(r => `${r.date}${r.round ? ' · ' + r.round : ''}: ${r.teams[0].join(' & ')} ${r.score[0]}–${r.score[1]} ${r.teams[1].join(' & ')}`).join('\n') + '\n';
}

// dink-<event>-<date>.csv with only a-z, 0-9 and dashes in the event part.
export function fileName(ev, date) {
  const slug = String(ev.name || 'event').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `dink-${slug || 'event'}-${date}.csv`;
}
