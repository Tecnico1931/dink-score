// UX-04: Events-tab game night cards (Manage/Details + See all) and organizer "New league" CTA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fn, module as mod } from './helpers/app.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeNight(i, over = {}) {
  return Object.assign({
    id: `n${i}`,
    title: `Night ${i}`,
    startsAt: Date.now() + (i + 1) * 864e5,
    location: 'West Park',
    cap: null,
    status: 'open',
    counts: { in: 1, maybe: 0, out: 0 },
    rsvps: { in: ['Ana'], maybe: [], out: [] }
  }, over);
}

function renderGnTab({ nights = [], org = false, hasPin = true } = {}) {
  const src = mod('game-nights');
  const g = {
    API_OK: true,
    DAY: 864e5,
    club: { code: 'ABC123', name: 'Sunny Courts', hasPin },
    clubData: { code: 'ABC123', nights },
    clubSheet: null,
    esc,
    isCreator: () => org,
    hasOrganizer: () => org,
    myName: () => 'Ana',
    sameName: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    youTag: () => '',
    store: { set() {} },
    render() {},
    renderClub() {},
    showToast() {},
    announce() {},
    adminCreds: () => ({}),
    api: async () => ({}),
    $: () => null,
    skel: () => ''
  };
  const keys = Object.keys(g);
  return new Function(...keys, `${src}\nreturn gnTabHTML();`)(...keys.map(k => g[k]));
}

function renderEventsTab({ org = false, leagues = [], events = [] } = {}) {
  const src = fn('eventsTabView');
  const g = {
    club: { code: 'ABC123', name: 'Sunny Courts', hasPin: true },
    evTab: { code: 'ABC123', at: Date.now(), busy: false, leagues, evd: null, lgd: null, tokens: {}, arm: '', err: '' },
    evSummary: events,
    evTabLoad() {},
    canOrganize: () => org,
    skel: () => '',
    evTabCard: e => `<article class="ev-card">${esc(e.name)}</article>`,
    gnTabHTML: () => '<section class="ev-sec">gn</section>',
    evTabStandingsHTML: () => '',
    esc
  };
  const keys = Object.keys(g);
  return new Function(...keys, `${src}\nreturn eventsTabView();`)(...keys.map(k => g[k]));
}

test('gnTabHTML: shows Manage for organizers and Details for members on each card, and See all when any night exists', () => {
  const empty = renderGnTab({ nights: [], org: true });
  assert.doesNotMatch(empty, /data-gn="open"/, 'no See all link when no upcoming nights exist');

  const oneOrg = renderGnTab({ nights: [makeNight(1, { title: 'Friday Lights', cap: 12 })], org: true });
  assert.match(oneOrg, /<h2 id="gn-tab-h">Game nights<\/h2><button type="button" class="link" data-gn="open">See all<\/button>/);
  assert.match(oneOrg, /data-gn="open" aria-label="Manage: Friday Lights">Manage<\/button>/);
  assert.match(oneOrg, /1\/12 spots/, 'keeps the cap badge on the card');

  const oneMember = renderGnTab({ nights: [makeNight(1, { title: 'Friday Lights' })], org: false });
  assert.match(oneMember, /<h2 id="gn-tab-h">Game nights<\/h2><button type="button" class="link" data-gn="open">See all<\/button>/);
  assert.match(oneMember, /data-gn="open" aria-label="Details: Friday Lights">Details<\/button>/);
  assert.doesNotMatch(oneMember, />Manage<\/button>/);

  const fourOrg = renderGnTab({ nights: [1, 2, 3, 4].map(i => makeNight(i)), org: true });
  assert.match(fourOrg, /<h2 id="gn-tab-h">Game nights<\/h2><button type="button" class="link" data-gn="open">See all \(4\)<\/button>/);
});

test('eventsTabView: shows New league button for organizers only, matching New event', () => {
  const orgHtml = renderEventsTab({ org: true, leagues: [] });
  assert.match(orgHtml, /<button type="button" class="btn btn-soft block" data-lg="tab-new">New league<\/button>/);

  const memberHtml = renderEventsTab({ org: false, leagues: [] });
  assert.doesNotMatch(memberHtml, /data-lg="tab-new"/);
  assert.doesNotMatch(memberHtml, />New league<\/button>/);
});

test('lgAct: tab-new opens the new league form from the Events tab and back returns to the tab with focus', () => {
  const src = mod('leagues-actions');
  let lgScreen = null;
  let rendered = 0, safeRendered = 0, focused = null, loadedList = 0;
  const evTab = { at: 12345 };
  const fakeDoc = {
    addEventListener() {},
    querySelector(sel) { return { focus() { focused = sel; } }; }
  };
  const g = {
    club: { code: 'ABC123' },
    canOrganize: () => true,
    evTab,
    CSS: { escape: s => s },
    document: fakeDoc,
    roster: [],
    sameName: (a, b) => a === b,
    $: () => null,
    api: async () => ({}),
    lgCall: async () => ({}),
    lgOpen() {},
    lgClose() {},
    lgLoad() {},
    lgLoadList() { loadedList++; },
    lgNewForm: () => ({ kind: 'league', players: [] }),
    lgMaxMove: () => 1,
    lgMoveNote: () => '',
    LG_TB_LABEL: {},
    lgShare() {},
    lgCopyLink() {},
    evTabTv() {},
    renderLeagues() { rendered++; },
    safeRender() { safeRendered++; },
    queueOp() {},
    showToast() {},
    forgetPin() {},
    announce() {}
  };
  const keys = Object.keys(g);
  const harness = new Function(...keys, `let lgScreen = null;\n${src}\nreturn { act: lgAct, get: () => lgScreen, set: v => { lgScreen = v; } };`)(...keys.map(k => g[k]));

  harness.act('tab-new', {});
  lgScreen = harness.get();
  assert.ok(lgScreen, 'tab-new creates lgScreen');
  assert.equal(lgScreen.view, 'new');
  assert.equal(lgScreen.fromTab, true);
  assert.equal(rendered, 1);

  harness.act('back', {});
  assert.equal(harness.get(), null, 'back from tab-new closes lgScreen');
  assert.equal(evTab.at, 0, 'invalidates evTab cache on return');
  assert.equal(safeRendered, 1);
  assert.equal(focused, '[data-lg="tab-new"]');
  assert.equal(loadedList, 0, 'does not bounce through the leagues list');

  // Opening "new" from the leagues list still returns to the list on back.
  harness.set({ view: 'list', list: [], error: '' });
  harness.act('new', {});
  assert.equal(harness.get().view, 'new');
  harness.act('back', {});
  assert.equal(harness.get().view, 'list');
  assert.equal(loadedList, 1);
});

