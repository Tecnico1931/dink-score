// WI-2: the Shop header (earned/spent, streak week, Inventory), the Shop button in the bottom bar and the sheet for a visitor with nothing to shop for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { module } from './helpers/app.js';
import { dayPay, totals, ledgerBalance } from '../api/_economy.js';

const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const phone = ({ club = { code: 'club-a', rewards: true }, name = 'Ana', hide = false, state = null, catalog = { dinks: 7, earned: 10, spent: 3, worn: { frame: '', paddle: '' }, share: false, items: [] } } = {}) => {
  const kv = { 'pb.rewardsHide': hide, ...(state ? { 'pb.rewards': { 'club-a': state } } : {}) }, calls = [], listeners = [], env = { renders: 0, focused: null };
  const nav = { kids: [{ dataset: { tab: 'history' } }], querySelector(sel) { return sel.includes('shopnav') ? this.kids.find(k => k.dataset.rw === 'shopnav') || null : sel.includes('history') ? this.kids.find(k => k.dataset.tab === 'history') : null; }, insertBefore(b, ref) { this.kids.splice(ref ? this.kids.indexOf(ref) : this.kids.length, 0, b); } };
  const doc = { documentElement: { setAttribute() {}, removeAttribute() {} }, addEventListener: (t, f) => listeners.push(f), createElement: () => ({ dataset: {}, hidden: false }), querySelector: sel => (sel === '#tabs nav' ? nav : { focus() { env.focused = sel; } }) };
  const code = module('economy') + ';' + module('economyshop') + ';return { Rewards, rwSpinLearn, set sheet(v) { clubSheet = v; }, get sheet() { return clubSheet; } };';
  const x = new Function('store', 'club', 'esc', 'announce', 'document', 'myName', 'myToken', 'playerCall', 'render', 'renderClub', 'initials', 'iconSvg', 'skel', 'avatarInner', 'teamLabel',
    'let clubSheet = null;' + code)(
    { get: (k, f) => (k in kv ? kv[k] : f), set: (k, v) => { kv[k] = v; } }, club, String, () => {}, doc, () => name, () => (name ? 'tok' : null),
    async b => { calls.push(b); return catalog; }, () => env.renders++, () => env.renders++, s => s.slice(0, 2), () => '', () => '', n => n.slice(0, 2), ps => ps.join(' & '));
  return { x, nav, calls, listeners, env };
};
const shopBtn = p => p.nav.kids.find(k => k.dataset.rw === 'shopnav');

test('totals: earned and spent come from the ledger and balance = earned - spent', () => {
  const l = [{ amount: 5 }, { amount: -3 }, { amount: 2 }, { amount: -1 }];
  assert.deepEqual(totals(l), { earned: 7, spent: 4 });
  assert.equal(ledgerBalance(l), totals(l).earned - totals(l).spent);
  assert.deepEqual(totals([]), { earned: 0, spent: 0 });
});

