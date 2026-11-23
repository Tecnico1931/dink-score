// Checks for UX-18: one-tap target score pills (11 / 15 / 21) in "Log a result".
import test from 'node:test';
import assert from 'node:assert/strict';
import { module as appModule, page } from './helpers/app.js';

const html = page();
const logMod = appModule('log-result');

function makeEnv(form) {
  const sheet2 = { innerHTML: '' };
  const inputs = { 0: { value: form.score[0] }, 1: { value: form.score[1] } };
  const pills = {
    0: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    1: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }
  };
  const announcements = [];
  const $ = sel => {
    if (sel === '#sheet2') return sheet2;
    if (sel === '#log-score-0') return inputs[0];
    if (sel === '#log-score-1') return inputs[1];
    if (sel === '[data-log-win="0"]') return pills[0];
    if (sel === '[data-log-win="1"]') return pills[1];
    return null;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const seg = (attr, opts, val, cls = '') => `<div class="seg ${cls}">${opts.map(([v, l]) => `<button type="button" ${attr}="${v}" aria-pressed="${String(v) === String(val)}">${l}</button>`).join('')}</div>`;
  const run = new Function(
    '$', 'esc', 'seg', 'lockBody', 'TEAM_COLOR', 'TEAM_NAME', 'ICON', 'rosterNames', 'chipsHTML', 'announce', 'setup', 'live', 'club', 'pickup', 'hasOrganizer', 'logForm',
    `${logMod}\nreturn { logTarget, renderLog, syncLogTargetPill, setLogScoreTarget, getForm: () => logForm };`
  );
  const api = run(
    $, esc, seg, () => {}, ['var(--blue)', 'var(--green)'], ['Blue', 'Green'], { share: '' },
    () => [], () => '', msg => announcements.push(msg),
    { mode: 'doubles', target: form.target }, null, null, null, () => false, form
  );
  return { ...api, sheet2, inputs, pills, announcements };
}

test('renderLog renders one-tap target score pills matching Played to (11, 15, 21) for both teams', () => {
  for (const target of [11, 15, 21]) {
    const form = { mode: 'doubles', target, names: [['', ''], ['', '']], score: ['', ''], when: '2026-11-23T07:30', error: '' };
    const env = makeEnv(form);
    env.renderLog();
    const out = env.sheet2.innerHTML;
    assert.match(out, new RegExp(`<button type="button" class="target-pill" data-log-win="0" aria-pressed="false" aria-label="Set Blue score to ${target}">${target}</button>`));
    assert.match(out, new RegExp(`<button type="button" class="target-pill" data-log-win="1" aria-pressed="false" aria-label="Set Green score to ${target}">${target}</button>`));
  }
});

test('target pill reflects aria-pressed when a team score matches target and falls back to 11 on invalid target', () => {
  const form = { mode: 'singles', target: 15, names: [['Ana', ''], ['Ben', '']], score: ['15', '9'], when: '2026-11-23T07:30', error: '' };
  const env = makeEnv(form);
  env.renderLog();
  const out = env.sheet2.innerHTML;
  assert.match(out, /data-log-win="0" aria-pressed="true" aria-label="Set Blue score to 15">15<\/button>/);
  assert.match(out, /data-log-win="1" aria-pressed="false" aria-label="Set Green score to 15">15<\/button>/);
  assert.equal(env.logTarget({ target: 99 }), 11);
});

test('tapping a target pill sets that team score in one tap, updates aria-pressed, and announces', () => {
  const form = { mode: 'doubles', target: 21, names: [['', ''], ['', '']], score: ['', '14'], when: '2026-11-23T07:30', error: '' };
  const env = makeEnv(form);
  env.setLogScoreTarget(0);
  assert.equal(form.score[0], '21');
  assert.equal(form.score[1], '14', 'other team score is untouched');
  assert.equal(env.inputs[0].value, '21');
  assert.equal(env.pills[0].attrs['aria-pressed'], 'true');
  assert.deepEqual(env.announcements, ['Blue score set to 21']);

  form.score[0] = '22';
  env.syncLogTargetPill(0);
  assert.equal(env.pills[0].attrs['aria-pressed'], 'false', 'stepping past target clears aria-pressed');

  env.setLogScoreTarget(1);
  assert.equal(form.score[1], '21');
  assert.equal(env.inputs[1].value, '21');
  assert.equal(env.pills[1].attrs['aria-pressed'], 'true');
  assert.deepEqual(env.announcements, ['Blue score set to 21', 'Green score set to 21']);
});

test('Log a result click/input handlers, 44px targets, tokens and outdoor styling are wired', () => {
  assert.match(html, /if \(ds\.logWin !== undefined\) \{ setLogScoreTarget\(\+ds\.logWin\); return; \}/);
  assert.match(html, /if \(ds\.logTarget\) \{ logForm\.target = \+ds\.logTarget; renderLog\(\); if \(!e\.detail\) \{[\s\S]*?focus\(\{ preventScroll: true \}\); \} announce\(`Played to \$\{logForm\.target\}`\); return; \}/);
  assert.match(html, /if \(ds\.step !== undefined\) \{[\s\S]*?syncLogTargetPill\(t\);/);
  assert.match(html, /d\.logScore !== undefined && logForm\) \{[\s\S]*?syncLogTargetPill\(t\);/);

  const css = html.slice(0, html.indexOf('</style>'));
  const logCss = css.slice(css.indexOf('/* Log a result */'), css.indexOf('/* Club */'));
  assert.match(logCss, /\.stepper \.sb \.target-pill\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(logCss, /\.stepper \.sb \.target-pill\s*\{[^}]*font-family:\s*var\(--display\);[^}]*font-weight:\s*800;[^}]*font-stretch:\s*75%;/);
  assert.match(logCss, /\.stepper \.sb \.target-pill\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--c\);[^}]*color:\s*var\(--on-court\);/);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(logCss), 'Log a result CSS uses theme tokens only, no hard-coded hex');
  assert.ok(!/var\(--ball\)/.test(logCss), 'target pill respects Floodlight Rule (no ball yellow)');
  assert.match(css, /:root\[data-outdoor\] \.stepper \.sb \.target-pill\s*\{[^}]*border:\s*2px solid var\(--ink\)/);
});
