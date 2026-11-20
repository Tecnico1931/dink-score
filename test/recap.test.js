import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load both DR and YearRecap straight from the built dink-score.html so the app's copy is tested directly with zero app globals.
const html = readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const DR = new Function(html.match(/const DR = \(\(\) => \{[\s\S]*?\n\}\)\(\);/)[0].replace('const DR =', 'return'))();
const YearRecap = new Function(html.match(/\/\*YEARRECAP-START\*\/([\s\S]*?)\/\*YEARRECAP-END\*\//)[1] + '\nreturn YearRecap;')();

let seq = 0;
const at = (y, m = 6, d = 15, h = 12) => new Date(y, m - 1, d, h).getTime();
const game = (teams, score, endedAt, extra = {}) => ({
  id: 'g' + (++seq),
  mode: teams[0].length === 1 ? 'singles' : 'doubles',
  teams,
  score,
  winner: score[0] > score[1] ? 0 : 1,
  endedAt,
  ...extra
});

test('computes games, wins/losses, win rate, peak rating, favourite partner and biggest rival for a year', () => {
  const games = [
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [11, 5], at(2026, 2, 1)),   // W w/ Ben vs Cal, Dee
    game([['Ana', 'Ben'], ['Cal', 'Ed']], [11, 7], at(2026, 3, 1)),    // W w/ Ben vs Cal, Ed
    game([['Ana', 'Ben'], ['Cal', 'Fay']], [8, 11], at(2026, 4, 1)),   // L w/ Ben vs Cal, Fay
    game([['Ana', 'Gus'], ['Cal', 'Hal']], [11, 4], at(2026, 5, 1)),   // W w/ Gus vs Cal, Hal
    game([['Ana'], ['Cal']], [6, 11], at(2026, 6, 1))                  // L singles vs Cal
  ];
  const r = YearRecap.compute(DR, 'Ana', games, 2026);
  assert.equal(r.name, 'Ana');
  assert.equal(r.year, 2026);
  assert.deepEqual(r.years, [2026]);
  assert.equal(r.games, 5);
  assert.equal(r.wins, 3);
  assert.equal(r.losses, 2);
  assert.equal(r.winRate, 60);
  assert.equal(r.doublesGames, 4);
  assert.equal(r.singlesGames, 1);
  assert.equal(r.pointsFor, 11 + 11 + 8 + 11 + 6);
  assert.equal(r.pointsAgainst, 5 + 7 + 11 + 4 + 11);

  // Peak rating matches max post-game rating achieved in 2026
  const { after } = DR.compute(games);
  const expectedPeak = Math.max(...games.map(g => after[g.id].ana));
  assert.equal(r.bestRating, expectedPeak);
  assert.equal(r.bestRatingMode, 'doubles');

  // Favourite partner: Ben (3 doubles games, 2 wins) over Gus (1 game)
  assert.equal(r.favouritePartner.name, 'Ben');
  assert.equal(r.favouritePartner.games, 3);
  assert.equal(r.favouritePartner.wins, 2);
  assert.equal(r.favouritePartner.losses, 1);
  assert.equal(r.favouritePartner.winRate, 67);

  // Biggest rival: Cal (all 5 games, 3-2)
  assert.equal(r.biggestRival.name, 'Cal');
  assert.equal(r.biggestRival.games, 5);
  assert.equal(r.biggestRival.wins, 3);
  assert.equal(r.biggestRival.losses, 2);
  assert.equal(r.biggestRival.winRate, 60);
});

test('defaults to most recent year with games and separates years cleanly while keeping rating continuity', () => {
  const y2025 = [
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [11, 2], at(2025, 4, 1)),
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [11, 2], at(2025, 5, 1)),
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [11, 2], at(2025, 6, 1)),
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [3, 11], at(2025, 11, 1)),
    game([['Ana', 'Ben'], ['Cal', 'Dee']], [3, 11], at(2025, 12, 1))
  ];
  const y2026 = [
    game([['Ana', 'Gus'], ['Hal', 'Ivy']], [11, 9], at(2026, 2, 1)),
    game([['Ana', 'Gus'], ['Hal', 'Ivy']], [9, 11], at(2026, 3, 1))
  ];
  const all = [...y2025, ...y2026];
  const { after } = DR.compute(all);

  // Default year is 2026
  const r26 = YearRecap.compute(DR, 'Ana', all);
  assert.equal(r26.year, 2026);
  assert.deepEqual(r26.years, [2026, 2025]);
  assert.equal(r26.games, 2);
  assert.equal(r26.wins, 1);
  assert.equal(r26.favouritePartner.name, 'Gus');
  assert.equal(r26.biggestRival.name, 'Hal');
  // Peak rating in 2026 uses full-history continuity, not 2025's peak and not resetting to 2.00
  const peak25 = Math.max(...y2025.map(g => after[g.id].ana));
  const peak26 = Math.max(...y2026.map(g => after[g.id].ana));
  assert.ok(peak25 > peak26, '2025 peak was higher than 2026 peak');
  assert.equal(r26.bestRating, peak26);
  const isolated26 = Math.max(...y2026.map(g => DR.compute(y2026).after[g.id].ana));
  assert.notEqual(r26.bestRating, isolated26, '2026 rating carries over from 2025');

  // Switching to 2025 shows 2025 stats and peak
  const r25 = YearRecap.compute(DR, 'Ana', all, 2025);
  assert.equal(r25.year, 2025);
  assert.equal(r25.games, 5);
  assert.equal(r25.wins, 3);
  assert.equal(r25.bestRating, peak25);
  assert.equal(r25.favouritePartner.name, 'Ben');
});