test('UX-17: evTabCard labels elimination Event Detail button "Open" and adds a direct "Bracket" button', () => {
  const src = `${fn('evTabCard')}`;
  const runCard = (e, kind, org = true) => {
    const g = {
      esc,
      evTab: { arm: '' },
      evElim: x => x.format === 'single_elim' || x.format === 'double_elim',
      lgItemBody: () => '<div class="ev-item-head"><b>League</b></div>',
      evItemBody: () => '<div class="ev-item-head"><b>Event</b></div>'
    };
    const keys = Object.keys(g);
    return new Function(...keys, 'e', 'kind', 'org', `${src}\nreturn evTabCard(e, kind, org);`)(...keys.map(k => g[k]), e, kind, org);
  };

  for (const format of ['single_elim', 'double_elim']) {
    const html = runCard({ id: 'ev1', name: 'Quick Cup', format, status: 'live' }, 'event', true);
    assert.match(html, /data-ev="tab-open" data-id="ev1" aria-label="Open: Quick Cup">Open<\/button>/);
    assert.match(html, /data-ev="tab-bracket" data-id="ev1" aria-label="Bracket: Quick Cup">Bracket<\/button>/);
    assert.doesNotMatch(html, /data-ev="tab-open"[^>]*>Bracket<\/button>/);
  }

  const rr = runCard({ id: 'ev2', name: 'Round Robin', format: 'roundrobin', status: 'live' }, 'event', false);
  assert.match(rr, /data-ev="tab-open" data-id="ev2" aria-label="Standings: Round Robin">Standings<\/button>/);
  assert.doesNotMatch(rr, /data-ev="tab-bracket"/);

  const lg = runCard({ id: 'lg1', name: 'Fall Ladder', kind: 'ladder', status: 'live' }, 'league', false);
  assert.match(lg, /data-lg="tab-open" data-id="lg1" aria-label="Ladder: Fall Ladder">Ladder<\/button>/);
  assert.doesNotMatch(lg, /tab-bracket/);
});

test('UX-17: evAct tab-bracket opens view "bracket" directly and Back returns focus to the Bracket button', () => {
  const src = mod('events-actions');
  let rendered = 0, safeRendered = 0, loadedId = null, focused = null;
  const evTab = { at: 12345 };
  const fakeDoc = {
    addEventListener() {},
    querySelector(sel) { return { focus() { focused = sel; } }; }
  };
  const g = {
    club: { code: 'ABC123' },
    evTab,
    CSS: { escape: s => s },
    document: fakeDoc,
    $: () => null,
    evOpenList() {},
    evLoadMore() {},
    evShow(id) { loadedId = id; },
    evLoad(id) { loadedId = id; },
    evLoadList() {},
    evTabTv() {},
    evNewForm: () => ({}),
    evImpAct: () => false,
    evSeedPreview() {},
    evDefaultRounds: () => 3,
    roster: [],
    sameName: (a, b) => a === b,
    cleanPlayer: s => s,
    isDefaultName: () => false,
    addToRoster() {},
    evShare() {},
    evCopyLink() {},
    evOrg() {},
    evScoreLive() {},
    evMatchOf: () => null,
    evSaveScore() {},
    evCreate() {},
    evSaveEdit() {},
    evAddPlayer() {},
    evRemovePlayer() {},
    evStartKnockout() {},
    evComplete() {},
    evDelete() {},
    renderEvents() { rendered++; },
    safeRender() { safeRendered++; },
    renderClub() {},
    clubSheet: null,
    matchMedia: () => ({ matches: true })
  };
  const keys = Object.keys(g);
  const harness = new Function(...keys, `let evScreen = null;\n${src}\nreturn { act: evAct, get: () => evScreen, set: v => { evScreen = v; } };`)(...keys.map(k => g[k]));

  harness.act('tab-bracket', { id: 'ev1' });
  const s = harness.get();
  assert.ok(s, 'tab-bracket creates evScreen');
  assert.equal(s.view, 'bracket');
  assert.equal(s.id, 'ev1');
  assert.equal(s.fromTab, true);
  assert.equal(s.tabBracket, true);
  assert.equal(loadedId, 'ev1');
  assert.equal(rendered, 1);

  // Back from direct bracket returns to the Events tab and focuses the Bracket button
  harness.act('back', {});
  assert.equal(harness.get(), null);
  assert.equal(evTab.at, 0);
  assert.equal(safeRendered, 1);
  assert.equal(focused, '[data-ev="tab-bracket"][data-id="ev1"]');

  // Opening bracket directly then clicking "Schedule and scoring" (back-detail) switches to detail
  harness.act('tab-bracket', { id: 'ev1' });
  harness.act('back-detail', {});
  assert.equal(harness.get().view, 'detail');
  assert.equal(harness.get().fromTab, true);
});
