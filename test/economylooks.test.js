// Court themes and win celebrations (WI-16): catalogue on the server, worn only on this phone, one short effect that never traps a tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, SLOTS, clubLooksFrom, wornFrom } from '../api/_economyshop.js';
import { BOX_TIERS } from '../api/_economybox.js';
import { module, page, section } from './helpers/app.js';

const THEMES = [['theme-sunset', 'Sunset court', 150], ['theme-clay', 'Clay court', 150], ['theme-grass', 'Grass court', 150], ['theme-neon', 'Neon court', 210], ['theme-beach', 'Beach court', 150], ['theme-ice', 'Ice rink', 150], ['theme-midnight', 'Midnight court', 150], ['theme-arcade', 'Retro arcade', 210]];
const FX = [['celebrate-confetti', 'Confetti', 120], ['celebrate-balls', 'Ball burst', 120], ['celebrate-pickles', 'Pickle rain', 150], ['celebrate-paddles', 'Flying paddles', 150], ['celebrate-hearts', 'Heart burst', 120]];
const XMAS_FX = [['celebrate-snowfall', 'Snowfall', 300], ['celebrate-gifts', 'Present drop', 1200]]; // event shelf, not in CATALOGUE

// M2: the Legendary and Mythic looks, at the upstream prices (three Mythic items more make the seven that exist).
const TOP_THEMES = [['theme-aurora', 'Aurora court', 1080, 'legendary'], ['theme-galaxy', 'Galaxy court', 1080, 'legendary'], ['theme-eclipse', 'Eclipse court', 4100, 'mythic']];
const TOP_FX = [['celebrate-fireworks', 'Fireworks', 900, 'legendary'], ['celebrate-trophy', 'Trophy shower', 1200, 'legendary'], ['celebrate-supernova', 'Supernova', 4400, 'mythic']];

test('eleven court themes and eight win celebrations at the upstream prices, never in the box, never shown to the club', () => {
  assert.deepEqual(CATALOGUE.filter(i => i.slot === 'theme').map(i => [i.id, i.name, i.price, i.rarity]), [...THEMES.map(([id, n, p]) => [id, n, p, 'rare']), ...TOP_THEMES]);
  assert.deepEqual(CATALOGUE.filter(i => i.slot === 'celebrate').map(i => [i.id, i.name, i.price, i.rarity]), [...FX.map(([id, n, p]) => [id, n, p, 'rare']), ...TOP_FX]);
  assert.ok(SLOTS.includes('theme') && SLOTS.includes('celebrate'));
  const ids = [...THEMES, ...FX, ...TOP_THEMES, ...TOP_FX].map(x => x[0]);
  assert.ok(!BOX_TIERS.some(t => t.items.some(id => ids.includes(id))), 'a theme or celebration is not a box prize');
  assert.deepEqual(clubLooksFrom(ids.map(item => ({ name_key: 'ana', slot: item.split('-')[0], item }))), {}, 'only the owner sees them, on their own phone');
  assert.deepEqual(wornFrom([{ id: 'theme-neon', slot: 'theme', worn: true }, { id: 'celebrate-hearts', slot: 'celebrate', worn: true }]).theme, 'theme-neon');
});

