// Import the players and teams of a tournament from a CSV (a Google Sheet's CSV export, pasted text or an uploaded file).
// Pure functions, no network and no storage: the app uses this to show the preview and edit it, and the API runs the
// same checks again before anything is created (api/events.js). Lives at the top level, like dupr-export.js, because
// the browser loads it directly (see build.cjs, which copies it to public/).
//
// DUPR IDs are carried through as an optional local reference only. Nothing here sends them anywhere.
//
// A draft is what the preview shows and edits:
//   { layout: 'players' | 'teams', teams: [{ name, logo, line, players: [{ name, dupr, line }] }], loose: [{ name, dupr, line }], notes: [text] }
// loose = players whose row had no team name. Every text field is a plain string; validate() says what is wrong with it.

export const LIMITS = { rows: 200, bytes: 512 * 1024, name: 40, logo: 300, players: 32 };
export const DUPR_RE = /^[A-Z0-9]{5,10}$/;

// Column names the importer knows, compared without case, spaces or punctuation ("Logo URL" = "logo_url" = "LOGOURL").
// The template and the on-screen help print these, so the UI and the parser cannot drift apart.
export const COLUMNS = {
  player: { label: 'Player', names: ['player', 'playername', 'name', 'fullname'], about: 'one row per player: the player' },
  team: { label: 'Team', names: ['team', 'teamname'], about: 'optional: the team name; rows with the same team form a team' },
  dupr: { label: 'DUPR ID', names: ['duprid', 'dupr', 'duprcode'], about: 'optional: reference only, not checked with DUPR' },
  logo: { label: 'Logo URL', names: ['logourl', 'logo', 'teamlogo', 'teamlogourl', 'logolink', 'image', 'imageurl'], about: 'optional: https link to the team logo image' },
  p1: { label: 'Player 1', names: ['player1', 'p1', 'player1name', 'playera'], about: 'one row per team: the first player' },
  p2: { label: 'Player 2', names: ['player2', 'p2', 'player2name', 'playerb'], about: 'one row per team: the second player' },
  dupr1: { label: 'DUPR ID 1', names: ['duprid1', 'dupr1', 'player1dupr', 'player1duprid', 'p1dupr', 'p1duprid', 'duprplayer1', 'duprp1'], about: 'optional: player 1 reference ID' },
  dupr2: { label: 'DUPR ID 2', names: ['duprid2', 'dupr2', 'player2dupr', 'player2duprid', 'p2dupr', 'p2duprid', 'duprplayer2', 'duprp2'], about: 'optional: player 2 reference ID' }
};
export const LAYOUT_COLUMNS = {
  players: ['player', 'team', 'dupr', 'logo'],
  teams: ['team', 'p1', 'p2', 'dupr1', 'dupr2', 'logo']
};
export const TEMPLATE_PLAYERS = 'Player,Team,DUPR ID,Logo URL\r\nAna Lopez,Net Ninjas,K4M2P9,https://example.com/logos/net-ninjas.png\r\nBen Ruiz,Net Ninjas,R7T3QX,\r\nCy Park,Drop Shots,,https://example.com/logos/drop-shots.png\r\nDi Wu,Drop Shots,,\r\n';
export const TEMPLATE_TEAMS = 'Team,Player 1,Player 2,DUPR ID 1,DUPR ID 2,Logo URL\r\nNet Ninjas,Ana Lopez,Ben Ruiz,K4M2P9,R7T3QX,https://example.com/logos/net-ninjas.png\r\nDrop Shots,Cy Park,Di Wu,,,https://example.com/logos/drop-shots.png\r\n';

