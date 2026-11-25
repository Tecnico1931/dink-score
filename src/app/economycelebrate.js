/* ---------- rewards: court themes and win celebrations (WI-16; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Two more looks that stay on the phone that wears them (never in a club look, never in the box or the pass; the server's table is SLOT_META in
// api/_economyshop.js). Which ones you own and wear is the server's; this file draws the shelves, the card previews and one short effect.
//   - A court theme is an extra `data-palette` (`t-<id>`, tokens in the REWARDTHEMES CSS block) on this phone only, applied through applyDisplay()
//     by rwThemeSync() (economy.js). The six free palettes in Settings stay free; a worn theme sits over them until you wear None.
//   - A win celebration is one canvas-free CSS effect: 16 small inline SVG pieces, at most 1.5 s, in a band across the top of the screen with
//     pointer-events off, so it never covers or blocks the scoring buttons. It plays on the phone with Win celebration on in Settings (the
//     existing opt-in; display-live.js celebrateWin) and replaces the default burst. Under prefers-reduced-motion the pieces sit still.
// Nothing here reads a score, a rating or a rank, and nothing draws while rewards are hidden on this phone.
const RW_FX = {
  'celebrate-confetti': { kind: 'confetti', rain: false, colors: ['#4361FF', '#17B988', '#F08A4B', '#F2C94C'], svg: '<rect x="2" y="6" width="20" height="12" rx="3"/>' },
  'celebrate-balls': { kind: 'balls', rain: false, colors: ['#C8E81B', '#D9F23A'], svg: '<circle cx="12" cy="12" r="10"/>' },
  'celebrate-pickles': { kind: 'pickles', rain: true, colors: ['#5C9E2E', '#7DB544', '#4A8A22'], svg: '<rect x="8" y="1" width="8" height="22" rx="4"/>' },
  'celebrate-paddles': { kind: 'paddles', rain: false, colors: ['#3E5BF0', '#F08A4B'], svg: '<rect x="4" y="1" width="16" height="15" rx="7"/><rect x="10.5" y="15" width="3" height="8" rx="1.5"/>' },
  'celebrate-snowfall': { kind: 'snowfall', rain: true, colors: ['#9CC9EE', '#C7E2F7', '#7FB2E0'], svg: '<circle cx="12" cy="12" r="7"/>' },
  'celebrate-gifts': { kind: 'gifts', rain: false, colors: ['#D8404E', '#2F9E63', '#E8B93C'], svg: '<rect x="3" y="9" width="18" height="13" rx="2"/><rect x="2" y="5" width="20" height="5" rx="1.5"/>' },
  'celebrate-hearts': { kind: 'hearts', rain: false, colors: ['#E8506A', '#F08AC4'], svg: '<path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.6 2.7 5 6.2 5c2.1 0 3.7 1.1 5.8 3.2C14.1 6.1 15.7 5 17.8 5c3.5 0 5.3 3.6 3.8 6.8C19.5 16.4 12 21 12 21z"/>' }
};
const rwFxPiece = (fx, i, style) => `<i style="color:${fx.colors[i % fx.colors.length]};${style}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${fx.svg}</svg></i>`;
// The preview in a card's well (and a small one in the "What you wear" list): five pieces scattered, still.
const RW_FX_SPOTS = [[12, 24, -20], [56, 6, 15], [34, 50, 40], [74, 44, -10], [48, 28, 25]];
function rwLookWell(it, small) {
  if (it.slot === 'theme') {
    const t = DisplayPrefs.SHOP_BY_ITEM[it.id];
    return t ? `<span class="rw-thm${small ? ' sm' : ''}" aria-hidden="true" style="--p1:${t.c1};--p2:${t.c2}"><i></i><i></i></span>` : '';
  }
  const fx = RW_FX[it.id];
  if (!fx) return '';
  const spots = small ? RW_FX_SPOTS.slice(0, 3) : RW_FX_SPOTS;
  return `<span class="rw-fxp${small ? ' sm' : ''}" data-fx="${fx.kind}" aria-hidden="true">${spots.map(([x, y, r], i) => rwFxPiece(fx, i, `left:${x}%;top:${y}%;transform:rotate(${r}deg)`)).join('')}</span>`;
}
// Two shelves after the name styles, in the same card as every other shelf. Court themes and celebrations are not in the "In the shop" grid.
const RW_LOOK_COPY = { theme: ['Court themes', 'Your scoring screen on this phone.'], celebrate: ['Win celebrations', 'Plays on your scoring phone when a game ends.'] };
function rwLooksSectionsHTML(c, s) {
  const sec = slot => {
    const its = (s.items || []).filter(i => i.slot === slot && !i.seasonal && !i.event);
    return its.length ? `${rwSecHead(RW_LOOK_COPY[slot][0], RW_LOOK_COPY[slot][1])}${rwShelf(c, s, its)}` : '';
  };
  const themes = sec('theme'), fx = sec('celebrate');
  if (!themes && !fx) return '';
  return `${themes}${fx}<p class="rw-box-fine">A court theme only recolours your own scoring screen on this phone; the six free palettes in Settings stay free and come back when you wear None. A celebration lasts under two seconds, shows only when Win celebration is on in Settings (still, with no motion, if your phone asks for less motion), and never covers the scoring buttons.</p>`;
}
// The worn celebration for this phone, or '' (rewards hidden, off, or none worn).
const rwWornFx = () => (rwShown() && RW_FX[rwCur().worn.celebrate] ? rwCur().worn.celebrate : '');
let rwFxTimer = null;
function rwFxClear() {
  clearTimeout(rwFxTimer); rwFxTimer = null;
  document.querySelectorAll('.rw-fx').forEach(el => el.remove());
}
// A game just ended and the device has Win celebration on: show the worn effect. False means "nothing worn, use the default burst".
function rwWinFx() {
  const id = rwWornFx(); if (!id) return false;
  const fx = RW_FX[id], n = 16;
  rwFxClear();
  if (typeof clearConfetti === 'function') clearConfetti();
  let pieces = '';
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + (i % 3) * .12, d = 14 + (i % 5) * 6;
    const x = fx.rain ? ((i % 3) - 1) * 3 : Math.cos(a) * d, y = fx.rain ? 38 + (i % 4) * 3 : Math.sin(a) * d * .7;
    const left = fx.rain ? 6 + i * 5.6 : 50, top = fx.rain ? -6 : 40;
    pieces += rwFxPiece(fx, i, `left:${left.toFixed(1)}%;top:${top}%;--x:${x.toFixed(1)}vmin;--y:${y.toFixed(1)}vmin;--r:${(i % 2 ? 1 : -1) * (40 + i * 18)}deg;--d:${(i % 6) * 50}ms`);
  }
  const box = document.createElement('div');
  box.className = 'rw-fx'; box.dataset.fx = fx.kind; box.setAttribute('aria-hidden', 'true');
  box.innerHTML = pieces;
  document.body.appendChild(box);
  rwFxTimer = setTimeout(rwFxClear, 1500); // longest piece: 250 ms delay + 1.1 s motion
  return true;
}
