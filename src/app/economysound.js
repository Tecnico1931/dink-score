/* ---------- rewards: victory sounds (WI-10; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Five short sounds the phone makes itself with Web Audio (no audio files, no new hosts). Which one you own and wear is the server's
// (api/_economyshop.js, slot `sound`); this file only draws the shelf and plays tones. Sound is off until the player turns it on, per device:
//   - a tap on a play button is the consent, so the preview works even when the win sound is muted;
//   - a win plays the worn sound only through rwPlayWinSound(), which celebrateWin calls after Celebration.shouldSound says the device
//     has Win celebration on and Sound on; the default chime plays when nothing is worn.
// No AudioContext exists until one of those two happens, and nothing plays while rewards are hidden on this phone.
// One step: a tone { f, to?, at, dur, vol, type } or a noise burst { noise: bandpass Hz, q, at, dur, vol, rise? }. Times in seconds.
const RW_SOUNDS = {
  'sound-bell': { dur: 1.5, steps: [{ f: 880, at: 0, dur: 1.4, vol: .12 }, { f: 1320, at: 0, dur: 1, vol: .05 }, { f: 2217, at: 0, dur: .6, vol: .04 }] },
  'sound-horn': { dur: 1.1, steps: [{ f: 233, at: 0, dur: .38, vol: .07, type: 'sawtooth' }, { f: 311, at: 0, dur: .38, vol: .06, type: 'sawtooth' }, { f: 233, at: .46, dur: .55, vol: .07, type: 'sawtooth' }, { f: 311, at: .46, dur: .55, vol: .06, type: 'sawtooth' }] },
  'sound-8bit': { dur: 1, steps: [[523.25, 0], [659.25, .1], [783.99, .2], [1046.5, .3]].map(([f, at]) => ({ f, at, dur: .1, vol: .05, type: 'square' })).concat([{ f: 1046.5, at: .4, dur: .5, vol: .05, type: 'square' }, { f: 1318.5, at: .4, dur: .5, vol: .03, type: 'square' }]) },
  'sound-drum': { dur: 1.5, steps: Array.from({ length: 16 }, (_, i) => ({ noise: 220, q: 1.2, at: i * .06, dur: .05, vol: .05 + i * .004 })).concat([{ noise: 140, q: .8, at: 1.02, dur: .35, vol: .16 }, { f: 90, to: 50, at: 1.02, dur: .35, vol: .18 }]) },
  // WI-13: the two top sounds. Fanfare: four brass-like notes up a major chord. Ascension: a slow rise that ends on a bright chord.
  'sound-fanfare': { dur: 1.6, steps: [[523.25, 0, .14], [659.25, .16, .14], [783.99, .32, .14], [1046.5, .5, 1]].flatMap(([f, at, dur]) => [{ f, at, dur, vol: .05, type: 'sawtooth' }, { f: f * 1.5, at, dur, vol: .025, type: 'sawtooth' }]) },
  'sound-ascension': { dur: 3.2, steps: [{ f: 220, to: 1760, at: 0, dur: 1.8, vol: .07 }, { f: 330, to: 2637, at: 0, dur: 1.8, vol: .03 }].concat([1046.5, 1318.5, 1568, 2093].map((f, i) => ({ f, at: 1.8 + i * .03, dur: 1.3, vol: .05 - i * .008 }))) },
  'sound-bells': { dur: 1.5, steps: [2093, 2637, 3136, 2349, 2793, 3520, 2637, 3136].map((f, i) => ({ f, at: i * .09, dur: .5, vol: .04 })).concat([{ f: 1319, at: 0, dur: 1, vol: .05 }]) }, // Christmas shelf
  'sound-whistle': { dur: 1, steps: [{ f: 2700, to: 2900, at: 0, dur: .2, vol: .07 }, { f: 2900, at: .26, dur: .6, vol: .07 }] }, // the pass-only Ref's whistle
  'sound-crowd': { dur: 2, steps: [{ noise: 900, q: .5, at: 0, dur: 1.9, vol: .16, rise: .6 }, { noise: 2400, q: .7, at: .15, dur: 1.5, vol: .05, rise: .5 }] }
};
let rwSoundCtx = null, rwSoundTimer = 0;
// Fixed noise, so a sound is the same every time.
function rwNoiseBuffer(ctx) {
  const len = ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let x = 12345;
  for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; d[i] = x / 0x3fffffff - 1; }
  return buf;
}
function rwStopSound() {
  clearTimeout(rwSoundTimer);
  if (rwSoundCtx) { try { rwSoundCtx.close(); } catch {} rwSoundCtx = null; }
}
// Play one sound by id. Returns true when it started. Only called from a tap or an enabled win.
function rwSoundPlay(id) {
  const snd = RW_SOUNDS[id];
  if (!snd) return false;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    rwStopSound();
    const ctx = rwSoundCtx = new Ctx();
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    const t0 = ctx.currentTime, noiseBuf = snd.steps.some(s => s.noise) ? rwNoiseBuffer(ctx) : null;
    for (const s of snd.steps) {
      const at = t0 + s.at, end = at + s.dur, gain = ctx.createGain(), src = s.noise ? ctx.createBufferSource() : ctx.createOscillator();
      if (s.noise) {
        src.buffer = noiseBuf; src.loop = true;
        const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = s.noise; band.Q.value = s.q || 1;
        src.connect(band); band.connect(gain);
      } else {
        src.type = s.type || 'sine'; src.frequency.setValueAtTime(s.f, at);
        if (s.to) src.frequency.exponentialRampToValueAtTime(s.to, end);
        src.connect(gain);
      }
      const peak = at + (s.rise ? s.dur * s.rise : Math.min(.015, s.dur / 4));
      gain.gain.setValueAtTime(.0001, at);
      gain.gain.exponentialRampToValueAtTime(s.vol, peak);
      gain.gain.exponentialRampToValueAtTime(.0001, end);
      gain.connect(ctx.destination);
      src.start(at); src.stop(end + .02);
    }
    rwSoundTimer = setTimeout(rwStopSound, (snd.dur + .3) * 1000);
    return true;
  } catch { return false; }
}
// The sound worn on this phone, or '' (rewards hidden, off, or none worn).
const rwWornSound = () => {
  if (!rwShown()) return '';
  const id = rwCur().worn.sound;
  return RW_SOUNDS[id] ? id : '';
};
// A win just ended and the device's own sound setting allows it: play the worn victory sound. False means "nothing worn, play the default".
const rwPlayWinSound = () => { const id = rwWornSound(); return id ? rwSoundPlay(id) : false; };

const RW_PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6.5v11l9-5.5z" fill="currentColor"/></svg>';
const RW_NOTE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 17V6l9-2v11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7" cy="17" r="2.4" fill="currentColor"/><circle cx="16" cy="15" r="2.4" fill="currentColor"/></svg>';
const rwSoundPlayBtn = it => `<button type="button" class="rw-play" data-rw-sound="${esc(it.id)}" aria-label="Play ${esc(it.name)}">${RW_PLAY_SVG}</button>`;
// The "Victory sounds" shelf: the same card as every other shelf, with a play button in the preview well.
function rwSoundsSectionHTML(c, s) {
  const items = (s.items || []).filter(i => i.slot === 'sound' && i.rarity !== 'legendary' && i.rarity !== 'mythic');
  if (!items.length) return '';
  return `${rwSecHead('Victory sounds', 'Plays on the scoring phone when your team wins. Tap to hear it.')}${rwShelf(c, s, items)}<p class="rw-box-fine">A win plays it only when Win celebration is on and Celebration sound is on in Settings. Off until you turn it on, per device.</p>`;
}
// A play button plays its sound at once: the tap is the consent, even when the win sound is muted. Never reached when rewards are hidden.
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-rw-sound]');
  if (!b || !rwShown()) return;
  if (rwSoundPlay(b.dataset.rwSound)) announce('Playing ' + (b.getAttribute('aria-label') || '').replace(/^Play /, '') + '.');
});
