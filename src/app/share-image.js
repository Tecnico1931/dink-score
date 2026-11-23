/* ---------- share a result or year-in-review as an image ---------- */
// A 1080x1350 card drawn on a canvas: both teams on court-colored panels, rating changes, the score, and a note
// when the side the forecast had losing won — plus a Year-in-review recap card reusing the same canvas chrome.
// Night (dark) and Day (light) versions.
const SHARE_W = 1080, SHARE_H = 1350;
const SHARE_THEMES = {
  night: { ink: '#EEF2F7', muted: '#8E9BAD', badgeBg: 'rgba(221,242,71,.14)', badgeInk: '#DDF247', cardBg: '#131B26', cardLine: '#243142', heroBg: '#162234', heroMuted: '#9BA9BC', up: '#3DD69E', down: '#FF7A6B', avBg: '#1E2A3B' },
  day: { ink: '#0E1726', muted: '#5D6A7B', badgeBg: '#DDF247', badgeInk: '#1B2104', cardBg: '#FFFFFF', cardLine: '#DEE4EA', heroBg: '#0E1726', heroMuted: '#A3B1C2', up: '#0B8562', down: '#C2372B', avBg: '#0E1726' }
};
const SHARE_GROUND = { night: ['#1d2a3d', '#0A0F17'], day: ['#FFFFFF', '#F2F4F7'] };
const SHARE_PANELS = [['#3D5BFF', '#2B49E6'], ['#0f8c66', '#08664b']];