test('Shop header: balance, earned/spent, streak week and Inventory count come from real constants', () => {
  const today = dayKey(new Date());
  const p = phone({ state: { streak: 3, best: 5, dinks: 7, last: today } });
  const html = p.x.Rewards.storeHTML({ store: { dinks: 7, earned: 10, spent: 3, worn: {}, items: [{ id: 'frame-court', slot: 'frame', name: 'Court', price: 6, owned: true }, { id: 'frame-ink', slot: 'frame', name: 'Ink', price: 6, owned: false }] }, msg: '', error: '' });
  assert.match(html, /<p class="rw-tally">10 earned, 3 spent<\/p>/);
  assert.match(html, /Day 3 streak<\/b><small>Tomorrow: day 4, \+12<\/small><\/span><b class="rw-best">Best 5<\/b>/);
  assert.match(html, /rw-dayc got"><span class="rw-dot" aria-hidden="true">✓<\/span><span class="vh">Day 3: \+10, done/);
  assert.match(html, /rw-dayc next"><span class="rw-dot" aria-hidden="true">4<\/span>/);
  assert.match(html, /<span class="rw-count">1<span class="vh"> item<\/span>/);
  assert.match(html, /class="badge you">You</);
  assert.match(html, /data-act="av-open"/);
  // Each day of the week pays what the server pays for that streak day.
  for (const [day, from] of [[3, 1], [9, 8]]) {
    const q = phone({ state: { streak: day, best: day, dinks: 0, last: today } });
    const h = q.x.Rewards.storeHTML({ store: { dinks: 0, worn: {}, items: [] }, msg: '', error: '' });
    for (let n = from; n < from + 7; n++) assert.ok(h.includes(`<span class="vh">Day ${n}: +${dayPay(n)}`), `day ${n} pays ${dayPay(n)}`);
  }
  // No streak yet: day 1 is the next one, nothing is checked.
  const fresh = phone().x.Rewards.storeHTML({ store: { dinks: 0, worn: {}, items: [] }, msg: '', error: '' });
  assert.match(fresh, /No streak yet<\/b><small>Play today to start: day 1, \+5/);
  assert.ok(!/rw-dayc got/.test(fresh));
  assert.ok(!/earned,/.test(fresh), 'an older server answer without totals draws no tally');
});

test('Inventory: the wear pickers and the club-look switch live there, opened and closed from the Shop', async () => {
  const items = [{ id: 'frame-court', slot: 'frame', name: 'Court', price: 6, owned: true }];
  const p = phone();
  await p.x.Rewards.openStore();
  assert.equal(p.x.sheet.view, 'rwstore');
  p.x.sheet.store = { dinks: 7, worn: { frame: 'frame-court', paddle: '' }, share: false, items };
  const click = ds => p.listeners.forEach(f => f({ target: { closest: () => ({ dataset: ds }) } }));
  click({ rw: 'inv' });
  assert.equal(p.x.sheet.inv, true);
  assert.equal(p.env.focused, '#club-h');
  const inv = p.x.Rewards.storeHTML(p.x.sheet);
  assert.match(inv, />Inventory<\/h2>/);
  assert.match(inv, /data-rw-wear="frame:frame-court"[^>]*aria-pressed="true"/);
  assert.match(inv, /data-rw-share="1"/);
  assert.match(inv, /data-rw="inv-back"/);
  assert.ok(!/data-rw-buy/.test(inv), 'nothing is sold from the Inventory');
  click({ rw: 'inv-back' });
  assert.equal(p.x.sheet.inv, false);
  assert.ok(!/data-rw-wear/.test(p.x.Rewards.storeHTML(p.x.sheet)));
});

test('Shop button: between Leaders and Record, where rewards are shown or for a visitor with no club, gone where off or hidden', () => {
  const on = phone(); on.x.Rewards.navSync(); on.x.Rewards.navSync();
  assert.equal(on.nav.kids.filter(k => k.dataset.rw === 'shopnav').length, 1, 'drawn once');
  assert.equal(on.nav.kids.indexOf(shopBtn(on)), 0, 'inserted before Record');
  assert.match(shopBtn(on).innerHTML, />?Shop$/);
  assert.equal(shopBtn(on).hidden, false);
  const visitor = phone({ club: null }); visitor.x.Rewards.navSync();
  assert.ok(shopBtn(visitor) && !shopBtn(visitor).hidden, 'a visitor with no club still has the Shop');
  const off = phone({ club: { code: 'club-a', rewards: false } }); off.x.Rewards.navSync();
  assert.ok(!shopBtn(off), 'rewards off for the club: no button');
  const hidden = phone({ hide: true }); hidden.x.Rewards.navSync();
  assert.ok(!shopBtn(hidden), 'hidden on this phone: no button');
  assert.equal(hidden.calls.length, 0, 'drawing the button never calls the server');
});

test('Shop button shows a still dot while the daily spin is unused, and says so in its name; no dot once spun, or with the spin off', () => {
  const p = phone({ club: { code: 'club-a', rewards: true, mysteryBox: true } });
  p.x.Rewards.navSync();
  assert.ok(!shopBtn(p).dataset.dot, 'no dot until the server says the spin is free');
  p.x.rwSpinLearn({ spunToday: false, wonToday: 0 }); p.x.Rewards.navSync();
  assert.ok(shopBtn(p).dataset.dot);
  assert.match(shopBtn(p).innerHTML, /Shop<span class="vh">, daily spin ready<\/span>$/);
  p.x.rwSpinLearn({ spunToday: true, wonToday: 10 }); p.x.Rewards.navSync();
  assert.ok(!shopBtn(p).dataset.dot); assert.match(shopBtn(p).innerHTML, />?Shop$/);
  const off = phone(); off.x.rwSpinLearn({ spunToday: false, wonToday: 0 }); off.x.Rewards.navSync();
  assert.ok(!shopBtn(off).dataset.dot, 'the box and spin are off for this club');
});

test('Shop button opens the shop, or says what is missing: no club, no linked name', async () => {
  const ok = phone(); ok.listeners.forEach(f => f({ target: { closest: () => ({ dataset: { rw: 'shopnav' } }) } }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(ok.calls.map(c => c.action), ['rewards-catalog']);
  const none = phone({ club: null }); none.x.Rewards.openShop();
  assert.equal(none.x.sheet.view, 'rwstore');
  assert.match(none.x.Rewards.storeHTML(none.x.sheet), /Join a club to earn Dinks from games and spend them here\.[\s\S]*data-act="club-open"/);
  const anon = phone({ name: null }); anon.x.Rewards.openShop();
  assert.match(anon.x.Rewards.storeHTML(anon.x.sheet), /Pick your name in the club[\s\S]*data-act="whoami-open"/);
  assert.equal(none.calls.length + anon.calls.length, 0, 'no server call without a club or a name');
});
