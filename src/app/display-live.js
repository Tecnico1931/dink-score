let display = DisplayPrefs.normalize(store.get('pb.display', {}));
let celebration = Celebration.normalize(store.get('pb.celebration', {}));
// The rewarded court theme worn on this phone (an item id like 'theme-neon', or ''), kept so the first paint is right before the club loads. economycelebrate.js owns it.
let shopTheme = (() => { const v = store.get('pb.shopTheme', ''); return typeof v === 'string' && DisplayPrefs.SHOP_BY_ITEM[v] ? v : ''; })();
const darkMQ = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyDisplay() {
  const r = document.documentElement;
  const res = DisplayPrefs.resolve(display, !!(darkMQ && darkMQ.matches), shopTheme);
  if (res.dataTheme) r.setAttribute('data-theme', res.dataTheme); else r.removeAttribute('data-theme');
  if (res.dataPalette) r.setAttribute('data-palette', res.dataPalette); else r.removeAttribute('data-palette');
  r.toggleAttribute('data-outdoor', res.outdoor); r.toggleAttribute('data-large', res.large);
  const cs = document.querySelector('meta[name=color-scheme]'); if (cs) cs.content = res.colorScheme;
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = res.themeColor;
}
function setDisplay(patch) { display = DisplayPrefs.normalize(Object.assign({}, display, patch)); store.set('pb.display', display); applyDisplay(); }
function setCelebration(patch) { celebration = Celebration.normalize(Object.assign({}, celebration, patch)); store.set('pb.celebration', celebration); }
applyDisplay();
if (darkMQ && darkMQ.addEventListener) {
  darkMQ.addEventListener('change', () => { applyDisplay(); if (typeof settingsOpen !== 'undefined' && settingsOpen) renderSettings(); });
}
window.addEventListener('storage', e => {
  if (e.key === 'pb.display') {
    display = DisplayPrefs.normalize(store.get('pb.display', {}));
    applyDisplay();
    if (typeof settingsOpen !== 'undefined' && settingsOpen) renderSettings();
    if (typeof clubSheet !== 'undefined' && clubSheet && clubSheet.view === 'you' && typeof renderClub === 'function') renderClub();
    if (typeof render === 'function') render();
  }
  if (e.key === 'pb.celebration') {
    celebration = Celebration.normalize(store.get('pb.celebration', {}));
    if (typeof settingsOpen !== 'undefined' && settingsOpen) renderSettings();
  }
});
// Screen readers: one live region that is never rebuilt (the court redraws itself every rally, which would drop its own announcements).
function announce(msg) {
  const el = document.getElementById('a11y-live'); if (!el) return;
  el.textContent = ''; clearTimeout(announce.t);
  announce.t = setTimeout(() => { el.textContent = msg; }, 60);
}
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch {} };
let confettiTimer = null;
function clearConfetti() {
  clearTimeout(confettiTimer); confettiTimer = null;
  document.querySelectorAll('.celebration-confetti').forEach(el => el.remove());
}
function launchConfetti(winner) {
  clearConfetti();
  const burst = document.createElement('div');
  burst.className = 'celebration-confetti';
  burst.setAttribute('aria-hidden', 'true');
  const colors = Celebration.palette(winner);
  for (let i = 0; i < 20; i++) {
    const piece = document.createElement('i');
    const angle = (Math.PI * 2 * i) / 20 + (i % 3) * .12;
    const dist = 18 + (i % 5) * 7;
    piece.style.setProperty('--confetti', colors[i % colors.length]);
    piece.style.setProperty('--x', `${(Math.cos(angle) * dist).toFixed(1)}vmin`);
    piece.style.setProperty('--y', `${(Math.sin(angle) * dist + 10).toFixed(1)}vmin`);
    piece.style.setProperty('--r', `${(i % 2 ? 1 : -1) * (120 + i * 14)}deg`);
    piece.style.setProperty('--d', `${(i % 4) * 18}ms`);
    burst.appendChild(piece);
  }
  document.body.appendChild(burst);
  confettiTimer = setTimeout(clearConfetti, 1100);
}
function playCelebrationSound() {
  // The shared, iOS-safe context from economysound.js (unlocked inside the tap, silent-switch bypass, waits until running).
  rwAudioRun(ctx => {
    const now = ctx.currentTime;
    [[523.25, 0], [659.25, .09], [783.99, .18]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + at);
      gain.gain.setValueAtTime(.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(.08, now + at + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, now + at + .26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + .28);
    });
  });
}
function celebrateWin(beforeWinner, winner) {
  if (!live || !live.open) return;
  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const opts = { on: celebration.on, beforeWinner, winner, reducedMotion, muted: celebration.muted };
  if (Celebration.shouldShopFx(opts) && typeof rwWinFx === 'function' && rwWinFx(winner, reducedMotion)) { /* a worn rewarded celebration replaces the default burst */ }
  else if (Celebration.shouldConfetti(opts)) launchConfetti(winner);
  if (Celebration.shouldSound(opts) && !(typeof rwPlayWinSound === 'function' && rwPlayWinSound())) playCelebrationSound(); // a worn victory sound replaces the default chime
}
// A win is not itself a tap, and iOS refuses to start audio outside one. So while this phone has Win celebration on and Sound on (the player's own
// opt-in), the first tap that finds the shared context not running unlocks it, and the win sound then plays. Off by default: no context before that.
// (touchend and click, not pointerdown: iOS only counts those as a gesture for audio.)
['touchend', 'click'].forEach(t => document.addEventListener(t, () => {
  if (celebration.on && !celebration.muted && typeof rwAudioUnlock === 'function' && !(rwAudioCtx && rwAudioCtx.state === 'running')) rwAudioUnlock();
}, true));
const TEAM_COLOR = ['var(--blue)', 'var(--green)'];
