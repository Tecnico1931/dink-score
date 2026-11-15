// Team building, round robin schedules and standings for events. Pure functions, no database.
import { makeRng, shuffle } from './_rotation.js';

const bad = msg => Object.assign(new Error(msg), { status: 400 });

// Fixed doubles teams from a list of players.
//   manual  the organizer's own pairs (checked)
//   random  a seeded draw
//   auto    strongest with weakest, so teams come out even; ratings is an optional { name: rating } map
//           (players without one count as the lowest). Without ratings the list order is the ranking.
// Teams come back strongest first, which is the order a bracket seeds them in.
export function pairTeams(players, { how = 'random', seed = 'seed', ratings = null, teams = null } = {}) {
  if (players.length < 4 || players.length % 2) throw bad('Fixed teams need an even number of players, at least 4.');
  const key = new Map(players.map(p => [p.toLowerCase(), p]));
  if (how === 'manual') {
    const seen = new Set();
    const out = (Array.isArray(teams) ? teams : []).map(t => {
      if (!Array.isArray(t) || t.length !== 2) throw bad('Every team needs two players.');
      return t.map(name => {
        const p = key.get(String(name ?? '').trim().toLowerCase());
        if (!p) throw bad(`${String(name).slice(0, 40)} is not in this event.`);
        if (seen.has(p)) throw bad(`${p} is on more than one team.`);
        seen.add(p);
        return p;
      });
    });
    if (seen.size !== players.length) throw bad('Put every player on a team.');
    return out;
  }
  if (how === 'random') {
    const order = shuffle(players, makeRng(`${seed}|teams`));
    return Array.from({ length: order.length / 2 }, (_, i) => [order[2 * i], order[2 * i + 1]]);
  }
  const rating = p => (ratings && Number.isFinite(Number(ratings[p])) ? Number(ratings[p]) : -Infinity);
  const ranked = players.map((p, i) => ({ p, i })).sort((a, b) => rating(b.p) - rating(a.p) || a.i - b.i).map(x => x.p);
  const teamsOut = Array.from({ length: ranked.length / 2 }, (_, i) => [ranked[i], ranked[ranked.length - 1 - i]]);
  return teamsOut;
}

// Round robin for fixed teams by the circle method: every team plays every other once. 'count' is the number of teams.
// Each round is a list of [teamA, teamB] index pairs, split so a round never has more matches than there are courts.
export function roundRobin(count, courts = 1) {
  const ids = Array.from({ length: count }, (_, i) => i);
  if (count % 2) ids.push(-1); // a rest slot
  const m = ids.length, rest = ids.slice(1), out = [];
  for (let r = 0; r < m - 1; r++) {
    const row = [ids[0], ...rest];
    const pairs = [];
    for (let i = 0; i < m / 2; i++) {
      const a = row[i], b = row[m - 1 - i];
      if (a >= 0 && b >= 0) pairs.push(r % 2 ? [b, a] : [a, b]); // alternate sides so no team is always "first"
    }
    for (let k = 0; k < pairs.length; k += Math.max(1, courts)) out.push(pairs.slice(k, k + Math.max(1, courts)));
    rest.unshift(rest.pop());
  }
  return out;
}

// Standings from finished matches. 'rows' lists everyone who should appear (so players with no games yet show up).
// matches: [{ teams: [[names], [names]], score: [a, b] | null }]. Only matches with a score count.
// Ranked by wins, then point differential, then points scored, then name; the last two keep the order stable.
export function standings(rows, matches, { by = 'player' } = {}) {
  const id = names => (by === 'team' ? names.slice().sort((a, b) => a.localeCompare(b)).join(' & ') : null);
  const table = new Map(rows.map(r => [typeof r === 'string' ? r : r.id, { id: typeof r === 'string' ? r : r.id, name: typeof r === 'string' ? r : r.name || r.id, played: 0, wins: 0, losses: 0, pf: 0, pa: 0 }]));
  for (const m of matches) {
    if (!m || !m.score || !m.teams) continue;
    m.teams.forEach((team, t) => {
      const mine = m.score[t], theirs = m.score[1 - t];
      for (const who of by === 'team' ? [id(team)] : team) {
        const row = table.get(who);
        if (!row) continue;
        row.played++; row.pf += mine; row.pa += theirs;
        if (mine > theirs) row.wins++; else row.losses++;
      }
    });
  }
  const list = [...table.values()].map(r => ({ ...r, diff: r.pf - r.pa }));
  list.sort((a, b) => b.wins - a.wins || b.diff - a.diff || b.pf - a.pf || a.name.localeCompare(b.name));
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

export const teamId = names => names.slice().sort((a, b) => a.localeCompare(b)).join(' & ');