// Control characters, zero-width and direction marks, separators, the byte-order mark. Built from character codes so no
// invisible characters live in this file (the same set api/_names.js removes from names, plus nothing else).
const JUNK = new RegExp('[' + [[0x00, 0x1F], [0x7F, 0x9F], [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const squash = v => String(v ?? '').replace(/\s/g, ' ').replace(JUNK, '').trim().replace(/\s+/g, ' ').replace(/\|/g, '');

// Same rule as cleanName() in api/_names.js (40 characters, no junk, no '|'), but never cuts a name short: a name that is
// too long is reported by validate() so the organizer sees it.
export const cleanText = v => squash(v);
export const key = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- Field checks. Each returns { value } or { error }.
export function cleanDupr(raw) {
  const v = String(raw ?? '').replace(JUNK, '').trim().toUpperCase();
  if (!v) return { value: '' };
  return DUPR_RE.test(v) ? { value: v } : { error: 'A DUPR ID is 5 to 10 letters and numbers, like K4M2P9.' };
}

const BAD_HOST = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp|test|invalid)$/;
export function cleanLogoUrl(raw) {
  const s = String(raw ?? '').replace(JUNK, '').trim();
  if (!s) return { value: '' };
  if (s.length > LIMITS.logo) return { error: `The logo link is too long (${LIMITS.logo} characters at most).` };
  if (/\s/.test(s)) return { error: 'The logo link has spaces in it.' };
  let u;
  try { u = new URL(s); } catch { return { error: 'The logo link is not a web address.' }; }
  if (u.protocol !== 'https:') return { error: 'The logo link must start with https://.' };
  if (u.username || u.password) return { error: 'The logo link must not contain a user name or password.' };
  const host = u.hostname.toLowerCase();
  if (u.port) return { error: 'The logo link must not name a port.' };
  if (!host.includes('.') || host.startsWith('[') || /^[0-9.]+$/.test(host) || BAD_HOST.test(host)) return { error: 'The logo link must use a public website name.' };
  if (u.href.length > LIMITS.logo) return { error: `The logo link is too long (${LIMITS.logo} characters at most).` };
  return { value: u.href };
}

export const initials = label => {
  const words = cleanText(label).split(' ').filter(Boolean);
  const pick = words.length > 1 ? words.slice(0, 2).map(w => w[0]) : (words[0] || '?').slice(0, 2).split('');
  return pick.join('').toUpperCase();
};

// ---- CSV. Quoted fields (with commas, doubled quotes and line breaks), CRLF/LF/CR, a leading byte-order mark.
// Pasting from a spreadsheet gives tabs, and some countries' exports use semicolons, so the delimiter is chosen from the first line.
export function detectDelimiter(text) {
  const n = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    else if (!q && (ch === '\n' || ch === '\r')) { if (n[','] + n['\t'] + n[';'] > 0) break; }
    else if (!q && ch in n) n[ch]++;
  }
  if (n['\t'] > 0 && n['\t'] >= n[',']) return '\t';
  if (n[';'] > 0 && n[','] === 0) return ';';
  return ',';
}
export function parseCsv(input, delim) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const d = delim || detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', q = false, any = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.length > 1 || row[0] !== '' || any) rows.push(row); row = []; any = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') { q = true; any = true; }
    else if (ch === d) endCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length || q) endRow();
  return rows;
}

// ---- Reading a sheet into a draft.
function columnsOf(header) {
  const idx = {};
  header.forEach((h, i) => {
    const k = key(h);
    if (!k) return;
    for (const [id, c] of Object.entries(COLUMNS)) if (idx[id] === undefined && c.names.includes(k)) { idx[id] = i; break; }
  });
  return idx;
}

