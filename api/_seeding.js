// Event seeding and divisions from Dink Rating. Pure (no database). The ratings come from the server's own engine (api/_rating.js,
// stored by _rating_store.js) and never from the phone, and DUPR never feeds them. A player with no games yet counts as START.
import { START, key } from './_rating.js';
import { cleanName } from './_names.js';

const bad = msg => Object.assign(new Error(msg), { status: 400 });
export const MAX_DIVISIONS = 4;
const round2 = n => Math.round(n * 100) / 100;

// { name: doubles rating } for these names, from the club answer's `players.doubles` (ratingsFor in _rating_store.js).
export function ratingMap(stored, names) {
  const t = (stored && stored.players && stored.players.doubles) || {};
  const out = {};
  for (const n of names) { const p = t[key(cleanName(n))]; out[n] = p ? p.rating : START; }
  return out;
}

const avg = (team, ratings) => team.reduce((s, p) => s + (Number.isFinite(ratings[p]) ? ratings[p] : START), 0) / team.length;

// Teams strongest first by the average of their two ratings (ties keep the given order), so a bracket's seed 1 is the best team.
// Returns the sorted teams and each team's rating, for showing next to the seed.
export function seedTeams(teams, ratings) {
  const rows = teams.map((t, i) => ({ t, i, r: avg(t, ratings) })).sort((a, b) => b.r - a.r || a.i - b.i);
  return { teams: rows.map(x => x.t), seeds: rows.map(x => round2(x.r)) };
}

export const divisionLabel = i => `Division ${String.fromCharCode(65 + i)}`;

// Splits players into `count` divisions by rating, the strongest players in Division A. Sizes are as even as possible; with fixed
// teams every division gets an even number of players. Returns [{ label, players: [names, strongest first], ratings: [numbers] }].
export function splitDivisions(players, ratings, count, { fixed = false } = {}) {
  const k = Math.trunc(Number(count));
  if (!(k >= 2 && k <= MAX_DIVISIONS)) throw bad(`Pick 2 to ${MAX_DIVISIONS} divisions.`);
  if (fixed && players.length % 2) throw bad('Fixed teams need an even number of players.');
  const unit = fixed ? 2 : 1, units = players.length / unit;
  if (units < Math.ceil(4 / unit) * k) throw bad(`${players.length} players are too few for ${k} divisions: each needs at least 4.`);
  const ranked = players.map((p, i) => ({ p, i, r: Number.isFinite(ratings[p]) ? ratings[p] : START })).sort((a, b) => b.r - a.r || a.i - b.i);
  const out = [];
  let at = 0;
  for (let d = 0; d < k; d++) {
    const size = (Math.floor(units / k) + (d < units % k ? 1 : 0)) * unit;
    const part = ranked.slice(at, at + size);
    at += size;
    out.push({ label: divisionLabel(d), players: part.map(x => x.p), ratings: part.map(x => round2(x.r)) });
  }
  return out;
}

// The create inputs for an event split into divisions: one event per division, each seeded by rating, named "<name> · Division A".
// A sheet import and hand-picked teams are the organizer's own grouping, so they cannot be split.
export function divisionInputs(input, ratings, now = Date.now()) {
  const fixed = input.partners === 'fixed' || input.format === 'single_elim' || input.format === 'double_elim';
  if (input.teams || input.teamMeta || input.refs || (fixed && input.rotation === 'manual')) throw bad('Divisions need teams the app forms (Balanced or Random draw), not hand-picked teams or a sheet import.');
  const names = [], seen = new Set();
  for (const raw of Array.isArray(input.players) ? input.players : []) {
    const p = cleanName(raw);
    if (p && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); names.push(p); }
  }
  const base = cleanName(input.name);
  return splitDivisions(names, ratings, input.divisions, { fixed }).map((d, i, all) => ({
    ...input, divisions: undefined, seeding: 'rating', ratings, players: d.players,
    name: base ? cleanName(`${base.slice(0, 40 - d.label.length - 3)} · ${d.label}`) : '', seed: `${input.seed || now}|${i}`,
    division: { n: i + 1, of: all.length, label: d.label }
  }));
}
