// WCAG 2.x contrast of every text/background pair the CSS tokens make, in each theme, plus the court's team colours.
// Reads dink-score.html itself, so a token change that drops a pair under its threshold fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { page, section } from './helpers/app.js';

const html = page();
const tokenBlock = section('TOKENS');
const hexRgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const vars = body => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,6})\b/g)].map(m => [m[1], hexRgb(m[2])]));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockVars = (src, sel) => {
  const m = new RegExp(`(?:^|[\\n{]\\s*)${escRe(sel)}\\s*\\{([^}]*)\\}`).exec(src);
  assert.ok(m, `missing CSS token block for ${sel}`);
  return vars(m[1]);
};
// Each palette x mode starts from the :root defaults, then layers its overrides exactly as the browser cascade does.
const light = blockVars(tokenBlock, ':root');
const dark = Object.assign({}, light, blockVars(tokenBlock, ':root[data-theme="dark"]'));
const outdoor = Object.assign({}, light, blockVars(tokenBlock, ':root[data-outdoor]'));
const paletteOutdoorBase = blockVars(tokenBlock, ':root[data-palette][data-outdoor]');
const PALETTE_IDS = ['green', 'blue', 'clay', 'violet', 'sunset', 'slate'];
const palettes = {
  green: { light, dark, mediaDark: Object.assign({}, light, blockVars(tokenBlock, ':root:not([data-theme="light"])')), outdoor }
};
for (const id of PALETTE_IDS.slice(1)) {
  const pLightOverrides = blockVars(tokenBlock, `:root[data-palette="${id}"]`);
  const pLight = Object.assign({}, light, pLightOverrides);
  const pDarkBase = Object.assign({}, dark, pLightOverrides);
  const pDark = Object.assign({}, pDarkBase, blockVars(tokenBlock, `:root[data-palette="${id}"][data-theme="dark"]`));
  const pMediaDark = Object.assign({}, pDarkBase, blockVars(tokenBlock, `:root[data-palette="${id}"]:not([data-theme="light"])`));
  const pOutdoor = Object.assign({}, pLight, paletteOutdoorBase, blockVars(tokenBlock, `:root[data-palette="${id}"][data-outdoor]`));
  palettes[id] = { light: pLight, dark: pDark, mediaDark: pMediaDark, outdoor: pOutdoor };
}
const WHITE = [255, 255, 255];

