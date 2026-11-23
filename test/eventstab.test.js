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
