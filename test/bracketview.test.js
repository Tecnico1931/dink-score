import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEvent, recordResult, view } from '../api/_events.js';

// The drawing code lives inline in dink-score.html (so the app stays one file); load just that block.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dink-score.html'), 'utf8');
const block = src.match(/\/\*BRACKETVIEW-START\*\/([\s\S]*?)\/\*BRACKETVIEW-END\*\//);
assert.ok(block, 'the BRACKETVIEW block is missing from dink-score.html');
const BK = new Function(block[1] + '\nreturn BK;')();

const NOW = Date.UTC(2026, 5, 1, 12);
const players = n => Array.from({ length: n }, (_, i) => 'P' + (i + 1));
const make = (format, n, extra = {}) => createEvent({ name: 'Cup', format, rotation: 'auto', courts: 2, players: players(n), seed: 'x', ...extra }, NOW);
const play = (ev, score = [11, 4]) => { const m = ev.bracket.matches.find(x => x.status === 'pending' && x.slots.every(s => s >= 0)); recordResult(ev, m.id, { score }, NOW); return m.id; };
const sorted = a => a.slice().sort((p, q) => p - q);

function assertSane(L) {
  const ids = new Set(L.nodes.map(n => n.id));
  for (const n of L.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= L.width && n.y + n.h <= L.height, `${n.id} is inside the canvas`);
  }
  // No two cards overlap.
  for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) {
    const a = L.nodes[i], b = L.nodes[j];
    const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    assert.ok(apart, `${a.id} and ${b.id} overlap`);
  }
  for (const l of L.links) assert.ok(ids.has(l.from) && ids.has(l.to), `link ${l.from} -> ${l.to} joins drawn cards`);
  for (const h of L.headers) assert.ok(h.x >= 0 && h.y >= 0 && h.x + h.w <= L.width);
}

test('8 team single elimination: one column per round, each match halfway between its feeders, a champion at the end', () => {
  const v = view(make('single_elim', 16)); // 16 players = 8 teams
  const L = BK.layout(v.tree);
  assertSane(L);
  const cols = [...new Set(L.nodes.map(n => n.col))];
  assert.deepEqual(sorted(cols), [0, 1, 2, 3]); // quarterfinals, semifinals, final, champion
  assert.deepEqual(L.headers.map(h => h.title), ['Quarterfinals', 'Semifinals', 'Final', 'Champion']);
  const n = id => L.nodes.find(x => x.id === id);
  const mid = (a, b) => (n(a).y + n(b).y) / 2;
  assert.equal(n('W2-0').y, mid('W1-0', 'W1-1'));
  assert.equal(n('W2-1').y, mid('W1-2', 'W1-3'));
  assert.equal(n('W3-0').y, mid('W2-0', 'W2-1'));
  assert.equal(n('champion').y, n('W3-0').y);
  assert.equal(L.links.length, 7); // every match leads somewhere
  assert.ok(L.links.every(l => !l.done));
  assert.equal(L.snaps.length, 4);
});

test('links turn solid once a match is played, and a played final leads to the champion', () => {
  const ev = make('single_elim', 8); // 4 teams
  const first = play(ev);
  let L = BK.layout(view(ev).tree);
  assert.equal(L.links.find(l => l.from === first).done, true);
  assert.equal(L.links.filter(l => l.done).length, 1);
  play(ev); play(ev);
  L = BK.layout(view(ev).tree);
  assert.ok(L.links.every(l => l.done));
  assert.equal(L.links.find(l => l.to === 'champion').from, 'W2-0');
});

test('5 team double elimination: byes are drawn, double-bye matches are not, nothing overlaps', () => {
  const ev = make('double_elim', 10);
  assert.equal(ev.teams.length, 5);
  const v = view(ev);
  const L = BK.layout(v.tree);
  assertSane(L);
  const byes = L.nodes.filter(n => n.kind === 'match' && n.m.status === 'bye');
  assert.ok(byes.length >= 3, 'the three top seeds skip round one');
  for (const b of byes) assert.ok(b.m.teams.some(Boolean), 'a bye card names the team that moves on');
  assert.ok(!L.nodes.some(n => n.kind === 'match' && n.m.slots[0] === -1 && n.m.slots[1] === -1));
  assert.ok(L.nodes.some(n => n.id === 'F1'));
  assert.ok(L.nodes.some(n => n.id === 'F2'), 'the reset match is shown, marked as only if needed');
  assert.ok(BK.bracketHTML(v, {}).includes('Only if the losers team wins'));
  // Once the winners bracket finalist wins the grand final, the reset match is dropped and the final leads to the champion.
  for (let g = 0; g < 20 && ev.bracket.matches.find(m => m.id === 'F1').status !== 'done'; g++) play(ev);
  const L2 = BK.layout(view(ev).tree);
  assert.ok(!L2.nodes.some(n => n.id === 'F2'));
  assert.equal(L2.links.find(l => l.from === 'F1').to, 'champion');
  // The losers bracket sits under the winners bracket, the grand final to the right of both.
  const lowest = Math.max(...L.nodes.filter(n => n.id.startsWith('W')).map(n => n.y + n.h));
  assert.ok(L.nodes.filter(n => n.id.startsWith('L')).every(n => n.y > lowest));
  const widest = Math.max(...L.nodes.filter(n => /^[WL]/.test(n.id)).map(n => n.x + n.w));
  assert.ok(L.nodes.find(n => n.id === 'F1').x >= widest);
  // Both finalists feed the grand final.
  assert.equal(L.links.filter(l => l.to === 'F1').length, 2);
  for (const n of L.nodes.filter(n => n.kind === 'match')) assert.ok(n.feed && n.feed.win, `${n.id} says where its winner goes`);
});