// [foreground, background, minimum, what]: 4.5 for text, 3 for large text and UI components (WCAG 1.4.3, 1.4.11).
const pairs = (t, mode, id) => [
  [t.ink, t.bg, 4.5, 'body text'], [t.ink, t.surface, 4.5, 'text on cards'], [t.ink, t['surface-2'], 4.5, 'text on soft buttons'],
  [t.muted, t.bg, 4.5, 'muted text on page'], [t.muted, t.surface, 4.5, 'muted text on cards'], [t.muted, t['surface-2'], 4.5, 'muted text on soft buttons'],
  [t.bg, t.ink, 4.5, '.btn-ink'], [WHITE, t.blue, 4.5, 'white on blue (team 1)'], [WHITE, t.green, 4.5, 'white on green (team 2)'],
  [WHITE, t.accent, 4.5, 'white on accent (.btn-accent)'],
  [t['ball-ink'], t.ball, 7, 'text on the ball highlight'], [t.danger, t.surface, 4.5, 'error text on cards'], [t.danger, t.bg, 4.5, 'error text on page'],
  [mode === 'dark' ? t.bg : WHITE, t.danger, 4.5, '.btn-danger label'],
  [t.up, t.surface, 4.5, 'rating up'], [t.up, t['surface-2'], 4.5, 'rating up on soft cards'], [t.down, t['surface-2'], 4.5, 'rating down on soft cards'], [t.down, t.surface, 4.5, 'rating down'],
  [t.focus, t.bg, 3, 'focus ring on page'], [t.focus, t.surface, 3, 'focus ring on cards'],
  [t['blue-text'], t.surface, 4.5, 'blue text on cards'], [t['blue-text'], t.bg, 4.5, 'blue text on page'],
  [t['accent-text'], t.surface, 4.5, 'accent text on cards'], [t['accent-text'], t.bg, 4.5, 'accent text on page'],
  // Bottom bar: the active tab's grey pill is ink at 9% over the bar's translucent surface (or the page behind it).
  ...[['surface', t.surface], ['page', t.bg]].flatMap(([n, b]) => { const hl = over(t.ink, b, 0.09); return [[t['accent-text'], hl, 4.5, `active tab label and icon (accent-text) on its highlight over ${n}`], [t.ink, b, 4.5, `inactive tab label over ${n}`]]; }),
  [t.accent, t.surface, 3, 'accent marks on cards'], [t.accent, t['surface-2'], 3, 'accent rings on soft rows'],
  ...(id === 'green' && mode === 'dark' ? [] : [[t['court-ring'], t.surface, 3, 'court-ring on cards'], [t['court-ring'], t['surface-2'], 3, 'court-ring on soft cards']]),
  [t.green, t.surface, 3, 'green marks on cards'], [t.green, t['surface-2'], 3, 'green rings on soft rows'],
  [t.blue, t.surface, 3, 'blue marks on cards'], [t.blue, t['surface-2'], 3, 'blue rings on soft rows'],
  [t.ink, t['surface-2'], 3, 'ink rings on soft rows'],
  [t.ball, t['court-2'], 3, 'ball highlight on --court-2'],
  [t['dsp-ink'], t['dsp-bg'], 7, 'TV display primary text on ground'], [t['dsp-ink'], t['dsp-surface'], 7, 'TV display primary text on card'],
  [t.ball, t['dsp-bg'], 7, 'TV display ball accent on ground'], [t.ball, t['dsp-surface'], 7, 'TV display ball accent on card'],
  [t['dsp-muted'], t['dsp-bg'], 4.5, 'TV display muted text on ground'], [t['dsp-muted'], t['dsp-surface'], 4.5, 'TV display muted text on card'],
  [t['dsp-dim'], t['dsp-bg'], 4.5, 'TV display dim text on ground'],
  ...['rare', 'legendary', 'mythic', 'shiny'].map(k => [t[k + '-fg'], t[k + '-bg'], 4.5, `${k} badge text on its chip`])
];
for (const id of PALETTE_IDS) {
  for (const mode of ['light', 'dark', 'outdoor']) {
    const t = palettes[id][mode];
    test(`token contrast: ${id} (${mode})`, () => {
      for (const [fg, bg, min, what] of pairs(t, mode, id)) {
        assert.ok(ratio(fg, bg) >= min, `${id}/${mode}: ${what} is ${ratio(fg, bg).toFixed(2)}:1, needs ${min}:1`);
      }
    });
    // The court hero card and New game tile (white on --court, dimmed to .92 for secondary text) over the worst end of each gradient. Log a result is a plain surface tile (ink on --surface is pinned above).
    test(`hero card, New game and Log a result tiles: contrast ${id} (${mode})`, () => {
      const courtMin = mode === 'outdoor' ? 7 : 4.5;
      for (const k of ['court', 'court-2']) {
        assert.ok(ratio(WHITE, t[k]) >= courtMin, `${id}/${mode}: white on --${k} ${ratio(WHITE, t[k]).toFixed(2)}, needs ${courtMin}`);
        assert.ok(ratio(over(WHITE, t[k], .92), t[k]) >= 4.5, `${id}/${mode}: .92 white on --${k} ${ratio(over(WHITE, t[k], .92), t[k]).toFixed(2)}`);
        assert.ok(ratio(over(WHITE, over([0, 0, 0], t[k], .22), .92), over([0, 0, 0], t[k], .22)) >= 4.5, `${id}/${mode}: club pill on --${k}`);
      }
      assert.ok(ratio(t.bg, t.ink) >= 4.5, `${id}/${mode}: Log a result plus sign (--bg on --ink)`);
    });
    test(`pet badge colours (classic and shiny): contrast ${id} (${mode})`, () => {
      const petPairs = [
        [t.green, t['surface-2'], 3, 'classic pet body (--pet-1) on soft badge (--surface-2)'],
        [t.green, t.surface, 3, 'classic pet body (--pet-1) on card badge (--surface)'],
        [t.ball, t.green, 3, 'classic pet lime accent (--pet-2) on body (--green)'],
        [t['on-court'], t.green, 4.5, 'classic pet eye (--pet-eye) on body (--green)'],
        [t.blue, t['surface-2'], 3, 'shiny pet body (--pet-1) on soft badge (--surface-2)'],
        [t.blue, t.surface, 3, 'shiny pet body (--pet-1) on card badge (--surface)'],
        [t.ball, t.blue, 3, 'shiny pet lime accent and star (--pet-2) on body (--blue)'],
        [t['on-court'], t.blue, 4.5, 'shiny pet eye (--pet-eye) on body (--blue)'],
        [t['ball-ink'], t.ball, 4.5, 'pet ink details (--pet-3) on lime (--ball)'],
        [t['ball-ink'], t['on-court'], 4.5, 'pet ink pupils (--pet-3) on eye (--on-court)']
      ];
      for (const [fg, bg, min, what] of petPairs) {
        assert.ok(ratio(fg, bg) >= min, `${id}/${mode}: ${what} is ${ratio(fg, bg).toFixed(2)}:1, needs ${min}:1`);
      }
    });
  }
}
test('all 6 palettes lock Team 1, Team 2 and pickleball tokens and match @media dark with data-theme="dark"', () => {
  for (const id of PALETTE_IDS) {
    assert.deepEqual(palettes[id].mediaDark, palettes[id].dark, `${id}: @media dark must match [data-theme="dark"]`);
    for (const mode of ['light', 'dark', 'outdoor']) {
      for (const locked of ['blue', 'blue-text', 'green', 'ball', 'ball-ink', 'ball-hi', 'ball-lo']) {
        assert.deepEqual(palettes[id][mode][locked], palettes.green[mode][locked], `${id}/${mode}: --${locked} must stay locked`);
      }
    }
  }
});
test('the court tokens exist in every theme and the page glow is gone before muted text', () => {
  for (const k of ['court', 'court-2', 'court-ring', 'accent', 'accent-text', 'ball-hi', 'ball-lo', 'on-court']) assert.ok(light[k], `--${k} in light`);
  assert.match(html, /body \{ background: radial-gradient\(90% 190px at 50% -40px/, 'a short glow: it fades out by about 130 px');
});
test('pet CSS uses existing theme custom properties only (no hard-coded hex colours or motion)', () => {
  const petCss = html.slice(html.indexOf('.rw-pet {'), html.indexOf('.me-btn.frame-crown::before'));
  assert.ok(petCss.length > 0, 'pet CSS block exists');
  assert.match(petCss, /--pet-bg:\s*var\(--surface-2\)/);
  assert.match(petCss, /--pet-1:\s*var\(--green\)/);
  assert.match(petCss, /--pet-2:\s*var\(--ball\)/);
  assert.match(petCss, /--pet-3:\s*var\(--ball-ink\)/);
  assert.match(petCss, /--pet-eye:\s*var\(--on-court\)/);
  assert.match(petCss, /\[data-pet-shiny="true"\]\s*\{[^}]*--pet-1:\s*var\(--blue\)/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(petCss), 'pet CSS must not hard-code hex colours');
  assert.ok(!/animation|transition|@keyframes/.test(petCss), 'pet CSS stays calm with no motion');
});
test('danger buttons: label colour passes in every theme', () => {
  // .btn-danger paints text #fff on --danger; dark mode lightens --danger, so its label flips to the dark background colour.
  for (const [name, t] of [['light', light], ['outdoor', outdoor]]) assert.ok(ratio(WHITE, t.danger) >= 4.5, `${name}: white on danger ${ratio(WHITE, t.danger).toFixed(2)}`);
  assert.ok(ratio(dark.bg, dark.danger) >= 4.5, 'dark: bg on danger');
  assert.match(html, /:root\[data-theme="dark"\] \.btn-danger \{ color: var\(--bg\); \}/);
  assert.match(html, /prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \.btn-danger \{ color: var\(--bg\)/);
});

test('leaders podium: avatar initials and rank pedestal pass contrast in every theme', () => {
  const css = html.split('</style>')[0];
  const rule = sel => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `missing CSS rule for ${sel}`);
    return m[1];
  };
  const prop = (body, name) => {
    const m = new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`).exec(body);
    return m ? m[1].trim() : null;
  };
  const resolve = (val, t, cVar) => {
    if (val === 'var(--c)') return resolve(cVar, t);
    const v = /^var\(--([\w-]+)\)$/.exec(val);
    if (v) { assert.ok(t[v[1]], `unknown token --${v[1]}`); return t[v[1]]; }
    if (/^#[0-9A-Fa-f]{3,6}$/.test(val)) return hexRgb(val);
    assert.fail(`unhandled podium color value: ${val}`);
  };
  const avBase = rule('.step .avatar'), av1 = rule('.step.s1 .avatar');
  const blBase = rule('.step .block'), bl1 = rule('.step.s1 .block');
  const avColors = /const avatarColor = \[([^\]]+)\]/.exec(html);
  assert.ok(avColors, 'missing avatarColor array for leaders podium');
  const stepC = [...avColors[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.equal(stepC.length, 3, 'expected 3 podium avatar colors');

  const specs = [
    ['podium #1 avatar', prop(av1, 'color') || prop(avBase, 'color'), prop(av1, 'background') || prop(avBase, 'background'), stepC[0]],
    ['podium #2 avatar', prop(avBase, 'color'), prop(avBase, 'background'), stepC[1]],
    ['podium #3 avatar', prop(avBase, 'color'), prop(avBase, 'background'), stepC[2]],
    ['podium #1 block', prop(bl1, 'color') || prop(blBase, 'color'), prop(bl1, 'background') || prop(blBase, 'background'), stepC[0]],
    ['podium #2/#3 block', prop(blBase, 'color'), prop(blBase, 'background'), stepC[1]],
  ];
  for (const [name, t] of [['light', light], ['dark', dark], ['outdoor', outdoor]]) {
    for (const [what, fgVal, bgVal, cVar] of specs) {
      assert.ok(fgVal && bgVal, `${what}: missing color or background`);
      const fg = resolve(fgVal, t, cVar), bg = resolve(bgVal, t, cVar);
      assert.ok(ratio(fg, bg) >= 4.5, `${name}: ${what} (${fgVal} on ${bgVal}) is ${ratio(fg, bg).toFixed(2)}:1, needs 4.5:1`);
    }
  }
});

// The court: white text over each team's gradient, at the lightest end (the worst case) and at the dimmed "idle" half.
const a11y = section('A11Y');
const halfVars = sel => { const m = new RegExp(sel.replace(/[[\]"]/g, '\\$&') + ' \\{[^}]*?--c1: (#[0-9A-Fa-f]{6}); --c2: (#[0-9A-Fa-f]{6})').exec(a11y); assert.ok(m, 'no court colours for ' + sel); return [hexRgb(m[1]), hexRgb(m[2])]; };
for (const [name, sel] of [['team 1', '.half'], ['team 2', '.half[data-k="b"]'], ['outdoor team 1', ':root[data-outdoor] .half'], ['outdoor team 2', ':root[data-outdoor] .half[data-k="b"]']]) {
  test(`court contrast: ${name}`, () => {
    const out = name.startsWith('outdoor');
    for (const c of halfVars(sel)) {
      for (const [alpha, what] of [[1, 'score and names on the active half'], [0.92, 'names'], [0.94, 'side box']]) {
        const a = out ? 1 : alpha; // outdoor mode draws every court text at full opacity
        assert.ok(ratio(over(WHITE, c, a), c) >= 4.5, `${name} ${what} at ${a}: ${ratio(over(WHITE, c, a), c).toFixed(2)}:1`);
      }
      const idle = over([6, 10, 16], c, 0.3); // the .idle overlay only darkens, so white text gets stronger
      assert.ok(ratio(WHITE, idle) >= ratio(WHITE, c));
    }
  });
}
test('court: ball highlight text, call pill and toast pass', () => {
  assert.ok(ratio(light['ball-ink'], light.ball) >= 7);
  assert.ok(ratio(over(WHITE, [15, 22, 34], 0.8), [15, 22, 34]) >= 4.5, 'call labels on the dark pill');
  assert.ok(ratio(over(WHITE, [10, 17, 27], 0.9), [10, 17, 27]) >= 4.5, 'who serves note');
});

// Text size and the display setting are plain CSS, so pin them here.
test('no text under 12px outside the decorative tour art', () => {
  const css = html.split('</style>')[0];
  const small = css.split('\n').filter(l => /font-size:\s*(9|10|11)(\.\d)?px/.test(l) && !/\.mini/.test(l));
  assert.deepEqual(small, []);
});
test('outdoor display: every court text is opaque and the display setting is wired', () => {
  assert.match(a11y, /:root\[data-outdoor\] \.names span[^}]*opacity: 1/);
  assert.match(html, /store\.get\('pb\.display'/);
  assert.match(html, /data-act="display"[^>]*aria-pressed/);
  assert.match(html, /id="a11y-live"[^>]*aria-live="polite"/);
});

// Watch score screen must match the phone's team-colour rule (team 0 = court blue on top, team 1 = court green below)
// and pass WCAG AA contrast for white ink and the ball-yellow serving dot on OLED in both active and dimmed states.
test('watch score screen: team colours match phone court and pass contrast', () => {
  const swift = fs.readFileSync(new URL('../watch/DinkWatch/Views/ScoreView.swift', import.meta.url), 'utf8');
  const swiftHex = name => {
    const m = new RegExp(`static let ${name}\\s*=\\s*0x([0-9A-Fa-f]{6})\\b`).exec(swift);
    assert.ok(m, `missing watch colour constant ${name}`);
    return hexRgb(m[1]);
  };
  const team0 = [swiftHex('team0Top'), swiftHex('team0Bottom')];
  const team1 = [swiftHex('team1Top'), swiftHex('team1Bottom')];
  const ball = swiftHex('ball');
  assert.deepEqual(team0, halfVars('.half'), 'watch team 0 must match phone team 1 (court blue)');
  assert.deepEqual(team1, halfVars('.half[data-k="b"]'), 'watch team 1 must match phone team 2 (court green)');
  assert.deepEqual(ball, light.ball, 'watch serving dot must match ball yellow');
  assert.ok(swift.indexOf('teamButton(0)') !== -1 && swift.indexOf('teamButton(0)') < swift.indexOf('teamButton(1)'),
    'watch must render team 0 on top and team 1 below, matching the phone');
  for (const [label, stops] of [['watch team 0 (blue)', team0], ['watch team 1 (green)', team1]]) {
    for (const c of stops) {
      assert.ok(ratio(WHITE, c) >= 4.5, `${label} active white text: ${ratio(WHITE, c).toFixed(2)}:1`);
      assert.ok(ratio(ball, c) >= 4.5, `${label} serving dot: ${ratio(ball, c).toFixed(2)}:1`);
      const idle = over([6, 10, 16], c, 0.3);
      assert.ok(ratio(over(WHITE, idle, 0.9), idle) >= 4.5, `${label} idle white text: ${ratio(over(WHITE, idle, 0.9), idle).toFixed(2)}:1`);
    }
  }
});

test('appearance setting: light, dark and match-phone tokens, color-scheme and Settings sheet', () => {
  // :root defaults to light dark; explicit light and dark themes both set color-scheme, and @media dark respects data-theme="light".
  assert.match(tokenBlock, /:root\s*\{[\s\S]*?color-scheme:\s*light dark;/);
  assert.match(tokenBlock, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(tokenBlock, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(tokenBlock, /:root\[data-theme="dark"\]\s*\{[\s\S]*?color-scheme:\s*dark;/);
  // Media-query dark block uses the exact same dark tokens as :root[data-theme="dark"].
  const mediaDark = Object.assign({}, light, vars(tokenBlock.split(':root:not([data-theme="light"])')[1].split('}')[0]));
  assert.deepEqual(mediaDark, dark);
  // Settings sheet has Match phone, Light, Dark, Court theme swatches, Sunlight contrast and Court scores.
  assert.match(html, /data-act="settings-open"/);
  assert.match(html, /data-theme-pick/);
  assert.match(html, /data-palette-pick/);
  assert.match(html, /pal-grid/);
  assert.match(html, /Match phone/);
  assert.match(html, /prefers-color-scheme: dark[\s\S]*?addEventListener\('change'/);
  // Built index.html applies pb.display (including palette and theme-color) in <head> before paint to prevent FOUC.
  const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const headHtml = indexHtml.split('</head>')[0];
  assert.match(headHtml, /<meta name="color-scheme" content="light dark">/);
  assert.match(headHtml, /localStorage\.getItem\('pb\.display'\)/);
  assert.match(headHtml, /data-palette/);
  assert.match(headHtml, /#F1F4F9/);
  // manifest.webmanifest matches the default light theme-color.
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.background_color, '#F2F4F7');
  assert.equal(manifest.theme_color, '#F2F4F7');
});

test('DisplayPrefs: normalizes and resolves Match phone, Light, Dark, Outdoor and all 6 court palettes', () => {
  const m = html.match(/\/\*DISPLAY-START\*\/([\s\S]*?)\/\*DISPLAY-END\*\//);
  assert.ok(m, 'DISPLAY-START/END block missing');
  const DisplayPrefs = new Function(m[1] + '\nreturn DisplayPrefs;')();

  assert.deepEqual(DisplayPrefs.PALETTES.map(p => p.id), PALETTE_IDS);
  assert.equal(DisplayPrefs.paletteInfo('blue').name, 'Court Blue');
  assert.equal(DisplayPrefs.paletteInfo('bogus').id, 'green');

  assert.deepEqual(DisplayPrefs.normalize(null), { theme: 'auto', palette: 'green', outdoor: 0, large: 0 });
  assert.deepEqual(DisplayPrefs.normalize({ theme: 'bogus', palette: 'neon', outdoor: true, large: 1 }), { theme: 'auto', palette: 'green', outdoor: 1, large: 1 });
  assert.deepEqual(DisplayPrefs.normalize({ theme: 'dark', palette: 'clay', outdoor: 0, large: 0 }), { theme: 'dark', palette: 'clay', outdoor: 0, large: 0 });
  assert.deepEqual(DisplayPrefs.normalize({ theme: 'light', palette: 'violet' }), { theme: 'light', palette: 'violet', outdoor: 0, large: 0 });

  // Match phone follows OS preference without pinning data-theme; default green sets no data-palette.
  assert.deepEqual(DisplayPrefs.resolve({ theme: 'auto' }, false), {
    dataTheme: null, dataPalette: null, palette: 'green', effective: 'light', colorScheme: 'light dark', themeColor: '#F2F4F7', outdoor: false, large: false
  });
  assert.deepEqual(DisplayPrefs.resolve({ theme: 'auto' }, true), {
    dataTheme: null, dataPalette: null, palette: 'green', effective: 'dark', colorScheme: 'light dark', themeColor: '#0A0F17', outdoor: false, large: false
  });

  // Explicit Light overrides dark OS; explicit Dark overrides light OS.
  assert.deepEqual(DisplayPrefs.resolve({ theme: 'light' }, true), {
    dataTheme: 'light', dataPalette: null, palette: 'green', effective: 'light', colorScheme: 'light', themeColor: '#F2F4F7', outdoor: false, large: false
  });
  assert.deepEqual(DisplayPrefs.resolve({ theme: 'dark' }, false), {
    dataTheme: 'dark', dataPalette: null, palette: 'green', effective: 'dark', colorScheme: 'dark', themeColor: '#0A0F17', outdoor: false, large: false
  });

  // Every palette resolves its exact light/dark theme-color and #000000 in outdoor.
  const expectedMeta = {
    green: ['#F2F4F7', '#0A0F17'],
    blue: ['#F1F4F9', '#090E18'],
    clay: ['#F6F3F0', '#120C0B'],
    violet: ['#F4F2F8', '#0D0A14'],
    sunset: ['#F7F4EF', '#120E0A'],
    slate: ['#F3F4F6', '#0A0C10']
  };
  for (const [id, [lt, dk]] of Object.entries(expectedMeta)) {
    const wantAttr = id === 'green' ? null : id;
    assert.deepEqual(DisplayPrefs.resolve({ theme: 'light', palette: id }, true), {
      dataTheme: 'light', dataPalette: wantAttr, palette: id, effective: 'light', colorScheme: 'light', themeColor: lt, outdoor: false, large: false
    });
    assert.deepEqual(DisplayPrefs.resolve({ theme: 'dark', palette: id }, false), {
      dataTheme: 'dark', dataPalette: wantAttr, palette: id, effective: 'dark', colorScheme: 'dark', themeColor: dk, outdoor: false, large: false
    });
    assert.deepEqual(DisplayPrefs.resolve({ theme: 'dark', palette: id, outdoor: 1, large: 1 }, true), {
      dataTheme: 'dark', dataPalette: wantAttr, palette: id, effective: 'light', colorScheme: 'light', themeColor: '#000000', outdoor: true, large: true
    });
  }
});

test('WI-9: every name style stays >= 4.5:1 on cards, soft cards and the page in every theme and palette', () => {
  const mix = (a, pa, b) => a.map((v, i) => v * pa + b[i] * (1 - pa)); // CSS color-mix(in srgb, a pa, b)
  const styles = {
    gold: t => mix(t.ball, 0.4, t.ink),
    glowing: t => t.ink,
    flame: t => mix(t.down, 0.75, t.ink),
    pickle: t => mix(t.green, 0.7, t.ink),
    ice: t => mix(t['blue-text'], 0.75, t.ink),
    neon: t => mix(mix(t.down, 0.5, t['blue-text']), 0.75, t.ink)
  };
  // The stylesheet must still say exactly this (the maths above is a copy of it).
  const css = html.split('</style>')[0];
  for (const [id, mixSrc] of [['gold', 'color-mix(in srgb, var(--ball) 40%, var(--ink))'], ['flame', 'color-mix(in srgb, var(--down) 75%, var(--ink))'], ['pickle', 'color-mix(in srgb, var(--green) 70%, var(--ink))'], ['ice', 'color-mix(in srgb, var(--blue-text) 75%, var(--ink))'], ['neon', 'color-mix(in srgb, color-mix(in srgb, var(--down) 50%, var(--blue-text)) 75%, var(--ink))']]) {
    assert.ok(css.includes(`.rw-nm[data-rw-style="${id}"] { color: ${mixSrc};`), `${id} colour rule`);
  }
  assert.match(css, /\.rw-nm\[data-rw-style="glowing"\] \{ color: var\(--ink\);/);
  assert.match(css, /:root\[data-outdoor\] \.rw-nm \{ text-shadow: none; \}/);
  for (const [pid, modes] of Object.entries(palettes)) for (const [mode, t] of Object.entries(modes)) for (const [name, fn] of Object.entries(styles)) {
    const c = fn(t);
    for (const [bgName, bg] of [['surface', t.surface], ['surface-2', t['surface-2']], ['bg', t.bg]]) {
      assert.ok(ratio(c, bg) >= 4.5, `${name} name on ${bgName} in ${pid}/${mode}: ${ratio(c, bg).toFixed(2)}`);
    }
  }
});