test('partner tie-breakers: games together, then wins together, then recency, then alphabetical', () => {
  // Tie on games (2 each), Ben has 2 wins vs Gus 1 win -> Ben wins
  const g1 = [
    game([['Ana', 'Gus'], ['X', 'Y']], [11, 5], at(2026, 1, 1)),
    game([['Ana', 'Gus'], ['X', 'Y']], [5, 11], at(2026, 5, 1)),
    game([['Ana', 'Ben'], ['X', 'Y']], [11, 5], at(2026, 2, 1)),
    game([['Ana', 'Ben'], ['X', 'Y']], [11, 5], at(2026, 3, 1))
  ];
  assert.equal(YearRecap.compute(DR, 'Ana', g1, 2026).favouritePartner.name, 'Ben');

  // Tie on games (1 each) and wins (1 each): more recent wins
  const g2 = [
    game([['Ana', 'Ben'], ['X', 'Y']], [11, 5], at(2026, 2, 1)),
    game([['Ana', 'Gus'], ['X', 'Y']], [11, 5], at(2026, 9, 1))
  ];
  assert.equal(YearRecap.compute(DR, 'Ana', g2, 2026).favouritePartner.name, 'Gus');

  // Tie on games, wins, and exact timestamp: alphabetical
  const sameTs = at(2026, 6, 1);
  const g3 = [
    game([['Ana', 'Zed'], ['X', 'Y']], [11, 5], sameTs),
    game([['Ana', 'Al'], ['X', 'Y']], [11, 5], sameTs)
  ];
  assert.equal(YearRecap.compute(DR, 'Ana', g3, 2026).favouritePartner.name, 'Al');
});

test('rival tie-breakers: games against, then closer head-to-head, then recency, then alphabetical', () => {
  // Both Cal and Dee played Ana twice; Cal is 1-1 (margin 0), Dee is 2-0 (margin 2) -> Cal wins
  const g1 = [
    game([['Ana'], ['Dee']], [11, 4], at(2026, 4, 1)),
    game([['Ana'], ['Dee']], [11, 4], at(2026, 5, 1)),
    game([['Ana'], ['Cal']], [11, 8], at(2026, 1, 1)),
    game([['Ana'], ['Cal']], [8, 11], at(2026, 2, 1))
  ];
  const r1 = YearRecap.compute(DR, 'Ana', g1, 2026);
  assert.equal(r1.biggestRival.name, 'Cal');
  assert.equal(r1.biggestRival.wins, 1);
  assert.equal(r1.biggestRival.losses, 1);

  // Tie on games and margin -> more recent wins
  const g2 = [
    game([['Ana'], ['Cal']], [11, 8], at(2026, 1, 1)),
    game([['Ana'], ['Dee']], [11, 8], at(2026, 8, 1))
  ];
  assert.equal(YearRecap.compute(DR, 'Ana', g2, 2026).biggestRival.name, 'Dee');
});