test('the reset match appears when the losers bracket champion wins the grand final', () => {
  const ev = make('double_elim', 6); // 3 teams
  for (let g = 0; g < 20 && ev.bracket.matches.find(m => m.id === 'F1').status !== 'done'; g++) {
    const m = ev.bracket.matches.find(x => x.status === 'pending' && x.slots.every(s => s >= 0));
    recordResult(ev, m.id, { score: m.id === 'F1' ? [3, 11] : [11, 3] }, NOW);
  }
  const L = BK.layout(view(ev).tree);
  assertSane(L);
  assert.ok(L.nodes.some(n => n.id === 'F2'));
  assert.equal(L.links.find(l => l.from === 'F1').to, 'F2');
  assert.equal(L.links.find(l => l.from === 'F2').to, 'champion');
});

test('layout sizes work for every team count up to 16 in both elimination formats', () => {
  for (const format of ['single_elim', 'double_elim']) for (let teams = format === 'double_elim' ? 3 : 2; teams <= 16; teams++) {
    const ev = make(format, teams * 2);
    for (let k = 0; k < 4; k++) { try { play(ev); } catch { break; } }
    assertSane(BK.layout(view(ev).tree));
  }
});

test('scale: phones scroll round by round, laptops fit, a TV fills the screen', () => {
  const w = 1104, h = 560;
  assert.deepEqual(BK.scale({ cw: 328, w, h }), { s: 1, scroll: true });
  assert.deepEqual(BK.scale({ cw: 740, w, h }), { s: 1, scroll: true });
  const lap = BK.scale({ cw: 1200, w, h });
  assert.equal(lap.scroll, false); assert.ok(lap.s > 1 && lap.s <= 1.35);
  const tv = BK.scale({ cw: 1840, ch: 900, w, h, tv: true, max: 3 });
  assert.equal(tv.scroll, false); assert.ok(Math.abs(tv.s - Math.min(1840 / w, 900 / h)) < 1e-9);
  // Too tall for one TV screen: fit the width instead of shrinking the text.
  const tall = BK.scale({ cw: 1840, ch: 900, w: 1104, h: 2600, tv: true, max: 3 });
  assert.equal(tall.scroll, false); assert.ok(Math.abs(tall.s - 1840 / 1104) < 1e-9);
  // Text never goes below 93% of its size without scrolling.
  for (let cw = 200; cw < 2500; cw += 50) { const r = BK.scale({ cw, w, h }); assert.ok(r.scroll ? r.s === 1 : r.s >= 0.93); }
});

test('the markup labels every match, marks winners in words, and only the app gets buttons', () => {
  const ev = make('single_elim', 8);
  play(ev, [11, 7]);
  const v = view(ev);
  const html = BK.bracketHTML(v, { interactive: true, sel: 'W1-1' });
  const cards = html.match(/<button[^>]*class="bk-card[^"]*"[^>]*>/g);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(c => /aria-label="[^"]+versus[^"]+"/.test(c) && /data-m="/.test(c)));
  assert.ok(/aria-pressed="true"/.test(cards.join('')));
  assert.ok(html.includes(', winner</span>'), 'the winner is stated in text, not only by colour');
  assert.ok(/Final, 11 to 7/.test(html));
  assert.ok(/role="region" aria-label="Bracket, one column per round"/.test(html));
  const pub = BK.bracketHTML(v, {});
  assert.ok(!/<button/.test(pub) && !/data-ev=/.test(pub), 'the public bracket has nothing to press');
  assert.ok(/aria-label="Champion, to be decided"/.test(pub));
});

test('a queued, not yet saved score shows on its card', () => {
  const v = view(make('single_elim', 8));
  const html = BK.bracketHTML(v, { interactive: true, scoreOf: m => (m.id === 'W1-0' ? [11, 2] : m.score), saving: m => m.id === 'W1-0' });
  assert.ok(html.includes('Saving…'));
  assert.ok(html.includes('Final, 11 to 2'));
});

test('pool standings mark who advances', () => {
  const ev = make('pool_knockout', 8, { rounds: 3, advance: 2 });
  const v = view(ev);
  const html = BK.standingsHTML(v);
  assert.equal((html.match(/Advances/g) || []).length, 4); // top 2 teams = top 4 players (rotating partners)
  assert.ok(/class="cut"/.test(html));
  assert.equal((BK.standingsHTML(view(make('roundrobin', 8))).match(/Advances/g) || []).length, 0);
});

test('every line of text in the markup uses a readable size', () => {
  const css = src.match(/\/\*BRACKET-CSS-START\*\/([\s\S]*?)\/\*BRACKET-CSS-END\*\//)[1];
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g), ...css.matchAll(/font:\s*[\d ]+?(\d+)px/g)].map(m => +m[1]);
  assert.ok(sizes.length > 10);
  assert.ok(Math.min(...sizes) >= 12, 'smallest bracket text is 12px (table headers); everything else 13px+');
});
