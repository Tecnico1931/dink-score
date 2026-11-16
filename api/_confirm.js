// Pure rules for game confirmation and duplicate detection (no database), so `npm test` covers them without an install.
// A game is "confirmed" when a player on the other team, or an organizer, has vouched for the result.

export const DUP_WINDOW_MS = 45 * 60 * 1000; // two records of one game are normally minutes apart; a logged one may be typed in later

const key = n => String(n).trim().toLowerCase();

// Whether a game counts toward ratings, achievements, challenges and seasons. With the club setting off everything
// counts, as before. With it on a game needs a confirmation. Event matches are run by an organizer, so they count.
export const counts = (game, required) => !required || !!game.confirmed || !!game.event;

// Why `who` (a verified player's name key) may not confirm this game, or null when they may.
// The game's own scorer can't vouch for it, and neither can their teammate: the confirmation has to come from the other side.
export function confirmBlocker(game, who) {
  const me = key(who || '');
  const side = game.teams.findIndex(t => t.some(n => key(n) === me));
  if (!me || side < 0) return 'Only a player in this game, or an organizer, can confirm it.';
  const scorer = game.scoredBy && game.scoredBy !== 'organizer' ? game.scoredBy : null;
  if (scorer && scorer === me) return 'You recorded this game, so someone on the other team (or an organizer) needs to confirm it.';
  const scorerSide = scorer ? game.teams.findIndex(t => t.some(n => key(n) === scorer)) : -1;
  if (scorerSide >= 0 && scorerSide === side) return 'Someone on the other team (or an organizer) needs to confirm this game.';
  return null;
}

// One string per result: the two teams (each sorted) in sorted order, each with its score. The same four players with the
// same score give the same string whichever side was entered first.
function signature(g) {
  const sides = g.teams.map((t, i) => [t.map(key).sort().join('+'), g.score[i]]);
  sides.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return (g.mode === 'singles' ? 's' : 'd') + '|' + sides.map(s => s.join('=')).join('|');
}

// Pairs of games that look like one game recorded twice (scored live on one phone and logged on another, say):
// same players, same score, finished within the window. Games an organizer has marked "keep both" are left out.
export function findDuplicates(games, windowMs = DUP_WINDOW_MS) {
  const groups = new Map();
  for (const g of games) {
    if (g.dupOk) continue;
    const s = signature(g);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(g);
  }
  const pairs = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.endedAt - b.endedAt);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].endedAt - list[i].endedAt <= windowMs; j++) pairs.push([list[i].id, list[j].id]);
  }
  return pairs;
}
