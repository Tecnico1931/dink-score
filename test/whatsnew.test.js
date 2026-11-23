import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const news = read('src/app/tutorial.js').match(/const NEWS = \{ id: '([^']+)'[\s\S]*?\n\] \};/);

test("what's new sheet has a dated id and short plain entries", () => {
  assert.ok(news, 'NEWS block not found');
  assert.match(news[1], /^\d{4}-\d{2}-\d{2}$/);
  const items = [...news[0].matchAll(/^\s+\['[^']+', '[^']+', '(.+)'\],?$/gm)];
  assert.ok(items.length >= 1);
  for (const [, body] of items) assert.ok(body.length <= 200, body);
});

test("the built page and the a11y check use the same news id", () => {
  assert.ok(read('dink-score.html').includes(`const NEWS = { id: '${news[1]}'`));
  assert.ok(read('index.html').includes(`const NEWS = { id: '${news[1]}'`));
  assert.ok(read('tools/a11y-check.mjs').includes(`"${news[1]}"`));
});

test("what's new push alerts entry only lists shipped push categories", () => {
  const entries = new Map([...news[0].matchAll(/^\s+\['[^']+', '([^']+)', '(.+)'\],?$/gm)].map(m => [m[1], m[2]]));
  const alerts = entries.get('Pick your alerts');
  assert.ok(alerts, 'Pick your alerts entry exists');
  assert.doesNotMatch(alerts, /games to confirm/i, 'push alerts copy omits unshipped games-to-confirm push');
  assert.match(alerts, /game nights/i);
  assert.match(alerts, /events and courts/i);
  assert.match(alerts, /league/i);
  assert.match(entries.get('Bell and inbox') || '', /games to confirm/i, 'inbox entry still lists games to confirm');
});

function loadTutorial(over = {}) {
  const src = read('src/app/tutorial.js');
  const root = {
    innerHTML: '',
    querySelector(sel) {
      if (sel === '.news') return this.innerHTML.includes('class="tour news"') ? {} : null;
      return null;
    }
  };
  const btn = { focus() { state.focused = 'btn'; } };
  const state = Object.assign({
    tutorialSeen: true,
    newsSeen: '',
    live: null,
    clubSheet: null,
    logForm: null,
    newGameOpen: false,
    inboxOpen: false,
    settingsOpen: false,
    profile: null,
    shareSheet: null,
    replay: null,
    ratingExplain: null,
    dssoUI: null,
    evScreen: null,
    lgScreen: null,
    announced: [],
    saved: {},
    focused: null
  }, over);
  const store = {
    get(k, d) {
      if (k === 'pb.tutorialSeen') return state.tutorialSeen;
      if (k === 'pb.newsSeen') return state.newsSeen;
      return d;
    },
    set(k, v) { state.saved[k] = v; }
  };
  const $ = sel => (sel === '#tour' ? root : (sel === '#news-ok' || sel === '#tour-next') && root.innerHTML ? btn : null);
  const announce = msg => state.announced.push(msg);
  const window = { matchMedia: () => ({ matches: false }) };
  const navigator = { userAgent: '', platform: '', maxTouchPoints: 0 };
  const document = { activeElement: { isConnected: true, focus() { state.focused = 'opener'; } }, addEventListener() {} };
  const BALL_IMG = (cls, px) => `<img class="${cls}" width="${px}" height="${px}">`;
  const fn = new Function(
    'state', 'store', '$', 'announce', 'window', 'navigator', 'document', 'API_OK', 'BALL_IMG',
    `let live = state.live, clubSheet = state.clubSheet, logForm = state.logForm, newGameOpen = state.newGameOpen, inboxOpen = state.inboxOpen, settingsOpen = state.settingsOpen, profile = state.profile, shareSheet = state.shareSheet, replay = state.replay, ratingExplain = state.ratingExplain, dssoUI = state.dssoUI, evScreen = state.evScreen, lgScreen = state.lgScreen;
     const sync = () => { ({ live, clubSheet, logForm, newGameOpen, inboxOpen, settingsOpen, profile, shareSheet, replay, ratingExplain, dssoUI, evScreen, lgScreen } = state); };
     ${src}
     return { tourSteps, renderTour: () => { sync(); renderTour(); }, closeNews: () => { sync(); closeNews(); }, isNewsOpen: () => newsOpen };`
  );
  return Object.assign(fn(state, store, $, announce, window, navigator, document, true, BALL_IMG), { root, state });
}

test('first-visit tour steps 2 and 3 match the New game sheet and the center score call', () => {
  const { tourSteps } = loadTutorial();
  const steps = tourSteps();
  const setupStep = steps.find(s => s.title === 'Set up a game');
  const courtStep = steps.find(s => s.title === 'Tap the side that won');
  assert.ok(setupStep && courtStep);
  assert.match(setupStep.body, /<b>New game<\/b>/);
  assert.match(setupStep.body, /<b>Edit<\/b>/);
  assert.ok(!/On <b>Play<\/b>, pick doubles or singles/i.test(setupStep.body), 'Step 2 must not claim game setup is inline on Play');
  assert.match(courtStep.body, /<b>score call<\/b>/);
  assert.match(courtStep.body, /yellow/i);
  assert.ok(!/white pill/i.test(courtStep.body), 'Step 3 must not call the score call a white pill');
});

test("What's new does not stack over an open sheet and renders once sheets close", () => {
  for (const key of ['clubSheet', 'logForm', 'newGameOpen', 'inboxOpen', 'settingsOpen']) {
    const t = loadTutorial({ [key]: key.endsWith('Open') ? true : { view: 'whoami' } });
    t.renderTour();
    assert.equal(t.root.innerHTML, '', `What's new must not render while ${key} is open`);
    assert.equal(t.isNewsOpen(), true, `What's new stays pending while ${key} is open`);
    assert.equal(t.state.saved['pb.newsSeen'], undefined);

    t.state[key] = key.endsWith('Open') ? false : null;
    t.renderTour();
    assert.match(t.root.innerHTML, /id="news-h">What's new<\/h2>/, `What's new renders once ${key} closes`);
  }
});
