import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('dink-score.html');
const between = (from, to) => {
  const a = html.indexOf(from);
  assert.ok(a >= 0, `${from} missing`);
  const b = html.indexOf(to, a);
  assert.ok(b > a, `${to} missing`);
  return html.slice(a, b);
};

const fnSrc = between('function rowIco(', 'function youRow(') + between('function clubRow(', 'function renderClub()');
const switcherSrc = between('function clubSwitcherHTML()', 'async function clubJoinByCode(');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderClubHome(over = {}) {
  const club = Object.assign({ code: 'K7P2QX', name: 'Preview Club', hasPin: true }, over.club);
  const g = Object.assign({
    club,
    clubs: over.clubs || [club],
    clubData: over.clubData || { code: club.code, deleted: [], nights: [] },
    outbox: [],
    store: { get: () => over.localGames || [] },
    uploading: false,
    esc,
    clubOps: () => [],
    gnUpcoming: () => over.upcoming || [],
    otCan: () => !!over.org,
    otEntryHTML: () => '<button type="button" class="btn btn-soft block ot-row ot-entry" data-act="ot-open">Organizer tools</button>',
    odCanOrg: () => !!over.org,
    isCreator: () => !!over.creator,
    hasOrganizer: () => !!over.org,
    canSetFirstPin: () => !!over.canSetFirstPin,
    needsAttentionHTML: () => '',
    uploadedHere: () => true,
    clubInfoHTML: () => over.clubInfo || '',
    inviteLink: () => `https://example.com/?club=${club.code}`,
    myName: () => over.myName || null,
    myToken: () => (over.myName ? 't'.repeat(48) : null),
    teamLabel: t => t.join(' & ')
  });
  const keys = Object.keys(g);
  const fn = new Function(...keys, `${fnSrc}\n${switcherSrc}\nreturn clubHomeHTML;`)(...keys.map(k => g[k]));
  return fn(over.sheet || { view: 'club' });
}

function actionIds(markup) {
  const ids = [];
  for (const m of markup.matchAll(/\bdata-(act|gn|cl|od)="([^"]+)"/g)) {
    ids.push(m[1] === 'act' ? m[2] : `${m[1]}:${m[2]}`);
  }
  return ids;
}

test('club sheet is grouped into three labelled sections with h3 headings and most-used jobs first', () => {
  const out = renderClubHome({ myName: 'Ana', org: true, creator: true });
  const secs = [...out.matchAll(/<section class="club-group" aria-labelledby="([^"]+)">\s*<h3 id="\1" class="club-sec">([^<]+)<\/h3>/g)].map(m => m[2]);
  assert.deepEqual(secs, ['Play and events', 'This club', 'Organizer']);
  assert.match(out, /<h2 id="club-h" tabindex="-1">Preview Club<\/h2>/);
  const playSection = out.slice(out.indexOf('id="club-sec-play"'), out.indexOf('id="club-sec-club"'));
  const playOrder = actionIds(playSection);
  assert.deepEqual(playOrder, ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open']);
});

test('every action id in the club sheet appears exactly once across every role', () => {
  const cases = [
    ['plain member (unclaimed)', { org: false, creator: false, myName: null },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'pin-unlock-open', 'club-close', 'club-leave']],
    ['plain member (claimed)', { org: false, creator: false, myName: 'Ana' },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'member-leave', 'pin-unlock-open', 'club-close', 'club-leave']],
    ['plain member (openClaim without PIN)', { club: { hasPin: false, openClaim: true }, org: false, creator: false, canSetFirstPin: true, myName: null },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'pin-set-open', 'club-close', 'club-leave']],
    ['unlocked organizer (PIN, not creator)', { org: true, creator: false, myName: 'Ana' },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'member-leave', 'ot-open', 'od:open', 'pin-lock', 'club-close', 'club-leave']],
    ['creator organizer', { org: true, creator: true, myName: 'Ana' },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'member-leave', 'ot-open', 'od:open', 'recovery-open', 'club-close', 'club-leave']],
    ['creator organizer without PIN', { club: { hasPin: false }, org: true, creator: true, canSetFirstPin: true, myName: 'Ana' },
      ['gn:open', 'club-board', 'club-games', 'club-mine', 'cl:open', 'pk-open', 'club-copy', 'club-share', 'club-add', 'move-out-open', 'member-leave', 'ot-open', 'od:open', 'recovery-open', 'club-close', 'club-leave']]
  ];

  for (const [label, opts, expected] of cases) {
    const out = renderClubHome(opts);
    const ids = actionIds(out);
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    for (const [id, n] of counts) assert.equal(n, 1, `${label}: action "${id}" appeared ${n} times`);
    assert.deepEqual(ids, expected, `${label}: unexpected action ids`);
  }
});

test('organizer-only rows duplicated by Organizer tools are not repeated on the club sheet, and remain in Organizer tools', () => {
  const dupes = ['pin-set-open', 'code-rotate-open', 'confirm-setting', 'audit-open', 'links-open', 'info-open', 'members-open', 'analytics-open'];
  const otSrc = read('src/app/organizer-tools.js');
  for (const act of dupes) {
    assert.ok(otSrc.includes(`data-act="${act}"`), `${act} must stay reachable in Organizer tools`);
  }
  for (const opts of [{ org: true, creator: false, myName: 'Ana' }, { org: true, creator: true, myName: 'Ana' }, { club: { hasPin: false }, org: true, creator: true, canSetFirstPin: true }]) {
    const ids = actionIds(renderClubHome(opts));
    for (const act of dupes) assert.ok(!ids.includes(act), `${act} should not be duplicated on the club sheet for organizers`);
  }
});

test('club sheet keeps legal links, TV display link, tokens-only CSS, and announce() hooks', () => {
  const out = renderClubHome({ myName: 'Ana' });
  assert.match(out, /href="\/\?display=K7P2QX"/);
  assert.match(out, /href="\/privacy"/);
  assert.match(out, /href="\/terms"/);
  const css = html.slice(0, html.indexOf('</style>'));
  const clubCss = [...css.matchAll(/^\.(?:club-group|club-sec|club-rows|club-row|club-tv-link)[^{]*\{[^}]*\}/gm)].map(m => m[0]).join('\n');
  assert.ok(clubCss.length > 200);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(clubCss), 'club sheet CSS uses theme tokens only');
  assert.ok(html.includes("announce('Invite link copied.')"));
  assert.ok(html.includes('announce(clubSheet.msg)'));
});
