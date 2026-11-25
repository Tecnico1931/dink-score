// Victory sounds (WI-10): catalogue on the server, synthesised on the phone, silent until a tap or an enabled win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, SLOTS, clubLooksFrom, wornFrom } from '../api/_economyshop.js';
import { BOX_TIERS } from '../api/_economybox.js';
import { module } from './helpers/app.js';

const IDS = ['sound-bell', 'sound-horn', 'sound-8bit', 'sound-drum', 'sound-crowd', 'sound-fanfare', 'sound-ascension'];

test('the seven sounds are sold at the upstream prices, never in the box, never shown to the club', () => {
  const sounds = CATALOGUE.filter(i => i.slot === 'sound');
  assert.deepEqual(sounds.map(i => [i.id, i.price, i.rarity]), [['sound-bell', 60, 'common'], ['sound-horn', 90, 'common'], ['sound-8bit', 105, 'common'], ['sound-drum', 135, 'rare'], ['sound-crowd', 150, 'rare'], ['sound-fanfare', 720, 'legendary'], ['sound-ascension', 3000, 'mythic']]);
  assert.ok(SLOTS.includes('sound'));
  assert.ok(!BOX_TIERS.some(t => t.items.some(id => IDS.includes(id))), 'a sound is not a box prize');
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'sound', item: 'sound-bell' }]), {}, 'a sound is only heard on the owner\'s phone');
  assert.equal(wornFrom([{ id: 'sound-horn', slot: 'sound', worn: true }]).sound, 'sound-horn');
});

// A fake Web Audio that counts what is created.
const audio = () => {
  const log = { ctx: 0, started: 0, closed: 0 };
  const node = () => ({ connect: n => n, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, Q: { value: 0 }, start() { log.started++; }, stop() {} });
  class Ctx { constructor() { log.ctx++; this.currentTime = 0; this.sampleRate = 100; this.state = 'running'; this.destination = {}; }
    createGain() { return node(); } createOscillator() { return node(); } createBufferSource() { return node(); } createBiquadFilter() { return node(); }
    createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; } close() { log.closed++; } }
  return { log, Ctx };
};
const phone = ({ worn = '', shown = true } = {}) => {
  const a = audio(), listeners = [], announced = [];
  const win = { AudioContext: a.Ctx };
  const x = new Function('window', 'document', 'esc', 'announce', 'rwShown', 'rwCur', 'rwSecHead', 'rwShelf', module('economysound') + ';return { rwSoundPlay, rwPlayWinSound, rwSoundsSectionHTML, RW_SOUNDS };')(
    win, { addEventListener: (t, f) => listeners.push(f) }, String, m => announced.push(m), () => shown, () => ({ worn: { sound: worn } }), (t, n) => `<h3>${t}</h3><p>${n}</p>`, (c, s, items) => items.map(i => i.id).join());
  return { ...x, a, announced, tap: id => listeners.forEach(f => f({ target: { closest: () => ({ dataset: { rwSound: id }, getAttribute: () => 'Play ' + id }) } })) };
};

test('no audio context exists until a tap or an enabled win', () => {
  const p = phone({ worn: 'sound-bell' });
  assert.equal(p.a.log.ctx, 0, 'loading the page makes no AudioContext');
  assert.equal(p.rwPlayWinSound(), true);
  assert.equal(p.a.log.ctx, 1);
});

test('every sound plays on a tap and each one makes noise', () => {
  for (const id of IDS) { const p = phone(); p.tap(id); assert.equal(p.a.log.ctx, 1, id); assert.ok(p.a.log.started >= 2, id + ' starts nodes'); assert.match(p.announced[0], /Playing/); }
  const p = phone(); assert.equal(p.rwSoundPlay('sound-nope'), false); assert.equal(p.a.log.ctx, 0, 'an unknown id plays nothing');
});

test('a worn sound replaces the default chime at a win; none worn or rewards hidden stays silent here', () => {
  assert.equal(phone().rwPlayWinSound(), false, 'nothing worn: the caller plays the default chime');
  const hidden = phone({ worn: 'sound-horn', shown: false });
  assert.equal(hidden.rwPlayWinSound(), false); hidden.tap('sound-horn');
  assert.equal(hidden.a.log.ctx, 0, 'hidden rewards: no sound and no context');
});

test('a second play closes the first context', () => {
  const p = phone(); p.tap('sound-bell'); p.tap('sound-drum');
  assert.equal(p.a.log.ctx, 2); assert.equal(p.a.log.closed, 1);
});

test('the shelf lists the sounds with the setting note', () => {
  const p = phone();
  const html = p.rwSoundsSectionHTML({}, { items: IDS.map(id => ({ id, slot: 'sound' })).concat([{ id: 'frame-court', slot: 'frame' }]) });
  assert.match(html, /Victory sounds/); assert.match(html, /Tap to hear it/); assert.ok(!html.includes('frame-court'));
  assert.equal(p.rwSoundsSectionHTML({}, { items: [] }), '');
});
