// Non-token theme surfaces (PR 3): share/recap canvas tokens, #club-display --dsp-* wiring,
// dark-mode MARK ball-hole contrast, and public page theme-color / ?palette= support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { page } from './helpers/app.js';

const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const html = page();
const shareSrc = read('src/app/share-image.js');

// Load pure share-theme helpers with a stubbed document/getComputedStyle.
function loadShareTheme(styleMap, initialAttrs = {}) {
  const attrs = { ...initialAttrs };
  const docEl = {
    getAttribute: k => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: k => { delete attrs[k]; },
    hasAttribute: k => k in attrs
  };
  const getComputedStyle = () => ({
    getPropertyValue: k => {
      const mode = attrs['data-theme'] === 'light' ? 'light' : 'dark';
      const pal = attrs['data-palette'] || 'green';
      const table = (styleMap[pal] && styleMap[pal][mode]) || styleMap.default || {};
      return table[k] || '';
    }
  });
  const m = shareSrc.match(/(const SHARE_THEMES = [\s\S]*?\nfunction shareTheme\(theme\) \{[\s\S]*?\n\})/);
  assert.ok(m, 'shareTheme helper present in src/app/share-image.js');
  const fn = new Function('document', 'getComputedStyle', `${m[1]}\nreturn { SHARE_THEMES, SHARE_GROUND, SHARE_PANELS, shareTheme };`);
  return { ...fn({ documentElement: docEl }, getComputedStyle), attrs };
}

test('share-image: SHARE_PANELS stay locked to Team 1 blue and Team 2 green', () => {
  const { SHARE_PANELS } = loadShareTheme({});
  assert.deepEqual(SHARE_PANELS, [['#3D5BFF', '#2B49E6'], ['#0f8c66', '#08664b']]);
});

test('share-image: default Court Green preserves exact baseline night and day values in any page mode', () => {
  const greenMap = {
    green: {
      light: {
        '--bg': '#F2F4F7', '--surface': '#FFFFFF', '--surface-2': '#E9EDF2',
        '--ink': '#0E1726', '--muted': '#5D6A7B', '--line': '#DEE4EA',
        '--court': '#0E7A55', '--court-2': '#0A5E42', '--accent': '#2B49E6', '--accent-text': '#2B49E6',
        '--on-court': '#FFFFFF', '--on-court-muted': 'rgb(255 255 255 / .92)',
        '--ball': '#DDF247', '--ball-ink': '#1B2104', '--up': '#0A7656', '--down': '#C2372B',
        '--dsp-surface': '#17372E'
      },
      dark: {
        '--bg': '#0A0F17', '--surface': '#131B26', '--surface-2': '#1B2532',
        '--ink': '#EEF2F7', '--muted': '#8E9BAD', '--line': '#243142',
        '--court': '#0F6B4B', '--court-2': '#0A4A34', '--accent': '#3D5BFF', '--accent-text': '#9DB0FF',
        '--on-court': '#FFFFFF', '--on-court-muted': 'rgb(255 255 255 / .92)',
        '--ball': '#DDF247', '--ball-ink': '#1B2104', '--up': '#3DD69E', '--down': '#FF7A6B',
        '--dsp-surface': '#17372E'
      }
    }
  };
  const { SHARE_THEMES, SHARE_GROUND, shareTheme, attrs } = loadShareTheme(greenMap, { 'data-theme': 'light', 'data-outdoor': '' });
  const night = shareTheme('night');
  assert.equal(attrs['data-theme'], 'light', 'restores data-theme after probe');
  assert.equal(attrs['data-outdoor'], '', 'restores data-outdoor after probe');
  assert.deepEqual(night.ground, SHARE_GROUND.night);
  assert.equal(night.heroBg, SHARE_THEMES.night.heroBg);
  assert.equal(night.heroBg2, null);
  assert.equal(night.heroInk, '#EEF2F7');
  assert.equal(night.heroMuted, SHARE_THEMES.night.heroMuted);
  assert.equal(night.accent, SHARE_THEMES.night.ink);
  assert.equal(night.avBg, SHARE_THEMES.night.avBg);
  assert.equal(night.up, SHARE_THEMES.night.up);

  const day = shareTheme('day');
  assert.deepEqual(day.ground, SHARE_GROUND.day);
  assert.equal(day.heroBg, SHARE_THEMES.day.heroBg);
  assert.equal(day.heroBg2, null);
  assert.equal(day.accent, SHARE_THEMES.day.ink);
  assert.equal(day.avBg, SHARE_THEMES.day.avBg);
  assert.equal(day.up, SHARE_THEMES.day.up);
});