// text -> { ok: true, layout, found: [column labels], draft } or { ok: false, error }
export function parseSheet(text) {
  const raw = String(text ?? '');
  if (raw.length > LIMITS.bytes) return { ok: false, error: 'That file is too large. Keep it under 512 KB.' };
  if (!raw.trim()) return { ok: false, error: 'The sheet is empty.' };
  const rows = parseCsv(raw).filter(r => r.some(c => String(c).trim() !== ''));
  if (!rows.length) return { ok: false, error: 'The sheet is empty.' };
  const header = rows[0], idx = columnsOf(header);
  const perTeam = idx.p1 !== undefined && idx.p2 !== undefined;
  if (!perTeam && idx.player === undefined) {
    return { ok: false, error: `Could not find a Player column. The first row must name the columns, like: ${COLUMNS.player.label}, ${COLUMNS.team.label}, ${COLUMNS.dupr.label}, ${COLUMNS.logo.label}. Found: ${header.map(h => cleanText(h)).filter(Boolean).slice(0, 8).join(', ') || 'nothing'}.` };
  }
  const data = rows.slice(1);
  if (!data.length) return { ok: false, error: 'The sheet has a header row but no players.' };
  if (data.length > LIMITS.rows) return { ok: false, error: `The sheet has ${data.length} rows. An event can import up to ${LIMITS.rows}.` };
  const cell = (r, id) => (idx[id] === undefined ? '' : String(r[idx[id]] ?? ''));
  const notes = [];
  const layout = perTeam ? 'teams' : 'players';
  const draft = { layout, teams: [], loose: [], notes };
  const player = (r, nameId, duprId, line) => { const name = cleanText(cell(r, nameId)), dupr = squashDupr(cell(r, duprId)); return name || dupr ? { name, dupr, line } : null; };
  if (perTeam) {
    if (idx.dupr !== undefined) notes.push('A DUPR ID column was ignored. With one row per team, use DUPR ID 1 and DUPR ID 2.');
    data.forEach((r, i) => {
      const line = i + 2, name = cleanText(cell(r, 'team')), logo = squashLogo(cell(r, 'logo'));
      const players = [player(r, 'p1', 'dupr1', line), player(r, 'p2', 'dupr2', line)].filter(Boolean);
      if (!name && !players.length && !logo) return;
      draft.teams.push({ name, logo, line, players });
    });
  } else {
    const byTeam = new Map();
    data.forEach((r, i) => {
      const line = i + 2, p = player(r, 'player', 'dupr', line), tn = cleanText(cell(r, 'team')), logo = squashLogo(cell(r, 'logo'));
      if (!p && !tn && !logo) return;
      const pl = p || { name: '', dupr: '', line };
      if (!tn) { draft.loose.push(pl); if (logo) notes.push(`Row ${line} has a logo but no team, so the logo was left out.`); return; }
      let t = byTeam.get(tn.toLowerCase());
      if (!t) { t = { name: tn, logo: '', line, players: [] }; byTeam.set(tn.toLowerCase(), t); draft.teams.push(t); }
      t.players.push(pl);
      if (logo) {
        if (!t.logo) t.logo = logo;
        else if (t.logo !== logo) notes.push(`${t.name} has different logos in different rows. The first one was used.`);
      }
    });
  }
  if (!draft.teams.length && !draft.loose.length) return { ok: false, error: 'The sheet has no players in it.' };
  const found = Object.keys(idx).map(id => COLUMNS[id].label);
  return { ok: true, layout, found, draft };
}
const squashDupr = v => String(v ?? '').replace(JUNK, '').trim().toUpperCase();
const squashLogo = v => String(v ?? '').replace(JUNK, '').trim();

// ---- Checking a draft (what the preview shows next to each row; the API runs it again).
// opts: { format, partners } as in the new-event form. Returns { ok, errors: [{ at, msg }], warnings: [{ at, msg }], usesTeams, players, teams }.
// at: 'g' (the whole sheet), 't3' (team 3), 't3p1' (player 1 of team 3), 'l2' (loose player 2), indexes from 0.
export function allPlayers(draft) { return [...draft.teams.flatMap(t => t.players), ...draft.loose]; }

