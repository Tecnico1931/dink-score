// UX-05: Record game-row actions (Share/Edit/Delete) meet 44 px width and separate Delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fn } from './helpers/app.js';

const html = fs.readFileSync(new URL('../dink-score.html', import.meta.url), 'utf8');
const css = html.slice(0, html.indexOf('</style>'));

function renderGameItem(g, { armed = null } = {}) {
  const src = fn('gameItem');
  const ctx = {
    TEAM_COLOR: ['var(--blue)', 'var(--green)'],
    Rewards: undefined,
    esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    teamLabel: t => t.join(' & '),
    armedDelete: armed,
    isDupe: () => false,
    canConfirmGame: () => false,
    canReplay: () => false,
    club: { code: 'ABC123' },
    minutes: () => 12,
    reactionsHTML: () => ''
  };
  const keys = Object.keys(ctx);
  return new Function(...keys, 'g', `${src}\nreturn gameItem(g);`)(...keys.map(k => ctx[k]), g);
}

test('UX-05: .g-actions .link enforces 44 px minimum width and padding, on a dedicated full-width row', () => {
  assert.match(css, /\.g-actions \.link\s*\{[^}]*min-width:\s*44px/);
  assert.match(css, /\.g-actions \.link\s*\{[^}]*padding:\s*0\s+8px/);
  assert.match(css, /\.game\s*>\s*\.g-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('UX-05: Delete is visually separated (margin-left: auto) and muted until armed', () => {
  assert.match(css, /\.g-actions \.link\.g-del\s*\{[^}]*margin-left:\s*auto/);
  assert.match(css, /\.g-actions \.link\.g-del\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /\.g-actions \.link\.g-del\.armed\s*\{[^}]*color:\s*var\(--danger\)/);

  const g = {
    id: 'g1', mode: 'doubles', teams: [['Ana', 'Ben'], ['Cy', 'Di']],
    score: [11, 7], winner: 0, target: 11, scoring: 'sideout',
    startedAt: Date.now() - 6e5, endedAt: Date.now(), confirmed: true
  };
  const idle = renderGameItem(g);
  assert.match(idle, /<div class="g-actions">[\s\S]*data-edit="g1"[\s\S]*class="link g-del" data-del="g1">Delete<\/button><\/div>/);
  assert.ok(idle.indexOf('class="meta"') < idle.indexOf('class="g-actions"'), 'actions sit on their own row below metadata');

  const armed = renderGameItem(g, { armed: 'g1' });
  assert.match(armed, /class="link g-del armed" data-del="g1">Confirm<\/button>/);
});
