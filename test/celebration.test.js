import test from 'node:test';
import assert from 'node:assert/strict';
import { page, section } from './helpers/app.js';

const html = page();
const Celebration = new Function(`${section('CELEBRATION')}\nreturn Celebration;`)();

test('Celebration.normalize defaults to off and unmuted, coercing invalid values safely', () => {
  assert.deepEqual(Celebration.normalize(null), { on: 0, muted: 0 });
  assert.deepEqual(Celebration.normalize(undefined), { on: 0, muted: 0 });
  assert.deepEqual(Celebration.normalize({}), { on: 0, muted: 0 });
  assert.deepEqual(Celebration.normalize('bad'), { on: 0, muted: 0 });
  assert.deepEqual(Celebration.normalize({ on: true, muted: false }), { on: 1, muted: 0 });
  assert.deepEqual(Celebration.normalize({ on: 1, muted: 1 }), { on: 1, muted: 1 });
  assert.deepEqual(Celebration.normalize({ on: 0, muted: 'yes' }), { on: 0, muted: 1 });
});

test('Celebration.justFinished is true only on the transition from no winner to team 0 or team 1', () => {
  assert.equal(Celebration.justFinished(null, 0), true);
  assert.equal(Celebration.justFinished(null, 1), true);
  assert.equal(Celebration.justFinished(null, null), false);
  assert.equal(Celebration.justFinished(0, 0), false);
  assert.equal(Celebration.justFinished(1, 1), false);
  assert.equal(Celebration.justFinished(0, 1), false);
  assert.equal(Celebration.justFinished(undefined, 0), false);
  assert.equal(Celebration.justFinished(null, 2), false);
});

test('Celebration.shouldConfetti and shouldSound honor off-by-default, reduced motion and mute', () => {
  // Off by default: neither confetti nor sound runs.
  assert.equal(Celebration.shouldConfetti({ on: 0, beforeWinner: null, winner: 0, reducedMotion: false }), false);
  assert.equal(Celebration.shouldSound({ on: 0, beforeWinner: null, winner: 0, muted: 0 }), false);

  // Enabled and unmuted without reduced motion: both run on finish.
  assert.equal(Celebration.shouldConfetti({ on: 1, beforeWinner: null, winner: 0, reducedMotion: false }), true);
  assert.equal(Celebration.shouldSound({ on: 1, beforeWinner: null, winner: 1, muted: 0 }), true);

  // Reduced motion suppresses confetti without suppressing unmuted sound.
  assert.equal(Celebration.shouldConfetti({ on: 1, beforeWinner: null, winner: 0, reducedMotion: true }), false);
  assert.equal(Celebration.shouldSound({ on: 1, beforeWinner: null, winner: 0, muted: 0 }), true);

  // Mute suppresses sound without suppressing confetti.
  assert.equal(Celebration.shouldConfetti({ on: 1, beforeWinner: null, winner: 1, reducedMotion: false }), true);
  assert.equal(Celebration.shouldSound({ on: 1, beforeWinner: null, winner: 1, muted: 1 }), false);

  // Already-finished or in-progress games never re-trigger.
  assert.equal(Celebration.shouldConfetti({ on: 1, beforeWinner: 0, winner: 0, reducedMotion: false }), false);
  assert.equal(Celebration.shouldSound({ on: 1, beforeWinner: 0, winner: 0, muted: 0 }), false);
  assert.equal(Celebration.shouldConfetti({ on: 1, beforeWinner: null, winner: null, reducedMotion: false }), false);
  assert.equal(Celebration.shouldSound({ on: 1, beforeWinner: null, winner: null, muted: 0 }), false);
});

test('Celebration.palette follows DESIGN.md Team Color Rule (blue = team 1, green = team 2)', () => {
  const team0 = Celebration.palette(0);
  const team1 = Celebration.palette(1);
  assert.ok(team0.includes('var(--blue)'), 'team 0 palette uses Court Blue');
  assert.ok(!team0.includes('var(--green)'), 'team 0 palette does not use Court Green');
  assert.ok(team1.includes('var(--green)'), 'team 1 palette uses Court Green');
  assert.ok(!team1.includes('var(--blue)'), 'team 1 palette does not use Court Blue');
});

test('win celebration UI, reduced-motion CSS and live game hooks are wired cleanly', () => {
  // Settings sheet exposes both controls with distinct labels and ARIA group labels.
  assert.match(html, /id="disp-c">Win celebration<\/span>[\s\S]*?data-celebration[\s\S]*?aria-labelledby="disp-c"/);
  assert.match(html, /id="disp-s">Celebration sound<\/span>[\s\S]*?data-celebration-sound[\s\S]*?aria-labelledby="disp-s"/);
  assert.match(html, /\['0', 'Sound on'\], \['1', 'Muted'\]/);

  // Click handlers update device-only storage and announce state changes.
  assert.match(html, /if \(ds\.celebration !== undefined\)[\s\S]*?setCelebration\(\{ on \}\)[\s\S]*?announce\(/);
  assert.match(html, /if \(ds\.celebrationSound !== undefined\)[\s\S]*?setCelebration\(\{ muted \}\)[\s\S]*?announce\(/);

  // Confetti overlay is decorative, non-blocking, opts in to motion under no-preference and hides under reduce.
  assert.match(html, /\.celebration-confetti \{[^}]*pointer-events: none;/);
  assert.match(html, /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.celebration-confetti i \{ animation: confetti-burst/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.celebration-confetti \{ display: none; \} \}/);
  assert.match(html, /burst\.setAttribute\('aria-hidden', 'true'\)/);

  // Triggered on local rally, shared rally, shared adoption and watch intent transitions.
  const calls = html.match(/celebrateWin\(beforeWinner, live\.state\.winner\)/g) || [];
  assert.equal(calls.length, 4, 'celebrateWin should be wired in local rally, serverRally, adoptShared and applyWatchIntent');
});