// Read computed CSS tokens for the active palette in the card's Night (dark) or Day (light) mode,
// keeping Court Green fallbacks and never altering the locked Team 1 / Team 2 SHARE_PANELS.
function readShareTokens(theme) {
  const r = typeof document !== 'undefined' && document.documentElement;
  if (!r || typeof getComputedStyle !== 'function') return {};
  const want = theme === 'day' ? 'light' : 'dark';
  const prevTheme = r.getAttribute('data-theme');
  const hadOut = r.hasAttribute('data-outdoor');
  const swap = prevTheme !== want || hadOut;
  if (swap) {
    r.setAttribute('data-theme', want);
    if (hadOut) r.removeAttribute('data-outdoor');
  }
  try {
    const cs = getComputedStyle(r);
    const get = k => (cs.getPropertyValue(k) || '').trim();
    return {
      palette: (r.getAttribute('data-palette') || '').trim(),
      bg: get('--bg'), surface: get('--surface'), surface2: get('--surface-2'),
      ink: get('--ink'), muted: get('--muted'), line: get('--line'),
      court: get('--court'), court2: get('--court-2'),
      accent: get('--accent'), accentText: get('--accent-text'),
      onCourt: get('--on-court'), onCourtMuted: get('--on-court-muted'),
      ball: get('--ball'), ballInk: get('--ball-ink'),
      up: get('--up'), down: get('--down'), dspSurface: get('--dsp-surface')
    };
  } finally {
    if (swap) {
      if (prevTheme === null) r.removeAttribute('data-theme');
      else r.setAttribute('data-theme', prevTheme);
      if (hadOut) r.setAttribute('data-outdoor', '');
    }
  }
}
function shareTheme(theme) {
  const isDay = theme === 'day';
  const base = SHARE_THEMES[isDay ? 'day' : 'night'];
  const gBase = SHARE_GROUND[isDay ? 'day' : 'night'];
  const tok = readShareTokens(theme);
  const isDefault = (!tok.palette || tok.palette === 'green') &&
    (!tok.court || tok.court.toLowerCase() === (isDay ? '#0e7a55' : '#0f6b4b'));
  const ball = tok.ball || '#DDF247';
  const ballInk = tok.ballInk || '#1B2104';
  const groundLo = tok.bg || gBase[1];
  const nightHi = tok.dspSurface && tok.dspSurface.toLowerCase() !== '#17372e'
    ? tok.dspSurface : (tok.surface2 || gBase[0]);
  const groundHi = isDay ? (tok.surface || gBase[0]) : (isDefault ? gBase[0] : nightHi);
  return Object.assign({}, base, {
    ink: tok.ink || base.ink,
    muted: tok.muted || base.muted,
    badgeBg: isDay ? ball : base.badgeBg,
    badgeInk: isDay ? ballInk : ball,
    cardBg: tok.surface || base.cardBg,
    cardLine: tok.line || base.cardLine,
    heroBg: isDefault ? base.heroBg : (tok.court || base.heroBg),
    heroBg2: isDefault ? null : (tok.court2 || tok.court || null),
    heroInk: isDefault ? '#EEF2F7' : (tok.onCourt || '#FFFFFF'),
    heroMuted: isDefault ? base.heroMuted : (tok.onCourtMuted || 'rgba(255,255,255,.92)'),
    accent: isDefault ? (tok.ink || base.ink) : (tok.accentText || tok.accent || tok.ink || base.ink),
    up: isDay ? base.up : (tok.up || base.up),
    down: tok.down || base.down,
    avBg: isDefault ? base.avBg : (isDay ? (tok.court2 || tok.ink || base.avBg) : (tok.surface2 || base.avBg)),
    ground: [groundHi, groundLo],
    ball,
    ballInk
  });
}
const DISPLAY_FONT = '"Bricolage Grotesque", "Arial Narrow", sans-serif';
const UI_FONT = 'Geist, system-ui, -apple-system, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
// What goes on the card for one game. pending: a just-finished game that isn't in the record yet.
function shareCardData(g, pending) {
  const games = pending ? [...allGames().filter(x => x.id !== g.id), g] : allGames();
  const c = DR.compute(games).changes[g.id];
  const named = n => !isDefaultName(String(n).trim());
  const deltaFor = (t, name) => {
    if (!c || !named(name)) return null;
    const x = c.list.find(y => y.team === t && sameName(y.name, name));
    return x ? x.after - x.before : null;
  };
  const target = Number(g.target) || 11;
  // Upset: the side the pre-game forecast had losing won. Only when both sides have named players and the
  // forecast (the same one the end-of-game screen shows) had it by 2+ points.
  let upset = null;
  if (c && [0, 1].every(t => g.teams[t].some(named)) && Math.abs(c.expected - 0.5) >= 0.02) {
    const fav = c.expected >= 0.5 ? 0 : 1;
    const pf = fav === 0 ? c.expected : 1 - c.expected;
    const lo = Math.min(target - 1, Math.round(target * (1 - pf) / pf));
    if (g.winner !== fav && lo <= target - 2) {
      const sc = fav === 0 ? [target, lo] : [lo, target];
      upset = `${sc[0]}–${sc[1]}`;
    }
  }
  const d = new Date(g.endedAt || Date.now());
  const mode = g.mode === 'singles' ? 'Singles' : 'Doubles';
  return {
    date: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    mode, line2: g.logged ? `To ${target}` : `To ${target} · ${g.scoring === 'rally' ? 'Rally' : 'Side-out'}`,
    teams: [0, 1].map(t => ({
      score: Number(g.score[t]) || 0, win: g.winner === t,
      players: g.teams[t].map(n => ({ name: String(n).trim(), avatar: avatarOf(n), delta: deltaFor(t, n) }))
    })),
    upset, club: club ? club.name : null
  };
}
async function shareFonts() {
  if (!document.fonts || !document.fonts.load) return;
  const sample = 'Dink Score 0123456789 +−–.·% WIN YEAR IN REVIEW Aa';
  const loads = [`800 288px ${DISPLAY_FONT}`, `condensed 800 288px ${DISPLAY_FONT}`, `semi-condensed 800 54px ${DISPLAY_FONT}`,
    '400 33px Geist', '600 45px Geist', '700 30px Geist'].map(f => document.fonts.load(f, sample).catch(() => {}));
  await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 3000))]);
}
const loadImg = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
function shareAvatarImage(a) {
  if (!a) return Promise.resolve(null);
  if (a.type === 'photo' && /^data:image\/(jpeg|webp);base64,/.test(a.value)) return loadImg(a.value);
  if (a.type === 'icon' && AVATAR_ICONS[a.value]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.7">${AVATAR_ICONS[a.value].replace(/currentColor/g, '#ffffff')}</svg>`;
    return loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  }
  return Promise.resolve(null);
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// stretch is a font-stretch keyword ('condensed' = 75%). Set it in the shorthand and, where supported, the property too.
function setFont(ctx, weight, size, family, stretch = 'normal', spacing = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  if (stretch !== 'normal') ctx.font = `${stretch} ${weight} ${size}px ${family}`;
  if ('fontStretch' in ctx) ctx.fontStretch = stretch;
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
}
const textW = (ctx, t) => ctx.measureText(t).width;
function ellipsize(ctx, text, max) {
  if (textW(ctx, text) <= max) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && textW(ctx, chars.join('').trimEnd() + '…') > max) chars.pop();
  return chars.join('').trimEnd() + '…';
}
// A pill drawn from x, centered on cy. Returns its width.
function pill(ctx, x, cy, text, h, padX, bg, fg) {
  const w = textW(ctx, text) + padX * 2;
  ctx.fillStyle = bg; roundRect(ctx, x, cy - h / 2, w, h, h / 2); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + padX, cy + 1);
  return w;
}
const fmtDelta = d => { const v = Math.round(d * 100) / 100; return v === 0 ? '±0.00' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2); };
// Shared card ground (rounded clip + top radial light) and top brand/meta row.
function drawShareGround(ctx, T) {
  const W = SHARE_W, H = SHARE_H;
  roundRect(ctx, 0, 0, W, H, 84); ctx.clip();
  const [hi, lo] = (T && T.ground) || SHARE_GROUND[T === 'day' ? 'day' : 'night'];
  ctx.fillStyle = lo; ctx.fillRect(0, 0, W, H);
  ctx.save();
  const rx = W * 1.2, ry = H * 0.8;
  ctx.translate(W / 2, 0); ctx.scale(1, ry / rx);
  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  rg.addColorStop(0, hi); rg.addColorStop(0.6, lo); rg.addColorStop(1, lo);
  ctx.fillStyle = rg; ctx.fillRect(-W / 2, 0, W, H * rx / ry);
  ctx.restore();
}
let shareBallImg = null; // set by the draw*Card functions before the header is drawn; null = flat fallback
function drawShareHeader(ctx, T, line1, line2) {
  const W = SHARE_W, PAD = 60, topY = 109;
  if (shareBallImg) ctx.drawImage(shareBallImg, PAD, topY - 27, 54, 54); // the same icons/pickleball.svg as the app, theme-independent
  else {
    ctx.save();
    ctx.beginPath(); ctx.arc(PAD + 27, topY, 27, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#c6d93f'; ctx.fillRect(PAD, topY - 27, 54, 54);
    ctx.fillStyle = T.ball || '#DDF247'; ctx.beginPath(); ctx.arc(PAD + 27 - 9, topY - 9, 27, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  setFont(ctx, 800, 54, DISPLAY_FONT, 'semi-condensed', -1);
  ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('Dink Score', PAD + 54 + 24, topY + 2);
  const brandRight = PAD + 78 + textW(ctx, 'Dink Score') + 30;
  setFont(ctx, 400, 33, UI_FONT);
  ctx.fillStyle = T.muted; ctx.textAlign = 'right';
  const metaMax = W - PAD - brandRight;
  ctx.fillText(ellipsize(ctx, line1, metaMax), W - PAD, topY - 21);
  ctx.fillText(ellipsize(ctx, line2, metaMax), W - PAD, topY + 22);
}
function drawShareAvatar(ctx, cx, cy, size, name, avatar, img, fillBg = 'rgba(255,255,255,.22)') {
  const r = size / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = fillBg; ctx.fill(); ctx.clip();
  if (img && avatar && avatar.type === 'photo') {
    const s = Math.min(img.naturalWidth, img.naturalHeight) || 1;
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, cx - r, cy - r, size, size);
  } else if (img) {
    const ic = Math.round(size * 0.62);
    ctx.drawImage(img, cx - ic / 2, cy - ic / 2, ic, ic);
  } else if (avatar && avatar.type === 'emoji' && avatar.value) {
    setFont(ctx, 400, Math.round(size * 0.54), EMOJI_FONT);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(avatar.value, cx, cy + 2);
  } else {
    setFont(ctx, 700, Math.round(size * 0.36), UI_FONT);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials(name || '?'), cx, cy + 1);
  }
  ctx.restore();
}
async function drawShareCard(d, theme, noImages) {
  await shareFonts();
  shareBallImg = await loadImg('icons/pickleball.svg');
  const T = shareTheme(theme);
  const imgs = noImages ? [] : await Promise.all(d.teams.flatMap(t => t.players.map(p => shareAvatarImage(p.avatar))));
  const W = SHARE_W, H = SHARE_H, PAD = 60;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  drawShareGround(ctx, T);
  drawShareHeader(ctx, T, `${d.date} · ${d.mode}`, d.line2);

  // Team panels, in the order the game stores them: team 1 blue on top, team 2 green below.
  const FOOT_H = 63, footCY = H - 54 - FOOT_H / 2;
  const top = 200, bottom = H - 54 - FOOT_H - 36, gap = 24;
  const ph = (bottom - top - gap) / 2, pw = W - PAD * 2;
  let ai = 0;
  d.teams.forEach((team, ti) => {
    const px = PAD, py = top + ti * (ph + gap);
    // linear-gradient(160deg, a, b)
    const ang = 160 * Math.PI / 180, dx = Math.sin(ang), dy = -Math.cos(ang);
    const len = Math.abs(pw * dx) + Math.abs(ph * dy), cx = px + pw / 2, cy = py + ph / 2;
    const lg = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    lg.addColorStop(0, SHARE_PANELS[ti][0]); lg.addColorStop(1, SHARE_PANELS[ti][1]);
    ctx.fillStyle = lg; roundRect(ctx, px, py, pw, ph, 66); ctx.fill();

    // Score numeral, squeezed and heavy. The loser's is dimmed.
    const SCORE_LS = -13;
    setFont(ctx, 800, 288, DISPLAY_FONT, 'condensed', SCORE_LS);
    const scoreText = String(team.score);
    const sw = textW(ctx, scoreText);
    const asc = ctx.measureText('0').actualBoundingBoxAscent || 205;
    ctx.fillStyle = team.win ? '#EEF2F7' : 'rgba(238,242,247,.7)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(scoreText, px + pw - 48 + SCORE_LS, cy + asc / 2);
    if (team.win) {
      setFont(ctx, 700, 30, UI_FONT, 'normal', 1.2);
      const tw = textW(ctx, 'WIN') + 48;
      pill(ctx, px + pw - 36 - tw, py + 30 + 24, 'WIN', 48, 24, T.ball, T.ballInk);
    }

    // Players: avatar, name, rating change.
    const n = team.players.length, ROW = 78, RGAP = 18;
    const blockH = n * ROW + (n - 1) * RGAP;
    const leftMax = px + pw - 48 - sw - 40;
    team.players.forEach((p, i) => {
      const img = imgs[ai++];
      const rowCY = cy - blockH / 2 + i * (ROW + RGAP) + ROW / 2;
      const avX = px + 48, avCX = avX + ROW / 2;
      drawShareAvatar(ctx, avCX, rowCY, ROW, p.name, p.avatar, img);

      const nameX = avX + ROW + 24;
      let deltaText = null, deltaW = 0;
      if (p.delta !== null && p.delta !== undefined) {
        deltaText = fmtDelta(p.delta);
        setFont(ctx, 800, 39, DISPLAY_FONT, 'condensed');
        deltaW = textW(ctx, deltaText) + 36 + 24;
      }
      let size = 45;
      setFont(ctx, 600, size, UI_FONT);
      const room = Math.max(60, leftMax - nameX - deltaW);
      while (size > 36 && textW(ctx, p.name) > room) { size -= 1; setFont(ctx, 600, size, UI_FONT); }
      const name = ellipsize(ctx, p.name, room);
      ctx.fillStyle = '#EEF2F7'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name, nameX, rowCY + 1);
      if (deltaText) {
        const x = nameX + textW(ctx, name) + 24;
        setFont(ctx, 800, 39, DISPLAY_FONT, 'condensed');
        const v = Math.round(p.delta * 100) / 100;
        pill(ctx, x, rowCY, deltaText, 52, 18, 'rgba(10,15,23,.55)', v > 0 ? '#3DD69E' : v < 0 ? '#FF7A6B' : '#C3CCD8');
      }
    });
  });

  // Footer: the upset note, and the club.
  let used = 0;
  if (d.upset) {
    setFont(ctx, 600, 33, UI_FONT);
    used = pill(ctx, PAD, footCY, `⚡ Upset · forecast was ${d.upset}`, FOOT_H, 27, T.badgeBg, T.badgeInk) + 36;
  }
  if (d.club) {
    setFont(ctx, 400, 33, UI_FONT);
    ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, d.club, pw - used), W - PAD, footCY + 1);
  }
  return cv;
}