export function validate(draft, opts = {}) {
  const format = opts.format || 'roundrobin';
  const elim = format === 'single_elim' || format === 'double_elim';
  const fixed = elim || opts.partners === 'fixed';
  const usesTeams = fixed && draft.teams.length > 0;
  const errors = [], warnings = [];
  const err = (at, msg) => errors.push({ at, msg }), warn = (at, msg) => warnings.push({ at, msg });
  const seen = new Map(), duprSeen = new Map(), teamNames = new Map();
  const checkPlayer = (p, at) => {
    if (!p.name) err(at, 'Missing player name.');
    else if (p.name.length > LIMITS.name) err(at, `The name is too long (${LIMITS.name} characters at most).`);
    else {
      const k = p.name.toLowerCase();
      if (seen.has(k)) err(at, `${p.name} is already in this sheet (row ${seen.get(k)}). Each player can only be listed once.`);
      else seen.set(k, p.line);
    }
    const d = cleanDupr(p.dupr);
    if (d.error) err(at, d.error);
    else if (d.value) { if (duprSeen.has(d.value)) warn(at, `The DUPR ID ${d.value} is also used on row ${duprSeen.get(d.value)}.`); else duprSeen.set(d.value, p.line); }
  };
  draft.teams.forEach((t, i) => {
    const at = 't' + i;
    if (usesTeams) {
      if (!t.name) warn(at, 'This team has no name, so the app will show its players instead.');
      else if (t.name.length > LIMITS.name) err(at, `The team name is too long (${LIMITS.name} characters at most).`);
      else if (teamNames.has(t.name.toLowerCase())) warn(at, `Another team is also called ${t.name}.`); else teamNames.set(t.name.toLowerCase(), i);
      const l = cleanLogoUrl(t.logo);
      if (l.error) err(at, l.error);
      if (t.players.length !== 2) err(at, t.players.length === 0 ? 'This team has no players.' : `This team has ${t.players.length} player${t.players.length === 1 ? '' : 's'}. Doubles teams need exactly 2.`);
    }
    t.players.forEach((p, j) => checkPlayer(p, `${at}p${j}`));
  });
  draft.loose.forEach((p, j) => {
    checkPlayer(p, 'l' + j);
    if (usesTeams) err('l' + j, 'This player has no team. Add a team name for the row or remove it.');
  });
  const players = allPlayers(draft).filter(p => p.name);
  const n = players.length;
  if (n < 4) err('g', 'An event needs at least 4 players for doubles.');
  if (n > LIMITS.players) err('g', `An event holds at most ${LIMITS.players} players. This sheet has ${n}.`);
  if (fixed && n % 2 && !usesTeams) err('g', 'Fixed teams need an even number of players.');
  if (usesTeams) {
    const need = format === 'double_elim' ? 3 : format === 'pool_knockout' ? 4 : 2;
    if (draft.teams.length < need) err('g', `${format === 'double_elim' ? 'Double elimination' : format === 'pool_knockout' ? 'Pool play and knockout' : 'This format'} needs at least ${need} teams. This sheet has ${draft.teams.length}.`);
  } else if (format === 'pool_knockout' && n < 8) err('g', 'Pool play and knockout needs at least 8 players.');
  if (format === 'double_elim' && !usesTeams && n < 6) err('g', 'Double elimination needs at least 6 players (3 teams).');
  return { ok: errors.length === 0, errors, warnings, usesTeams, players, teams: usesTeams ? draft.teams : [] };
}

// What to send to the API: players in sheet order and, when the sheet's teams apply, the teams (and their names and logos)
// in the same order. refs: { player name: DUPR ID }, kept apart from the event itself.
export function toEventInput(draft, opts = {}) {
  const v = validate(draft, opts);
  const refs = {};
  for (const p of v.players) { const d = cleanDupr(p.dupr).value; if (d) refs[p.name] = d; }
  if (v.usesTeams) {
    return { players: draft.teams.flatMap(t => t.players.map(p => p.name)), teams: draft.teams.map(t => t.players.map(p => p.name)),
      teamMeta: draft.teams.map(t => ({ name: t.name, logo: cleanLogoUrl(t.logo).value })), rotation: 'manual', refs };
  }
  return { players: v.players.map(p => p.name), refs };
}
