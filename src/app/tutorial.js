/* ---------- first-visit tutorial ---------- */
let tourStep = store.get('pb.tutorialSeen', false) ? null : 0;
const isStandalone = (() => { try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } })();
const canInstall = !isStandalone && API_OK;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MARK_BALL = `<svg viewBox="0 0 64 64" aria-hidden="true"><g fill="#0E1726" opacity=".85"><circle cx="22" cy="22" r="4"/><circle cx="38" cy="18" r="4"/><circle cx="31" cy="32" r="4"/><circle cx="19" cy="40" r="4"/><circle cx="44" cy="36" r="4"/><circle cx="33" cy="47" r="4"/></g></svg>`;
function tourSteps() {
  const steps = [
    { title: 'Welcome to Dink Score', art: `<div class="art-mark">${MARK_BALL}</div><div class="art-words"><span>Score</span><span>Log</span><span>Rank</span></div>`,
      body: `<p>Keep score on court, track every result, and see who's on top. Here's a quick tour. It takes about 30 seconds.</p>` },
    { title: 'Set up a game', art: `<div class="mini-setup"><div class="mini-seg"><span>Doubles</span><span>Singles</span></div><div class="mini-team" style="--c:var(--blue)"><i></i><i></i></div><div class="mini-team" style="--c:var(--green)"><i></i><i></i></div><div class="mini-chips"><span class="on">Ana</span><span class="on">Ben</span><span>Cal</span><span>Dee</span></div></div>`,
      body: `<ul><li>On <b>Play</b>, pick doubles or singles, the scoring style, and the target score.</li><li>Type player names, or tap a <b>saved player</b> to drop them into the next open spot. Names are saved for next time.</li><li>Choose who <b>serves first</b>, then tap <b>Start game</b>.</li></ul>` },
    { title: 'Tap the side that won', art: `<div class="mini-court"><div class="mh a"><span class="srv">Serving</span>4</div><div class="mcall"><span>4</span><span>2</span><span>1</span></div><div class="mh b">2</div><span class="tap"></span></div>`,
      body: `<ul><li>After each rally, tap the half of the screen for the side that <b>won the rally</b>. The app applies the serving rules for you.</li><li>The white pill is the <b>score call</b> to say out loud. The yellow tag shows who serves, and from which side.</li><li>Mis-tap? Hit <b>Undo</b>. <b>Leave</b> lets you pause the game and come back later.</li></ul>` },
    { title: 'Log games from other courts', art: `<div class="mini-log"><span class="badge-live">Your game keeps going</span><div class="row" style="--c:var(--blue)"><i></i><b>11</b></div><div class="row" style="--c:var(--green)"><i></i><b>7</b></div><div class="save">Save result</div></div>`,
      body: `<p>Running more than one court? Tap <b>+ Log</b> while scoring, or <b>Log a result</b> on the home screen. Enter the players and final score. Your live game isn't affected, and logged games count toward the record and ratings.${API_OK ? ' With no club, results stay on this phone.' : ''}</p>` },
    { title: 'Climb the leaderboard', art: `<div class="mini-podium"><div class="p2"><b>3.82</b><small>2nd</small></div><div class="p1"><b>4.10</b><small>1st</small></div><div class="p3"><b>3.64</b><small>3rd</small></div></div>`,
      body: `<p>Every saved game updates each player's <b>Dink Rating</b>, from 2.00 to 8.00. Beat the forecast score and your rating rises, even in a loss. See the rankings, streaks and honors on <b>Leaders</b>.</p>` }
  ];
  if (API_OK) steps.push({ title: 'Play alone or with a club', art: `<div class="art-code"><b>K7P2QX</b><div class="phones"><i></i><i></i><i></i></div></div>`,
    body: `<p>You can start scoring right now, no club needed. Games stay on your phone, and after a game you can <b>Share</b> the result or <b>Save to a club</b>. To share one record with your friends, tap <b>Join a club</b> at the top and join with a code: everyone sees the same games, saved players and leaderboard. No accounts needed.</p>` });
  if (API_OK) steps.push({ title: 'Pick your name', art: `<div class="art-mark" style="background:#fff">${MARK_BALL}</div><div class="art-words"><span>Achievements</span><span>Challenges</span></div>`,
    body: `<p>When you join a club, pick your name. Games sent from your phone count toward your <b>achievements</b> and the weekly <b>challenges</b>, and you can set your own picture.</p>` });
  if (canInstall) steps.push({ title: 'Put it on your home screen', art: `<div class="mini-phone"><i></i><i></i><i></i><i></i><i class="app"></i><i></i><i></i><i></i><i></i></div>`,
    body: isIOS
      ? `<p>In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>. Dink Score opens full screen like an app and works without signal at the court.</p>`
      : `<p>In Chrome, tap the <b>⋮</b> menu, then <b>Install app</b> or <b>Add to Home screen</b>. Dink Score opens full screen like an app and works without signal at the court.</p>` });
  return steps;
}
/* ---------- what's new: shown once per phone after an update. Change NEWS.id (and the items) to show a new one. ---------- */
const NEWS = { id: '2026-11-20', title: "What's new", items: [
  ['🏆', 'Leagues and ladders', 'Organizers can run a league or ladder for the club. Results are kept if you lose signal and sent when you are back online, and a public league page lets anyone follow along without joining.'],
  ['🔑', 'Sign in with a passkey', 'Use your fingerprint, face or screen lock to sign in and <b>bring your clubs</b> to a new phone. Sign in now comes first when you have no club, and the app checks before making a new one if you already have some.'],
  ['⌚', 'Apple Watch', 'Score from your wrist and record the game as a pickleball workout. Needs the separate Dink Score watch app. In a club, open <b>Apple Watch</b> to link a watch; on the live game, tap <b>Link a watch</b> and scan its code to use it for just that game.'],
  ['📋', 'Your games across clubs', 'See your own games and rating from every club on this phone in one place, and download them as a CSV.'],
  ['🔗', 'Public result links', 'If your organizers turn it on, share a saved game as a link with a preview picture. Anyone can open it without joining.'],
  ['🎾', 'Open play court board', 'Courts, a queue and fair rotation for open play, with a big board for a TV at the courts.'],
  ['📣', 'Pickup sessions', 'Start a 24-hour session with its own code and QR. Results stay in the session unless a member saves them to a club.']
] };
// Someone opening the app for the first time gets the tour instead, so they never see old news.
if (!store.get('pb.tutorialSeen', false)) store.set('pb.newsSeen', NEWS.id);
let newsOpen = store.get('pb.newsSeen', '') !== NEWS.id, newsFrom = null;
function closeNews() {
  newsOpen = false; store.set('pb.newsSeen', NEWS.id); renderTour();
  if (newsFrom && newsFrom.isConnected) { try { newsFrom.focus({ preventScroll: true }); } catch {} }
  newsFrom = null;
}
function renderTour() {
  const root = $('#tour');
  if (tourStep === null && newsOpen && !(live && live.open)) {
    if (root.querySelector('.news')) return;
    newsFrom = document.activeElement;
    root.innerHTML = `<div class="tour-bg"><div class="tour news" role="dialog" aria-modal="true" aria-labelledby="news-h">
      <div class="tour-body"><span class="count">New in Dink Score</span><h2 id="news-h">${NEWS.title}</h2>
        <div class="news-list">${NEWS.items.map(([icon, t, body]) => `<div class="news-item"><span class="news-ic" aria-hidden="true">${icon}</span><div><b>${t}</b><p>${body}</p></div></div>`).join('')}</div></div>
      <div class="tour-foot"><button class="btn btn-ball" data-news="done" id="news-ok" style="flex:1">Got it</button></div>
    </div></div>`;
    const btn = $('#news-ok'); if (btn) { try { btn.focus({ preventScroll: true }); } catch {} }
    announce(`${NEWS.title}. ${NEWS.items.length} updates. Press Got it to close.`);
    return;
  }
  if (tourStep === null) { root.innerHTML = ''; return; }
  const steps = tourSteps();
  tourStep = Math.max(0, Math.min(tourStep, steps.length - 1));
  const s = steps[tourStep];
  const last = tourStep === steps.length - 1;
  root.innerHTML = `<div class="tour-bg"><div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-h">
    <div class="tour-art">${last ? '' : '<button class="tour-skip" data-tour="done">Skip</button>'}${s.art}</div>
    <div class="tour-body"><span class="count">Step ${tourStep + 1} of ${steps.length}</span><h2 id="tour-h">${s.title}</h2>${s.body}</div>
    <div class="tour-foot"><div class="dots" aria-hidden="true">${steps.map((_, i) => `<i class="${i === tourStep ? 'on' : ''}"></i>`).join('')}</div>
      ${tourStep > 0 ? '<button class="btn btn-soft" data-tour="back">Back</button>' : ''}
      <button class="btn ${last ? 'btn-ball' : 'btn-ink'}" data-tour="${last ? 'done' : 'next'}" id="tour-next">${last ? 'Start playing' : 'Next'}</button></div>
  </div></div>`;
  const btn = $('#tour-next'); if (btn) { try { btn.focus({ preventScroll: true }); } catch {} }
}
function closeTour() { tourStep = null; store.set('pb.tutorialSeen', true); renderTour(); }
let tourTouchX = null;
document.addEventListener('touchstart', e => { if (tourStep !== null && e.target.closest && e.target.closest('.tour')) tourTouchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', e => {
  if (tourStep === null || tourTouchX === null) return;
  const dx = e.changedTouches[0].clientX - tourTouchX; tourTouchX = null;
  if (Math.abs(dx) < 50) return;
  if (dx < 0 && tourStep < tourSteps().length - 1) tourStep++; else if (dx > 0 && tourStep > 0) tourStep--;
  renderTour();
}, { passive: true });