// Year-in-review 1080x1350 card reusing the same canvas chrome, fonts, avatars and Night/Day palette.
async function drawRecapCard(d, theme, noImages) {
  await shareFonts();
  shareBallImg = await loadImg('icons/pickleball.svg');
  const T = shareTheme(theme);
  const avList = [d.avatar, d.favouritePartner && d.favouritePartner.avatar, d.biggestRival && d.biggestRival.avatar];
  const imgs = noImages ? [null, null, null] : await Promise.all(avList.map(a => shareAvatarImage(a)));
  const W = SHARE_W, H = SHARE_H, PAD = 60, pw = W - PAD * 2;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  drawShareGround(ctx, T);
  drawShareHeader(ctx, T, 'Year in review', d.formatLabel || `${d.year}`);

  // Player row: avatar, name, and the single floodlight year badge.
  const headCY = 244, avSize = 94;
  drawShareAvatar(ctx, PAD + avSize / 2, headCY, avSize, d.name, d.avatar, imgs[0], T.avBg);
  setFont(ctx, 800, 36, DISPLAY_FONT, 'condensed', 0.5);
  const yearLabel = String(d.year);
  const yearW = textW(ctx, yearLabel) + 52;
  pill(ctx, W - PAD - yearW, headCY, yearLabel, 56, 26, T.ball, T.ballInk);
  const nameX = PAD + avSize + 24, nameRoom = Math.max(120, W - PAD - yearW - 24 - nameX);
  let nameSize = 52;
  setFont(ctx, 700, nameSize, UI_FONT);
  while (nameSize > 34 && textW(ctx, d.name) > nameRoom) { nameSize -= 2; setFont(ctx, 700, nameSize, UI_FONT); }
  ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(ellipsize(ctx, d.name, nameRoom), nameX, headCY + 2);

  // Best Dink Rating hero slab (dark ink slab in default green, court gradient in selected palettes).
  const heroY = 324, heroH = 244;
  if (T.heroBg2) {
    const ang = 155 * Math.PI / 180, dx = Math.sin(ang), dy = -Math.cos(ang);
    const len = Math.abs(pw * dx) + Math.abs(heroH * dy), cx = PAD + pw / 2, cy = heroY + heroH / 2;
    const hg = ctx.createLinearGradient(cx - dx * len / 2, cy - dy * len / 2, cx + dx * len / 2, cy + dy * len / 2);
    hg.addColorStop(0, T.heroBg); hg.addColorStop(1, T.heroBg2);
    ctx.fillStyle = hg;
  } else {
    ctx.fillStyle = T.heroBg;
  }
  roundRect(ctx, PAD, heroY, pw, heroH, 52); ctx.fill();
  const ratingText = d.bestRating !== null && d.bestRating !== undefined ? d.bestRating.toFixed(2) : '–';
  setFont(ctx, 800, 196, DISPLAY_FONT, 'condensed', -8);
  const ratingW = textW(ctx, ratingText);
  const rAsc = ctx.measureText('0').actualBoundingBoxAscent || 140;
  ctx.fillStyle = T.heroInk; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(ratingText, PAD + pw - 48, heroY + heroH / 2 + rAsc / 2 - 4);
  const heroLeftMax = Math.max(160, pw - 96 - ratingW - 32);
  setFont(ctx, 700, 26, UI_FONT, 'normal', 1.2);
  ctx.fillStyle = T.heroMuted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(ellipsize(ctx, 'BEST DINK RATING', heroLeftMax), PAD + 48, heroY + 76);
  const peakMode = d.bestRatingMode ? `${d.bestRatingMode === 'singles' ? 'Singles' : 'Doubles'} peak` : 'Peak rating';
  setFont(ctx, 600, 34, UI_FONT);
  ctx.fillStyle = T.heroInk;
  ctx.fillText(ellipsize(ctx, peakMode, heroLeftMax), PAD + 48, heroY + 128);
  if (typeof d.pointsDiff === 'number') {
    setFont(ctx, 500, 28, UI_FONT);
    ctx.fillStyle = T.heroMuted;
    ctx.fillText(ellipsize(ctx, `Points +/−  ${d.pointsDiff > 0 ? '+' : ''}${d.pointsDiff}`, heroLeftMax), PAD + 48, heroY + 178);
  }

  // Three stat cells: Games, Won–lost, Win rate.
  const statY = 594, statH = 192, statGap = 20, cellW = (pw - statGap * 2) / 3;
  const stats = [
    [String(d.games), 'GAMES'],
    [`${d.wins}–${d.losses}`, 'WON–LOST'],
    [`${d.winRate}%`, 'WIN RATE']
  ];
  stats.forEach(([val, lab], i) => {
    const cx = PAD + i * (cellW + statGap);
    ctx.fillStyle = T.cardBg; roundRect(ctx, cx, statY, cellW, statH, 40); ctx.fill();
    ctx.strokeStyle = T.cardLine; ctx.lineWidth = 2; roundRect(ctx, cx, statY, cellW, statH, 40); ctx.stroke();
    let sz = 88;
    setFont(ctx, 800, sz, DISPLAY_FONT, 'condensed', -2);
    while (sz > 54 && textW(ctx, val) > cellW - 40) { sz -= 4; setFont(ctx, 800, sz, DISPLAY_FONT, 'condensed', -2); }
    ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(val, cx + cellW / 2, statY + 78);
    setFont(ctx, 600, 25, UI_FONT, 'normal', 1);
    ctx.fillStyle = T.muted;
    ctx.fillText(lab, cx + cellW / 2, statY + 148);
  });

  // Highlight rows: Favourite partner, Biggest rival.
  const drawHighlight = (y, kicker, person, img, emptyText, accentColor) => {
    const h = 186;
    ctx.fillStyle = T.cardBg; roundRect(ctx, PAD, y, pw, h, 44); ctx.fill();
    ctx.strokeStyle = T.cardLine; ctx.lineWidth = 2; roundRect(ctx, PAD, y, pw, h, 44); ctx.stroke();
    setFont(ctx, 700, 24, UI_FONT, 'normal', 1.2);
    ctx.fillStyle = T.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(kicker, PAD + 40, y + 40);
    if (!person) {
      setFont(ctx, 500, 34, UI_FONT);
      ctx.fillStyle = T.muted;
      ctx.fillText(ellipsize(ctx, emptyText, pw - 80), PAD + 40, y + 118);
      return;
    }
    const rowCY = y + 116, avS = 76;
    drawShareAvatar(ctx, PAD + 40 + avS / 2, rowCY, avS, person.name, person.avatar, img, T.avBg);
    const rec = `${person.wins}–${person.losses}`;
    setFont(ctx, 800, 64, DISPLAY_FONT, 'condensed', -2);
    const recW = textW(ctx, rec);
    ctx.fillStyle = accentColor || T.ink; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(rec, PAD + pw - 40, y + 104);
    const sub = person.sub;
    setFont(ctx, 500, 25, UI_FONT);
    const subW = textW(ctx, sub);
    ctx.fillStyle = T.muted;
    ctx.fillText(sub, PAD + pw - 40, y + 150);
    const rightUsed = Math.max(recW, subW) + 28;
    const nx = PAD + 40 + avS + 24, nRoom = Math.max(100, PAD + pw - 40 - rightUsed - nx);
    let nSz = 44;
    setFont(ctx, 600, nSz, UI_FONT);
    while (nSz > 30 && textW(ctx, person.name) > nRoom) { nSz -= 2; setFont(ctx, 600, nSz, UI_FONT); }
    ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, person.name, nRoom), nx, rowCY + 1);
  };
  const fp = d.favouritePartner && Object.assign({}, d.favouritePartner, {
    sub: `${d.favouritePartner.games} game${d.favouritePartner.games === 1 ? '' : 's'} · ${d.favouritePartner.winRate}%`
  });
  const rv = d.biggestRival && Object.assign({}, d.biggestRival, {
    sub: `${d.biggestRival.games} game${d.biggestRival.games === 1 ? '' : 's'}`
  });
  const rvColor = rv ? (rv.wins > rv.losses ? T.up : rv.wins < rv.losses ? T.down : T.ink) : T.ink;
  drawHighlight(812, 'FAVOURITE PARTNER', fp, imgs[1],
    d.singlesGames && !d.doublesGames ? 'Singles only — no doubles partner yet' : 'No named doubles partner yet', T.accent);
  drawHighlight(1020, 'BIGGEST RIVAL', rv, imgs[2], 'No named opponents yet', rvColor);

  // Footer: optional format breakdown on the left, club name on the right (never club codes or tokens).
  const FOOT_H = 63, footCY = H - 54 - FOOT_H / 2;
  let leftUsed = 0;
  if (d.doublesGames && d.singlesGames) {
    const split = `${d.doublesGames} doubles · ${d.singlesGames} singles`;
    setFont(ctx, 400, 30, UI_FONT);
    ctx.fillStyle = T.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(split, PAD, footCY + 1);
    leftUsed = textW(ctx, split) + 28;
  }
  if (d.club) {
    setFont(ctx, 400, 33, UI_FONT);
    ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, d.club, Math.max(120, pw - leftUsed)), W - PAD, footCY + 1);
  }
  return cv;
}