test('share-image: non-default palette derives ground, hero and accent from computed CSS tokens', () => {
  const clayMap = {
    clay: {
      light: {
        '--bg': '#F6F3F0', '--surface': '#FFFFFF', '--surface-2': '#F0EAE4',
        '--ink': '#1F1412', '--muted': '#685752', '--line': '#E3DAD2',
        '--court': '#A83224', '--court-2': '#7E2218', '--accent': '#A83224', '--accent-text': '#A83224',
        '--on-court': '#FFFFFF', '--on-court-muted': 'rgb(255 255 255 / .92)',
        '--ball': '#DDF247', '--ball-ink': '#1B2104', '--up': '#0A7656', '--down': '#C2372B',
        '--dsp-surface': '#3D1D1A'
      },
      dark: {
        '--bg': '#120C0B', '--surface': '#1C1412', '--surface-2': '#251B18',
        '--ink': '#F5EFEA', '--muted': '#AD9A94', '--line': '#382925',
        '--court': '#A33022', '--court-2': '#751F15', '--accent': '#C74334', '--accent-text': '#FF998C',
        '--on-court': '#FFFFFF', '--on-court-muted': 'rgb(255 255 255 / .92)',
        '--ball': '#DDF247', '--ball-ink': '#1B2104', '--up': '#3DD69E', '--down': '#FF7A6B',
        '--dsp-surface': '#3D1D1A'
      }
    }
  };
  const { shareTheme } = loadShareTheme(clayMap, { 'data-palette': 'clay' });
  const night = shareTheme('night');
  assert.deepEqual(night.ground, ['#3D1D1A', '#120C0B']);
  assert.equal(night.heroBg, '#A33022');
  assert.equal(night.heroBg2, '#751F15');
  assert.equal(night.heroInk, '#FFFFFF');
  assert.equal(night.accent, '#FF998C');
  assert.equal(night.cardBg, '#1C1412');
  assert.equal(night.cardLine, '#382925');
  assert.equal(night.avBg, '#251B18');

  const day = shareTheme('day');
  assert.deepEqual(day.ground, ['#FFFFFF', '#F6F3F0']);
  assert.equal(day.heroBg, '#A83224');
  assert.equal(day.heroBg2, '#7E2218');
  assert.equal(day.accent, '#A83224');
  assert.equal(day.avBg, '#7E2218');
});

test('share-image: falls back to green defaults when CSS tokens are unavailable', () => {
  const { SHARE_THEMES, SHARE_GROUND, shareTheme } = loadShareTheme({});
  const night = shareTheme('night');
  assert.deepEqual(night.ground, SHARE_GROUND.night);
  assert.equal(night.ink, SHARE_THEMES.night.ink);
  assert.equal(night.heroBg, SHARE_THEMES.night.heroBg);
});

test('#club-display uses --dsp-* and --ball tokens and keeps QR white', () => {
  const block = html.slice(html.indexOf('#club-display {'), html.indexOf('/* Game nights'));
  for (const tok of ['var(--dsp-bg)', 'var(--dsp-surface)', 'var(--dsp-ink)', 'var(--dsp-muted)', 'var(--dsp-dim)', 'var(--ball)']) {
    assert.ok(block.includes(tok), `missing ${tok} in #club-display CSS`);
  }
  for (const stale of ['#0F241E', '#17372E', '#F4F7EE', '#B9C8BE', '#7E9284', '#DDF247']) {
    assert.ok(!block.includes(stale), `hard-coded ${stale} left in #club-display CSS`);
  }
  assert.match(block, /\.dsp-qr\s*\{\s*background:\s*#fff;/, 'QR box stays pure white');
});

test('MARK wordmark uses var(--ball-ink) for ball holes in dark mode', () => {
  const m = html.match(/const MARK = `([^`]+)`;/);
  assert.ok(m, 'MARK constant found');
  assert.match(m[1], /<g fill="var\(--ball-ink\)" opacity="\.85">/);
});

test('public bracket and league pages update theme-color and validate ?palette=', () => {
  for (const file of ['bracket-public.html', 'league-public.html', 'b.html', 'l.html']) {
    const src = read(file);
    assert.match(src, /<meta name="theme-color" content="#F2F4F7">/, `${file} theme-color updated`);
    assert.ok(!src.includes('content="#0F241E"'), `${file} has no stale theme-color #0F241E`);
    assert.match(src, /q\.get\('palette'\)/, `${file} reads ?palette=`);
    assert.match(src, /root\.dataset\.palette\s*=/, `${file} sets data-palette`);
  }
});