test('every theme has its token blocks in light, night and sunlight, and the phone draws the same eleven', () => {
  const css = section('REWARDTHEMES');
  for (const [id] of [...THEMES, ['theme-snow'], ...TOP_THEMES]) {
    const key = 't-' + id.slice(6);
    for (const sel of [`:root[data-palette="${key}"] {`, `:root[data-palette="${key}"]:not([data-theme="light"]) {`, `:root[data-palette="${key}"][data-theme="dark"] {`, `:root[data-palette="${key}"][data-outdoor] {`]) assert.ok(css.includes(sel), sel);
  }
  assert.ok(!/animation|transition/.test(css), 'tokens only');
  const m = page().match(/\/\*DISPLAY-START\*\/([\s\S]*?)\/\*DISPLAY-END\*\//)[1];
  const D = new Function(m + '\nreturn DisplayPrefs;')();
  const all = [...THEMES, ['theme-snow', 'Snowy court'], ...TOP_THEMES]; // snow: the Christmas event shelf's court (api/_economyseason.js)
  assert.deepEqual(D.SHOP_THEMES.map(t => t.item), all.map(t => t[0]));
  assert.deepEqual(D.SHOP_THEMES.map(t => t.name), all.map(t => t[1]), 'names match the server catalogue');
});

test('a worn theme is applied only while rewards are shown here, and hiding them puts the free palette back', () => {
  const run = (club, hide, worn) => {
    const mem = { 'pb.rewards': { c1: { dinks: 5, worn } }, 'pb.rewardsHide': hide }, sets = [];
    const D = new Function(section('DISPLAY') + '\nreturn DisplayPrefs;')();
    const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'DisplayPrefs', 'applyDisplay',
      `let shopTheme = ''; ` + module('economy') + `; return { rwApplyLook, rwSave, get theme() { return shopTheme; }, get worn() { return rwCur().worn; } };`)(
      { get: (k, f) => (k in mem ? mem[k] : f), set: (k, v) => { mem[k] = v; sets.push(k); } }, club, String, () => {}, { documentElement: { setAttribute() {}, removeAttribute() {} }, addEventListener() {} }, () => 'Ana', () => 't', null, () => {}, D, () => sets.push('apply'));
    x.rwApplyLook();
    return { x, mem, sets };
  };
  const on = run({ code: 'c1', rewards: true }, false, { frame: '', paddle: '', pet: '', theme: 'theme-neon' });
  assert.equal(on.x.theme, 'theme-neon'); assert.equal(on.mem['pb.shopTheme'], 'theme-neon'); assert.ok(on.sets.includes('apply'), 'the palette is re-applied');
  assert.equal(run({ code: 'c1', rewards: true }, true, { theme: 'theme-neon' }).x.theme, '', 'one-tap hide');
  assert.equal(run({ code: 'c1', rewards: false }, false, { theme: 'theme-neon' }).x.theme, '', 'a club with rewards off');
  assert.equal(run({ code: 'c1', rewards: true }, false, { theme: 'theme-nope' }).x.theme, '', 'an unknown id is ignored');
  const fx = run({ code: 'c1', rewards: true }, false, { frame: '', paddle: '', pet: '', theme: 'theme-ice', celebrate: 'celebrate-hearts' });
  assert.deepEqual([fx.x.worn.theme, fx.x.worn.celebrate], ['theme-ice', 'celebrate-hearts'], 'the phone keeps both ids (celebrate is a 9-letter slot)');
  const kept = run(null, false, {}); assert.equal(kept.sets.length, 0, 'no club loaded yet: the first paint is left alone');
});

// A tiny DOM: createElement / body.appendChild / querySelectorAll('.rw-fx'), and timers we can fire.
const phone = ({ worn = '', shown = true } = {}) => {
  const added = [], timers = [];
  const doc = {
    createElement: () => { const el = { dataset: {}, attrs: {}, className: '', remove() { const i = added.indexOf(el); if (i >= 0) added.splice(i, 1); }, setAttribute(k, v) { el.attrs[k] = v; }, set innerHTML(v) { el.html = v; } }; return el; },
    body: { appendChild: el => added.push(el) },
    querySelectorAll: () => added.slice()
  };
  const x = new Function('document', 'setTimeout', 'clearTimeout', 'DisplayPrefs', 'esc', 'rwShown', 'rwCur', 'rwSecHead', 'rwShelf', 'clearConfetti',
    module('economycelebrate') + ';return { rwWinFx, rwWornFx, rwFxClear, rwLookWell, rwLooksSectionsHTML, RW_FX };')(
    doc, (f, ms) => { timers.push({ f, ms }); return timers.length; }, () => {}, new Function(section('DISPLAY') + '\nreturn DisplayPrefs;')(), String, () => shown, () => ({ worn: { celebrate: worn } }),
    (t, n) => `<h3>${t}</h3><p>${n}</p>`, (c, s, items) => items.map(i => i.id).join(), () => {});
  return { ...x, added, timers };
};

test('a worn celebration draws one short band of 16 pieces and removes it after 1.5 s; none worn or hidden draws nothing', () => {
  for (const [id, , ] of [...FX, ...XMAS_FX]) {
    const p = phone({ worn: id });
    assert.equal(p.rwWinFx(), true, id);
    assert.equal(p.added.length, 1); assert.equal(p.added[0].className, 'rw-fx'); assert.equal(p.added[0].attrs['aria-hidden'], 'true');
    assert.equal((p.added[0].html.match(/<i /g) || []).length, 16); assert.ok(!/<(script|img|a) /i.test(p.added[0].html));
    assert.equal(p.timers.at(-1).ms, 1500, 'gone within 1.5 s');
    p.timers.at(-1).f(); assert.equal(p.added.length, 0);
  }
  const twice = phone({ worn: 'celebrate-balls' }); twice.rwWinFx(); twice.rwWinFx(); assert.equal(twice.added.length, 1, 'a second win replaces the first');
  assert.equal(phone().rwWinFx(), false, 'nothing worn: the caller draws the default burst');
  const hidden = phone({ worn: 'celebrate-balls', shown: false }); assert.equal(hidden.rwWinFx(), false); assert.equal(hidden.added.length, 0);
  assert.equal(phone({ worn: 'celebrate-nope' }).rwWinFx(), false);
});