test('singles-only player has no favourite partner, valid rival and singles peak rating', () => {
  const games = [
    game([['Ana'], ['Ben']], [11, 7], at(2026, 3, 1)),
    game([['Ana'], ['Ben']], [11, 9], at(2026, 3, 2)),
    game([['Ana'], ['Cal']], [7, 11], at(2026, 3, 3))
  ];
  const r = YearRecap.compute(DR, 'Ana', games, 2026);
  assert.equal(r.games, 3);
  assert.equal(r.singlesGames, 3);
  assert.equal(r.doublesGames, 0);
  assert.equal(r.favouritePartner, null);
  assert.equal(r.biggestRival.name, 'Ben');
  assert.equal(r.biggestRival.wins, 2);
  assert.equal(r.biggestRival.losses, 0);
  assert.equal(r.bestRatingMode, 'singles');
  assert.ok(r.bestRating > DR.START);
});

test('ignores held games, default player names for partner/rival, and normalizes accents/case', () => {
  const games = [
    game([['Zoé', 'Player 2'], ['Player 3', 'Player 4']], [11, 3], at(2026, 1, 1)),
    game([['  zoe\u0301 ', 'Ben'], ['Cal', 'Dee']], [11, 6], at(2026, 2, 1)),
    game([['Zoé', 'Gus'], ['Hal', 'Ivy']], [11, 0], at(2026, 3, 1), { hold: true }),
    game([['Zoé', 'Gus'], ['Hal', 'Ivy']], [11, 0], at(2026, 3, 2), { hold: true })
  ];
  const r = YearRecap.compute(DR, 'Zoé', games, 2026);
  assert.equal(r.games, 2, 'held games excluded');
  assert.equal(r.wins, 2);
  assert.equal(r.favouritePartner.name, 'Ben', 'Player 2 and held Gus excluded');
  assert.equal(r.favouritePartner.games, 1);
  assert.equal(r.biggestRival.name, 'Cal', 'Player 3/4 and held Hal/Ivy excluded');
  // Peak rating matches rated-only DR computation
  const expected = Math.max(...games.filter(g => !g.hold).map(g => DR.compute(games.filter(x => !x.hold)).after[g.id][DR.key('Zoé')]));
  assert.equal(r.bestRating, expected);
});

test('handles empty game list and years with no games gracefully', () => {
  assert.deepEqual(YearRecap.years(DR, 'Ana', []), []);
  const empty = YearRecap.compute(DR, 'Ana', [], 2026);
  assert.equal(empty.games, 0);
  assert.equal(empty.wins, 0);
  assert.equal(empty.losses, 0);
  assert.equal(empty.winRate, 0);
  assert.equal(empty.bestRating, null);
  assert.equal(empty.favouritePartner, null);
  assert.equal(empty.biggestRival, null);

  const otherYear = YearRecap.compute(DR, 'Ana', [game([['Ana'], ['Ben']], [11, 5], at(2025, 5, 1))], 2026);
  assert.equal(otherYear.games, 0);
  assert.deepEqual(otherYear.years, [2025]);
  assert.equal(otherYear.bestRating, null);
});

test('year-in-review UI and share image are wired without exposing club codes or tokens', () => {
  assert.ok(html.includes('/*MODULE-START:year-recap*/'), 'year-recap module block is present');
  assert.ok(html.includes('data-act="recap-open"'), 'profile recap CTA action is wired');
  assert.ok(html.includes('data-act="recap-share"'), 'recap share action is wired');
  assert.ok(html.includes('function drawRecapCard('), 'share-image canvas draws recap card');
  assert.ok(html.includes('function openRecapShare('), 'recap opens shared sheet flow');
  // Check recapCardData never copies club.code, pins, or tokens
  const fn = html.match(/function recapCardData\([\s\S]*?\n\}/)[0];
  assert.ok(!/club\.code|pin|token|dupr/i.test(fn), 'recapCardData stays free of club codes, pins, tokens and DUPR ids');
});
