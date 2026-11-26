// Victory sounds (WI-10): catalogue on the server, synthesised on the phone, silent until a tap or an enabled win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, SLOTS, clubLooksFrom, wornFrom } from '../api/_economyshop.js';
import { boxTiers } from '../api/_economybox.js';
import { module } from './helpers/app.js';

const IDS = ['sound-bell', 'sound-horn', 'sound-8bit', 'sound-drum', 'sound-crowd', 'sound-fanfare', 'sound-ascension'];

test('the seven sounds are sold at the upstream prices, Mythic never in the box, never shown to the club', () => {
  const sounds = CATALOGUE.filter(i => i.slot === 'sound');
  assert.deepEqual(sounds.map(i => [i.id, i.price, i.rarity]), [['sound-bell', 60, 'common'], ['sound-horn', 90, 'common'], ['sound-8bit', 105, 'common'], ['sound-drum', 135, 'rare'], ['sound-crowd', 150, 'rare'], ['sound-fanfare', 720, 'legendary'], ['sound-ascension', 3000, 'mythic']]);
  assert.ok(SLOTS.includes('sound'));
  const prizes = new Set(boxTiers().flatMap(t => t.items.map(i => i.id)));
  assert.deepEqual(IDS.filter(id => prizes.has(id)), IDS.filter(id => id !== 'sound-ascension'), 'a sound is a box prize unless it is Mythic');
  assert.deepEqual(clubLooksFrom([{ name_key: 'ana', slot: 'sound', item: 'sound-bell' }]), {}, 'a sound is only heard on the owner\'s phone');
  assert.equal(wornFrom([{ id: 'sound-horn', slot: 'sound', worn: true }]).sound, 'sound-horn');
});

// A fake Web Audio that counts what is created.
const audio = (state = 'running') => {
  const log = { ctx: 0, started: 0, closed: 0, resumed: 0, disconnected: 0, silent: 0, silentPaused: 0 };
  const node = () => ({ connect: n => n, disconnect() { log.disconnected++; }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, Q: { value: 0 }, start() { log.started++; }, stop() {} });
  class Ctx { constructor() { log.ctx++; this.currentTime = 0; this.sampleRate = 100; this.state = state; this.destination = {}; }
    resume() { log.resumed++; return log.holdResume ? new Promise(r => { log.release = () => { this.state = 'running'; r(); }; }) : (this.state = 'running', Promise.resolve()); }
    createGain() { return node(); } createOscillator() { return node(); } createBufferSource() { return node(); } createBiquadFilter() { return node(); }
    createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; } close() { log.closed++; } }
  return { log, Ctx };
};
const phone = ({ worn = '', shown = true, state = 'running', audioSession = false, hold = false } = {}) => {
  const a = audio(state), listeners = [], announced = [];
  a.log.holdResume = hold;
  class Audio { constructor(src) { a.log.silent = 0; a.log.src = src; } play() { a.log.silent++; return Promise.resolve(); } pause() { a.log.silentPaused++; } }
  const win = { AudioContext: a.Ctx, Audio, navigator: audioSession ? { audioSession: {} } : {} };
  const x = new Function('window', 'document', 'esc', 'announce', 'rwShown', 'rwCur', 'rwSecHead', 'rwShelf', 'btoa', module('economysound') + ';return { rwSoundPlay, rwPlayWinSound, rwSoundsSectionHTML, rwAudioUnlock, rwAudioRun, RW_SOUNDS };')(
    win, { addEventListener: (t, f) => listeners.push(f) }, String, m => announced.push(m), () => shown, () => ({ worn: { sound: worn } }), (t, n) => `<h3>${t}</h3><p>${n}</p>`, (c, s, items) => items.map(i => i.id).join(), btoa);
  return { ...x, a, announced, win, tap: id => listeners.forEach(f => f({ target: { closest: () => ({ dataset: { rwSound: id }, getAttribute: () => 'Play ' + id }) } })) };
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

test('a second play reuses the one context and cuts the first sound off', () => {
  const p = phone(); p.tap('sound-bell'); p.tap('sound-drum');
  assert.equal(p.a.log.ctx, 1, 'iOS caps live contexts, so there is one'); assert.equal(p.a.log.closed, 0); assert.equal(p.a.log.disconnected, 1);
});

// iOS Safari/PWA: the unlock helper (shared by the Shop preview and the win sound).
test('a suspended or interrupted context is resumed inside the tap, and notes wait until it runs', async () => {
  for (const state of ['suspended', 'interrupted']) {
    const p = phone({ state, hold: true });
    assert.equal(p.rwSoundPlay('sound-bell'), true);
    assert.equal(p.a.log.resumed >= 1, true, state + ': resume() is called synchronously in the tap');
    assert.equal(p.a.log.started, 1, state + ': only the one-sample unlock buffer started, no notes while the clock is frozen');
    p.a.log.release(); await new Promise(r => setImmediate(r));
    assert.ok(p.a.log.started >= 4, state + ': the notes are scheduled once it is running');
  }
});

test('the ringer switch is bypassed: audioSession playback where it exists, else a silent clip', () => {
  const a = phone({ audioSession: true }); a.tap('sound-bell');
  assert.equal(a.win.navigator.audioSession.type, 'playback'); assert.equal(a.a.log.silent, 0, 'no clip needed');
  const b = phone(); b.tap('sound-bell');
  assert.equal(b.a.log.silent, 1, 'the silent clip plays'); assert.match(b.a.log.src, /^data:audio\/wav;base64,UklGR/);
});

test('the win sound and the preview share one unlocked context; a failure never throws', () => {
  const p = phone({ worn: 'sound-bell' });
  p.tap('sound-horn'); assert.equal(p.rwPlayWinSound(), true); assert.equal(p.rwAudioRun(() => {}), true);
  assert.equal(p.a.log.ctx, 1);
  const none = new Function('window', 'document', 'btoa', module('economysound') + ';return rwAudioRun(() => {});')({}, { addEventListener() {} }, btoa);
  assert.equal(none, false, 'no Web Audio: false, no throw');
});

test('the shelf lists the sounds with the setting note', () => {
  const p = phone();
  const html = p.rwSoundsSectionHTML({}, { items: IDS.map(id => ({ id, slot: 'sound' })).concat([{ id: 'frame-court', slot: 'frame' }]) });
  assert.match(html, /Victory sounds/); assert.match(html, /Tap to hear it/); assert.ok(!html.includes('frame-court'));
  assert.equal(p.rwSoundsSectionHTML({}, { items: [] }), '');
});