test('the effect stays in a top band with pointer-events off, ends inside 1.5 s, and is still under reduced motion', () => {
  const css = page().split('</style>')[0];
  const rule = css.match(/\.rw-fx \{[^}]*\}/)[0];
  assert.match(rule, /top: 0/); assert.match(rule, /height: 44dvh/); assert.match(rule, /pointer-events: none/); assert.match(rule, /overflow: hidden/);
  const anim = css.match(/@media \(prefers-reduced-motion: no-preference\) \{ \.rw-fx i \{[^}]*\} \}/);
  assert.ok(anim, 'the motion is wrapped in no-preference, so reduced motion gets the still pieces');
  const ms = Number(anim[0].match(/animation: rw-fx (\d+)ms/)[1]);
  const src = module('economycelebrate');
  const maxDelay = Math.max(...Array.from({ length: 16 }, (_, i) => (i % 6) * 50));
  assert.ok(ms + maxDelay <= 1500, `motion ${ms} ms + ${maxDelay} ms delay fits in 1.5 s`);
  assert.match(src, /setTimeout\(rwFxClear, 1500\)/);
  assert.ok(!/canvas|requestAnimationFrame|setInterval|Math\.random|Audio/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'CSS only, deterministic, silent');
  assert.match(css, /\.rw-fx i \{[^}]*transform: translate\(var\(--x, 0\), var\(--y, 0\)\)/, 'still pieces rest where the motion ends');
});

test('the win moment: a worn celebration replaces the default burst and only runs with Win celebration on', () => {
  const C = new Function(section('CELEBRATION') + '\nreturn Celebration;')();
  assert.equal(C.shouldShopFx({ on: 1, beforeWinner: null, winner: 1 }), true);
  assert.equal(C.shouldShopFx({ on: 0, beforeWinner: null, winner: 1 }), false, 'off by default');
  assert.equal(C.shouldShopFx({ on: 1, beforeWinner: 0, winner: 0 }), false, 'only when a game just ended');
  assert.equal(C.shouldShopFx({ on: 1, beforeWinner: null, winner: null }), false);
  const live = module('display-live');
  assert.match(live, /Celebration\.shouldShopFx\(opts\) && typeof rwWinFx === 'function' && rwWinFx\(winner, reducedMotion\)[\s\S]*?else if \(Celebration\.shouldConfetti\(opts\)\) launchConfetti\(winner\)/);
});

test('the shelves and previews: two sections, a still preview per card, nothing when the shop has none', () => {
  const p = phone();
  const items = [...THEMES.map(([id, name]) => ({ id, slot: 'theme', name })), ...FX.map(([id, name]) => ({ id, slot: 'celebrate', name })), { id: 'frame-court', slot: 'frame' }, { id: 'theme-x', slot: 'theme', seasonal: true }];
  const html = p.rwLooksSectionsHTML({}, { items });
  assert.match(html, /<h3>Court themes<\/h3><p>Your scoring screen on this phone\.<\/p>theme-sunset,/);
  assert.match(html, /<h3>Win celebrations<\/h3><p>Plays on your scoring phone when a game ends\.<\/p>celebrate-confetti,/);
  assert.ok(!html.includes('frame-court') && !html.includes('theme-x'));
  assert.match(html, /six free palettes in Settings stay free/);
  assert.equal(p.rwLooksSectionsHTML({}, { items: [] }), '');
  const t = p.rwLookWell({ id: 'theme-neon', slot: 'theme' }); assert.match(t, /class="rw-thm" aria-hidden="true" style="--p1:#[0-9A-F]{6};--p2:#[0-9A-F]{6}"/);
  for (const [id] of FX) { const f = p.rwLookWell({ id, slot: 'celebrate' }); assert.equal((f.match(/<svg /g) || []).length, 5, id); assert.match(f, /aria-hidden="true"/); }
  assert.equal((p.rwLookWell({ id: 'celebrate-hearts', slot: 'celebrate' }, true).match(/<svg /g) || []).length, 3, 'the small swatch in the wear list');
  assert.equal(p.rwLookWell({ id: 'theme-nope', slot: 'theme' }), '');
});