const canvasBlob = cv => new Promise((res, rej) => { try { cv.toBlob(b => b ? res(b) : rej(new Error('No image')), 'image/png'); } catch (e) { rej(e); } });
let shareFilesOK = null;
function canShareFiles() {
  if (shareFilesOK === null) {
    try { shareFilesOK = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })] })); }
    catch { shareFilesOK = false; }
  }
  return shareFilesOK;
}
function openShare(g, pending) {
  let theme = store.get('pb.shareTheme', 'night');
  if (theme !== 'day') theme = 'night';
  shareSheet = { kind: 'game', title: 'Share result', alt: 'The result card that will be shared', filename: 'dink-score-result.png', data: shareCardData(g, pending), theme, url: null, file: null, token: 0, gameId: pending || !club || pickup ? null : g.id, link: null };
  renderShare();
  updateSharePreview();
}
function openRecapShare(data) {
  let theme = store.get('pb.shareTheme', 'night');
  if (theme !== 'day') theme = 'night';
  shareSheet = { kind: 'recap', title: `Share ${data.year} recap`, alt: `The ${data.year} year-in-review card that will be shared`, filename: `dink-score-${data.year}-recap.png`, data, theme, url: null, file: null, token: 0, gameId: null, link: null };
  renderShare();
  updateSharePreview();
}
function closeShare() {
  if (shareSheet && shareSheet.url) URL.revokeObjectURL(shareSheet.url);
  shareSheet = null;
  renderShare();
}
function renderShare() {
  const root = $('#sheet5');
  if (!shareSheet) { root.innerHTML = ''; lockBody(!!(logForm || (live && live.open))); return; }
  lockBody(true);
  const share = canShareFiles();
  root.innerHTML = `<div class="sheet-bg share"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="share-h"><span class="grip"></span>
    <div class="sheet-head"><h2 id="share-h">${esc(shareSheet.title || 'Share result')}</h2><button type="button" class="x" data-act="share-close" aria-label="Close">✕</button></div>
    <div class="share-prev busy"><img alt="${esc(shareSheet.alt || 'The result card that will be shared')}"></div>
    ${seg('data-share-theme', [['night', 'Night'], ['day', 'Day']], shareSheet.theme)}
    <div class="btns">${share ? `<button type="button" class="btn btn-ball block" data-act="share-go" disabled>Share…</button>` : ''}
      <button type="button" class="btn ${share ? 'btn-soft' : 'btn-ball'} block" data-act="share-save" disabled>Save image</button></div>
    <div id="share-link">${shareLinkHTML()}</div></div></div>`;
}
function setShareTheme(theme) {
  if (!shareSheet || (theme !== 'night' && theme !== 'day') || theme === shareSheet.theme) return;
  shareSheet.theme = theme;
  store.set('pb.shareTheme', theme);
  document.querySelectorAll('#sheet5 [data-share-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.shareTheme === theme)));
  updateSharePreview();
}
async function updateSharePreview() {
  const s = shareSheet;
  if (!s) return;
  const tok = ++s.token;
  const box = $('#sheet5 .share-prev');
  if (box) box.classList.add('busy');
  document.querySelectorAll('#sheet5 [data-act="share-go"], #sheet5 [data-act="share-save"]').forEach(b => { b.disabled = true; });
  const draw = s.kind === 'recap' ? drawRecapCard : drawShareCard;
  let blob = null;
  try { blob = await canvasBlob(await draw(s.data, s.theme)); }
  catch { try { blob = await canvasBlob(await draw(s.data, s.theme, true)); } catch {} } // e.g. a picture the canvas can't export
  if (shareSheet !== s || tok !== s.token) return;
  if (!blob) { if (box) box.outerHTML = `<p class="err" role="alert">Couldn't make the picture on this phone.</p>`; return; }
  if (s.url) URL.revokeObjectURL(s.url);
  s.url = URL.createObjectURL(blob);
  const fname = s.filename || 'dink-score-result.png';
  s.file = new File([blob], fname, { type: 'image/png' });
  const img = $('#sheet5 .share-prev img');
  if (img) { img.onload = () => box.classList.remove('busy'); img.src = s.url; }
  document.querySelectorAll('#sheet5 [data-act="share-go"], #sheet5 [data-act="share-save"]').forEach(b => { b.disabled = false; });
}
function shareImage() {
  const f = shareSheet && shareSheet.file;
  if (!f) return;
  try {
    navigator.share({ files: [f] }).catch(err => { if (!err || err.name !== 'AbortError') showToast("Couldn't share. Try Save image.", false); });
  } catch { showToast("Couldn't share. Try Save image.", false); }
}
function saveShareImage() {
  const f = shareSheet && shareSheet.file;
  if (!f) return;
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url; a.download = (shareSheet && shareSheet.filename) || 'dink-score-result.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
