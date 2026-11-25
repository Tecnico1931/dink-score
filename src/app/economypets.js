/* ---------- rewards pets: vendored inline SVGs, growth progress and Shop/Play UI (L16 phase 2, #107; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js) ---------- */
// Clean-room geometric inline SVGs on a unified 64x64 viewBox using CSS custom properties only (--pet-1, --pet-2, --pet-3, --pet-eye, --pet-bg; the Yorkie adds --pet-steel, --pet-black, --pet-tan, --pet-gold),
// so every pet follows the app's court-green/lime light, dark and outdoor tokens automatically with zero raster files, zero remote URLs,
// and zero motion or sound. Growth stages (Rookie 0-4, Club 5-14, Veteran 15+) and weekly shiny rotation come solely from the server.
const RW_PET_ORDER = ['pet-frog', 'pet-duck', 'pet-cat', 'pet-owl', 'pet-yorkie', 'pet-pup', 'pet-blob', 'pet-bat', 'pet-turtle', 'pet-fox', 'pet-netdragon', 'pet-supernova'];
const RW_PET_NO_SHINY = ['pet-supernova']; // the Mythic pet has no weekly shiny coat
const RW_PET_NAMES = {
  'pet-frog': 'Court Frog',
  'pet-duck': 'Dink duck',
  'pet-cat': 'Kitchen cat',
  'pet-owl': 'Lob owl',
  'pet-yorkie': 'Yorkie',
  'pet-pup': 'Pickle pup',
  'pet-blob': 'Ball blob',
  'pet-bat': 'Paddle bat',
  'pet-turtle': 'Court turtle',
  'pet-fox': 'Smash fox',
  'pet-netdragon': 'Net dragon',
  'pet-supernova': 'Supernova dragon'
};
const RW_PET_STAGE_LABELS = { 1: 'Rookie', 2: 'Club', 3: 'Veteran' };
const RW_PET_STAR_SVG = '<g data-pet-star="1"><circle cx="54" cy="10" r="7.5" fill="var(--pet-1)"/><polygon points="54,4.5 55.6,8.4 59.5,10 55.6,11.6 54,15.5 52.4,11.6 48.5,10 52.4,8.4" fill="var(--pet-2)"/></g>';

// Pets x 3 growth stages (Rookie, Club, Veteran). Distinct silhouettes at 20 px; tokens only, safe SVG primitives only.
// The six newer pets share one growth recipe (rwPetGrow): Rookie is the body drawn a little smaller, Club adds a lime headband, Veteran steps aside and holds a paddle.
const RW_PET_PAD = '<rect x="46" y="23" width="12" height="15" rx="4.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><rect x="50" y="38" width="4" height="11" rx="2" fill="var(--pet-1)"/>';
const rwPetGrow = (base, band, dx = -6, sc = 1) => ({
  1: `<g transform="translate(32 58) scale(.86) translate(-32 -58)">${base}</g>`,
  2: base + band,
  3: `<g transform="translate(${dx} 0)${sc === 1 ? '' : ` translate(32 58) scale(${sc}) translate(-32 -58)`}">${base}${band}</g>${RW_PET_PAD}`
});
const RW_PET_ART = {
  'pet-frog': {
    1: '<ellipse cx="21" cy="51" rx="6" ry="3.4" fill="var(--pet-1)"/><ellipse cx="43" cy="51" rx="6" ry="3.4" fill="var(--pet-1)"/><ellipse cx="32" cy="40" rx="17" ry="13" fill="var(--pet-1)"/><circle cx="22" cy="24" r="6.8" fill="var(--pet-1)"/><circle cx="42" cy="24" r="6.8" fill="var(--pet-1)"/><circle cx="22" cy="24" r="4.1" fill="var(--pet-eye)"/><circle cx="42" cy="24" r="4.1" fill="var(--pet-eye)"/><circle cx="23" cy="24" r="2" fill="var(--pet-3)"/><circle cx="43" cy="24" r="2" fill="var(--pet-3)"/><ellipse cx="32" cy="44" rx="9.5" ry="6.2" fill="var(--pet-2)"/><circle cx="28" cy="44" r="1.2" fill="var(--pet-3)"/><circle cx="32" cy="42" r="1.2" fill="var(--pet-3)"/><circle cx="36" cy="44" r="1.2" fill="var(--pet-3)"/><path d="M25 34q7 4 14 0" fill="none" stroke="var(--pet-2)" stroke-width="2.4" stroke-linecap="round"/>',
    2: '<ellipse cx="18" cy="52" rx="7.2" ry="3.6" fill="var(--pet-1)"/><ellipse cx="46" cy="52" rx="7.2" ry="3.6" fill="var(--pet-1)"/><ellipse cx="32" cy="41" rx="20" ry="14" fill="var(--pet-1)"/><circle cx="20" cy="22" r="7.4" fill="var(--pet-1)"/><circle cx="44" cy="22" r="7.4" fill="var(--pet-1)"/><circle cx="20" cy="22" r="4.5" fill="var(--pet-eye)"/><circle cx="44" cy="22" r="4.5" fill="var(--pet-eye)"/><circle cx="21" cy="22" r="2.2" fill="var(--pet-3)"/><circle cx="45" cy="22" r="2.2" fill="var(--pet-3)"/><rect x="17" y="27.5" width="30" height="4.4" rx="2.2" fill="var(--pet-2)"/><path d="M23 29.7h18" stroke="var(--pet-3)" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="32" cy="45" rx="11.5" ry="7.2" fill="var(--pet-2)"/><circle cx="27" cy="44.5" r="1.3" fill="var(--pet-3)"/><circle cx="32" cy="42.5" r="1.3" fill="var(--pet-3)"/><circle cx="37" cy="44.5" r="1.3" fill="var(--pet-3)"/><circle cx="32" cy="47.2" r="1.3" fill="var(--pet-3)"/><path d="M24 35.5q8 4 16 0" fill="none" stroke="var(--pet-2)" stroke-width="2.4" stroke-linecap="round"/>',
    3: '<ellipse cx="15" cy="52" rx="6.8" ry="3.6" fill="var(--pet-1)"/><ellipse cx="40" cy="52" rx="6.8" ry="3.6" fill="var(--pet-1)"/><ellipse cx="28" cy="41" rx="19" ry="14" fill="var(--pet-1)"/><circle cx="17" cy="22" r="7.2" fill="var(--pet-1)"/><circle cx="39" cy="22" r="7.2" fill="var(--pet-1)"/><circle cx="17" cy="22" r="4.3" fill="var(--pet-eye)"/><circle cx="39" cy="22" r="4.3" fill="var(--pet-eye)"/><circle cx="18" cy="22" r="2.1" fill="var(--pet-3)"/><circle cx="40" cy="22" r="2.1" fill="var(--pet-3)"/><rect x="14" y="27.5" width="28" height="4.4" rx="2.2" fill="var(--pet-2)"/><path d="M20 29.7h16" stroke="var(--pet-eye)" stroke-width="1.5" stroke-linecap="round"/><ellipse cx="28" cy="45" rx="11" ry="7" fill="var(--pet-2)"/><path d="M22 44.5l6 4 6-4" fill="none" stroke="var(--pet-3)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="46" y="23" width="12" height="15" rx="4.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><path d="M48 30.5h8" stroke="var(--pet-3)" stroke-width="2" stroke-linecap="round"/><rect x="50" y="38" width="4" height="11" rx="2" fill="var(--pet-1)"/>'
  },
  'pet-duck': {
    1: '<path d="M24 51l-3 5h8l-2-5zm12 0l-2 5h8l-3-5z" fill="var(--pet-1)"/><path d="M12 36c2 11 10 17 20 17 10.5 0 17-6 17-13.5 0-4.8-3-8.8-8-9.8-4-.8-9 1-14.5 2.8-5.5 1.8-10.5-.5-14.5-3.5 0 2.5 0 5 0 7z" fill="var(--pet-1)"/><circle cx="37" cy="24" r="10.5" fill="var(--pet-1)"/><path d="M46 21l11 3.5-11 4.2z" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="40" cy="22" r="3.6" fill="var(--pet-eye)"/><circle cx="41" cy="22" r="1.9" fill="var(--pet-3)"/><ellipse cx="29" cy="42" rx="7.2" ry="4.6" fill="var(--pet-2)"/>',
    2: '<path d="M23 51l-3 5h8l-2-5zm13 0l-2 5h8l-3-5z" fill="var(--pet-1)"/><path d="M10 34c2 13 10.5 19 22 19 11.5 0 18.5-6.5 18.5-14.5 0-5.2-3.5-9.5-8.5-10.5-4.5-.8-10 1-16 3-6 2-11.5-.8-16-4.5 0 2.8 0 5.5 0 7.5z" fill="var(--pet-1)"/><circle cx="38" cy="23" r="11.5" fill="var(--pet-1)"/><path d="M31 13.5q5-4 11-1" fill="none" stroke="var(--pet-2)" stroke-width="3" stroke-linecap="round"/><path d="M48 20l11 3.5-11 4.5z" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="41" cy="21" r="3.8" fill="var(--pet-eye)"/><circle cx="42" cy="21" r="2" fill="var(--pet-3)"/><rect x="23" y="37" width="14" height="10" rx="5" fill="var(--pet-2)"/><rect x="17" y="40.5" width="7" height="3.2" rx="1.6" fill="var(--pet-2)"/><circle cx="28" cy="41.5" r="1.2" fill="var(--pet-3)"/><circle cx="32" cy="41.5" r="1.2" fill="var(--pet-3)"/><circle cx="30" cy="44.2" r="1.2" fill="var(--pet-3)"/>',
    3: '<path d="M22 51l-3 5h8l-2-5zm13 0l-2 5h8l-3-5z" fill="var(--pet-1)"/><path d="M9 33c2 14 11 20 22.5 20 12 0 19-6.5 19-14.5 0-5.5-3.5-9.5-8.5-10.5-4.5-.8-10 1-16 3-6 2-12-1-17-5 0 2.8 0 5.2 0 7z" fill="var(--pet-1)"/><circle cx="37" cy="23" r="11.5" fill="var(--pet-1)"/><path d="M27 18.5h20" stroke="var(--pet-2)" stroke-width="3.6" stroke-linecap="round"/><path d="M30 18.5h14" stroke="var(--pet-eye)" stroke-width="1.4" stroke-linecap="round"/><path d="M47 20l12 3.5-12 4.5z" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="40.5" cy="22.5" r="3.6" fill="var(--pet-eye)"/><circle cx="41.5" cy="22.5" r="1.9" fill="var(--pet-3)"/><rect x="23" y="36.5" width="15" height="11" rx="5" fill="var(--pet-2)"/><rect x="16" y="40.2" width="7.5" height="3.4" rx="1.7" fill="var(--pet-2)"/><path d="M26 42h9" stroke="var(--pet-3)" stroke-width="2" stroke-linecap="round"/><path d="M29 39l4 3-4 3" fill="none" stroke="var(--pet-3)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
  },
  'pet-cat': {
    1: '<path d="M39 48c9 0 13-5 12-12.5-.5-3.2-2.6-5-5-4.5" fill="none" stroke="var(--pet-1)" stroke-width="5.2" stroke-linecap="round"/><ellipse cx="29" cy="45" rx="12" ry="11" fill="var(--pet-1)"/><circle cx="29" cy="28" r="11.2" fill="var(--pet-1)"/><polygon points="18,24 17,11 27,18" fill="var(--pet-1)"/><polygon points="40,24 41,11 31,18" fill="var(--pet-1)"/><polygon points="19.8,21 19.3,14.8 24.5,18.5" fill="var(--pet-2)"/><polygon points="38.2,21 38.7,14.8 33.5,18.5" fill="var(--pet-2)"/><circle cx="24.5" cy="28" r="3.4" fill="var(--pet-eye)"/><circle cx="33.5" cy="28" r="3.4" fill="var(--pet-eye)"/><circle cx="25" cy="28" r="1.8" fill="var(--pet-3)"/><circle cx="34" cy="28" r="1.8" fill="var(--pet-3)"/><polygon points="29,33.2 26.5,30.6 31.5,30.6" fill="var(--pet-2)"/><ellipse cx="29" cy="46.5" rx="5.5" ry="6" fill="var(--pet-2)"/>',
    2: '<path d="M40 49c10.5 0 15-6 14-15.5-.6-4.5-3.2-7-6.2-6.5" fill="none" stroke="var(--pet-1)" stroke-width="5.6" stroke-linecap="round"/><ellipse cx="28" cy="45" rx="13.5" ry="12" fill="var(--pet-1)"/><circle cx="28" cy="25" r="12" fill="var(--pet-1)"/><polygon points="17,21 15.5,8.5 26,15.5" fill="var(--pet-1)"/><polygon points="39,21 40.5,8.5 30,15.5" fill="var(--pet-1)"/><polygon points="18.5,18.5 18,12 23.5,16" fill="var(--pet-2)"/><polygon points="37.5,18.5 38,12 32.5,16" fill="var(--pet-2)"/><circle cx="23.5" cy="25" r="3.6" fill="var(--pet-eye)"/><circle cx="32.5" cy="25" r="3.6" fill="var(--pet-eye)"/><circle cx="24" cy="25" r="1.9" fill="var(--pet-3)"/><circle cx="33" cy="25" r="1.9" fill="var(--pet-3)"/><polygon points="28,30.5 25.5,27.8 30.5,27.8" fill="var(--pet-2)"/><rect x="18.5" y="34.5" width="19" height="3.6" rx="1.8" fill="var(--pet-2)"/><circle cx="28" cy="41.8" r="4.5" fill="var(--pet-2)"/><circle cx="26.5" cy="41.5" r="1" fill="var(--pet-3)"/><circle cx="29.5" cy="41.5" r="1" fill="var(--pet-3)"/><circle cx="28" cy="43.5" r="1" fill="var(--pet-3)"/>',
    3: '<path d="M38 50c8 0 12-4 13-11" fill="none" stroke="var(--pet-1)" stroke-width="5.2" stroke-linecap="round"/><ellipse cx="26" cy="45" rx="13.5" ry="12" fill="var(--pet-1)"/><circle cx="26" cy="25" r="12" fill="var(--pet-1)"/><polygon points="15,21 13.5,8.5 24,15.5" fill="var(--pet-1)"/><polygon points="37,21 38.5,8.5 28,15.5" fill="var(--pet-1)"/><polygon points="16.5,18.5 16,12 21.5,16" fill="var(--pet-2)"/><polygon points="35.5,18.5 36,12 30.5,16" fill="var(--pet-2)"/><circle cx="21.5" cy="25" r="3.6" fill="var(--pet-eye)"/><circle cx="30.5" cy="25" r="3.6" fill="var(--pet-eye)"/><circle cx="22" cy="25" r="1.9" fill="var(--pet-3)"/><circle cx="31" cy="25" r="1.9" fill="var(--pet-3)"/><polygon points="26,30.5 23.5,27.8 28.5,27.8" fill="var(--pet-2)"/><rect x="16.5" y="34.5" width="19" height="3.6" rx="1.8" fill="var(--pet-2)"/><polygon points="26,41 32,45 26,51 20,45" fill="var(--pet-2)"/><path d="M22.5 45h7" stroke="var(--pet-3)" stroke-width="1.8" stroke-linecap="round"/><rect x="46" y="23" width="11.5" height="15" rx="4.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><path d="M48 30.5h7.5" stroke="var(--pet-3)" stroke-width="2" stroke-linecap="round"/><rect x="49.8" y="38" width="4" height="10" rx="2" fill="var(--pet-1)"/>'
  },
  'pet-owl': {
    1: '<path d="M24 53h6M34 53h6" stroke="var(--pet-1)" stroke-width="3.6" stroke-linecap="round"/><ellipse cx="32" cy="37" rx="15" ry="16.5" fill="var(--pet-1)"/><polygon points="19,25 16,13 27,20" fill="var(--pet-1)"/><polygon points="45,25 48,13 37,20" fill="var(--pet-1)"/><circle cx="25" cy="31" r="7.2" fill="var(--pet-2)"/><circle cx="39" cy="31" r="7.2" fill="var(--pet-2)"/><circle cx="25" cy="31" r="4.9" fill="var(--pet-eye)"/><circle cx="39" cy="31" r="4.9" fill="var(--pet-eye)"/><circle cx="25" cy="31" r="2.4" fill="var(--pet-3)"/><circle cx="39" cy="31" r="2.4" fill="var(--pet-3)"/><polygon points="32,39.5 29,34.2 35,34.2" fill="var(--pet-2)"/><path d="M25 46q7 4 14 0" fill="none" stroke="var(--pet-2)" stroke-width="2.6" stroke-linecap="round"/>',
    2: '<path d="M22 54h7M35 54h7" stroke="var(--pet-1)" stroke-width="3.8" stroke-linecap="round"/><ellipse cx="32" cy="37" rx="18" ry="18.5" fill="var(--pet-1)"/><polygon points="16,24 13,11 26,19" fill="var(--pet-1)"/><polygon points="48,24 46,12 38,19" fill="var(--pet-1)"/><rect x="17" y="21.5" width="30" height="2.8" rx="1.4" fill="var(--pet-2)"/><circle cx="24.5" cy="31" r="7.6" fill="var(--pet-2)"/><circle cx="39.5" cy="31" r="7.6" fill="var(--pet-2)"/><circle cx="24.5" cy="31" r="5.2" fill="var(--pet-eye)"/><circle cx="39.5" cy="31" r="5.2" fill="var(--pet-eye)"/><circle cx="24.5" cy="31" r="2.5" fill="var(--pet-3)"/><circle cx="39.5" cy="31" r="2.5" fill="var(--pet-3)"/><polygon points="32,39.5 28.8,34 35.2,34" fill="var(--pet-2)"/><circle cx="32" cy="46.5" r="5.2" fill="var(--pet-2)"/><circle cx="30" cy="46" r="1.1" fill="var(--pet-3)"/><circle cx="34" cy="46" r="1.1" fill="var(--pet-3)"/><circle cx="32" cy="48.5" r="1.1" fill="var(--pet-3)"/>',
    3: '<path d="M19 54h7M31 54h7" stroke="var(--pet-1)" stroke-width="3.8" stroke-linecap="round"/><ellipse cx="28" cy="37" rx="17.5" ry="18.5" fill="var(--pet-1)"/><polygon points="13,24 10,11 22,19" fill="var(--pet-1)"/><polygon points="43,24 44,12 34,19" fill="var(--pet-1)"/><polygon points="13,18 11.5,12.5 17,16" fill="var(--pet-2)"/><polygon points="41.5,18 42.5,13 37.5,16" fill="var(--pet-2)"/><rect x="13.5" y="21.5" width="29" height="2.8" rx="1.4" fill="var(--pet-2)"/><circle cx="20.8" cy="31" r="7.4" fill="var(--pet-2)"/><circle cx="35.2" cy="31" r="7.4" fill="var(--pet-2)"/><circle cx="20.8" cy="31" r="5" fill="var(--pet-eye)"/><circle cx="35.2" cy="31" r="5" fill="var(--pet-eye)"/><circle cx="20.8" cy="31" r="2.4" fill="var(--pet-3)"/><circle cx="35.2" cy="31" r="2.4" fill="var(--pet-3)"/><polygon points="28,39.5 24.8,34 31.2,34" fill="var(--pet-2)"/><polygon points="28,42 35,45.5 28,51.5 21,45.5" fill="var(--pet-2)"/><path d="M24 46h8" stroke="var(--pet-3)" stroke-width="1.9" stroke-linecap="round"/><rect x="46" y="23" width="11.5" height="15" rx="4.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><path d="M48 30.5h7.5" stroke="var(--pet-3)" stroke-width="2" stroke-linecap="round"/><rect x="49.8" y="38" width="4" height="10" rx="2" fill="var(--pet-1)"/>'
  },
  // Yorkie: front-facing sitting dog with two tall upright ears, a topknot and a long A-shaped silky coat. Own palette (--pet-steel/-black/-tan/-gold, defined
  // with color-mix() from theme tokens next to .rw-pet in dink-score.html), so the shiny colourway is a CSS swap, never a hex.
  'pet-yorkie': {
    1: '<path d="M19 57c-2-12 2-19 13-19s15 7 13 19z" fill="var(--pet-steel)"/><ellipse cx="32" cy="48" rx="6" ry="8" fill="var(--pet-tan)"/><ellipse cx="24" cy="57" rx="5" ry="2.6" fill="var(--pet-tan)"/><ellipse cx="40" cy="57" rx="5" ry="2.6" fill="var(--pet-tan)"/><path d="M19 24L18 9l11 8zM45 24l1-15-11 8z" fill="var(--pet-black)" stroke="var(--pet-steel)" stroke-width="1.6" stroke-linejoin="round"/><path d="M20.8 21l-.4-7.2 5.6 3.8zM43.2 21l.4-7.2-5.6 3.8z" fill="var(--pet-gold)"/><circle cx="32" cy="27" r="12" fill="var(--pet-tan)"/><circle cx="32" cy="13.5" r="3.4" fill="var(--pet-steel)"/><ellipse cx="32" cy="32.5" rx="6.4" ry="4.8" fill="var(--pet-gold)"/><path d="M25.5 25h.1M38.5 25h.1" stroke="var(--pet-eye)" stroke-width="6.4" stroke-linecap="round"/><path d="M26 25.4h.1M39 25.4h.1" stroke="var(--pet-3)" stroke-width="3.4" stroke-linecap="round"/><ellipse cx="32" cy="30.4" rx="2.6" ry="1.9" fill="var(--pet-black)"/><path d="M29 34.6q3 2.4 6 0" fill="none" stroke="var(--pet-black)" stroke-width="1.4" stroke-linecap="round"/>',
    2: '<path d="M16 57c-3-14 1-21 16-21s19 7 16 21z" fill="var(--pet-steel)"/><path d="M18.5 53q-1.5-6 2-10M45.5 53q1.5-6-2-10" fill="none" stroke="var(--pet-black)" stroke-width="3.2" stroke-linecap="round"/><ellipse cx="32" cy="48" rx="7" ry="9" fill="var(--pet-tan)"/><ellipse cx="23" cy="57" rx="5.4" ry="2.8" fill="var(--pet-tan)"/><ellipse cx="41" cy="57" rx="5.4" ry="2.8" fill="var(--pet-tan)"/><path d="M17.5 24L16 7l13 9zM46.5 24L48 7 35 16z" fill="var(--pet-black)" stroke="var(--pet-steel)" stroke-width="1.6" stroke-linejoin="round"/><path d="M19.6 20.5L19 12l7 4.6zM44.4 20.5L45 12l-7 4.6z" fill="var(--pet-gold)"/><circle cx="32" cy="26.5" r="13" fill="var(--pet-tan)"/><circle cx="32" cy="14" r="3.4" fill="var(--pet-steel)"/><path d="M32 11.5L25 7.5v8zM32 11.5l7-4v8z" fill="var(--pet-2)"/><circle cx="32" cy="11.5" r="2" fill="var(--pet-3)"/><ellipse cx="32" cy="32.5" rx="7" ry="5.2" fill="var(--pet-gold)"/><path d="M25 25h.1M39 25h.1" stroke="var(--pet-eye)" stroke-width="6.8" stroke-linecap="round"/><path d="M25.5 25.4h.1M39.5 25.4h.1" stroke="var(--pet-3)" stroke-width="3.6" stroke-linecap="round"/><ellipse cx="32" cy="30.2" rx="2.8" ry="2" fill="var(--pet-black)"/><path d="M28.8 35q3.2 2.6 6.4 0" fill="none" stroke="var(--pet-black)" stroke-width="1.4" stroke-linecap="round"/>',
    3: '<g transform="translate(-4 0)"><path d="M10 58c-5-17 2-23 22-23s27 6 22 23z" fill="var(--pet-steel)"/><ellipse cx="32" cy="49" rx="7.4" ry="9" fill="var(--pet-tan)"/><path d="M17.5 24L16 7l13 9zM46.5 24L48 7 35 16z" fill="var(--pet-black)" stroke="var(--pet-steel)" stroke-width="1.6" stroke-linejoin="round"/><path d="M19.6 20.5L19 12l7 4.6zM44.4 20.5L45 12l-7 4.6z" fill="var(--pet-gold)"/><circle cx="32" cy="26.5" r="13" fill="var(--pet-tan)"/><circle cx="32" cy="14" r="3.4" fill="var(--pet-steel)"/><path d="M32 11.5L25 7.5v8zM32 11.5l7-4v8z" fill="var(--pet-2)"/><circle cx="32" cy="11.5" r="2" fill="var(--pet-3)"/><ellipse cx="32" cy="32.5" rx="7" ry="5.2" fill="var(--pet-gold)"/><path d="M25 25h.1M39 25h.1" stroke="var(--pet-eye)" stroke-width="6.8" stroke-linecap="round"/><path d="M25.5 25.4h.1M39.5 25.4h.1" stroke="var(--pet-3)" stroke-width="3.6" stroke-linecap="round"/><ellipse cx="32" cy="30.2" rx="2.8" ry="2" fill="var(--pet-black)"/><path d="M28.8 35q3.2 2.6 6.4 0" fill="none" stroke="var(--pet-black)" stroke-width="1.4" stroke-linecap="round"/></g><rect x="46" y="23" width="12" height="15" rx="4.5" fill="var(--pet-2)" stroke="var(--pet-steel)" stroke-width="2.2"/><rect x="50" y="38" width="4" height="11" rx="2" fill="var(--pet-steel)"/>'
  }
};

// Pickle pup: floppy ears, lime muzzle and three pickle bumps. Ball blob: a round ball with seams and no ears. Paddle bat: two paddle-shaped wings.
// Court turtle: a shell with court lines, facing right. Smash fox: pointed ears, lime muzzle and a tipped tail. Net dragon: horns, wings and a net on its belly.
const RW_ND_BASE = '<polygon points="20,38 5,26 7,46" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2" stroke-linejoin="round"/><polygon points="44,38 59,26 57,46" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2" stroke-linejoin="round"/><path d="M43 52c9 3 13-4 10-10" fill="none" stroke="var(--pet-1)" stroke-width="4.6" stroke-linecap="round"/><ellipse cx="32" cy="46" rx="12" ry="10.5" fill="var(--pet-1)"/><ellipse cx="32" cy="48" rx="7.4" ry="7" fill="var(--pet-2)"/><path d="M26 45.5h12M26 49h12M26 52.5h12M29 42v13M35 42v13" stroke="var(--pet-3)" stroke-width="1.1"/><polygon points="22,24 17,8 29,17" fill="var(--pet-2)"/><polygon points="42,24 47,8 35,17" fill="var(--pet-2)"/><circle cx="32" cy="28" r="11.6" fill="var(--pet-1)"/><circle cx="26.6" cy="26" r="3.4" fill="var(--pet-eye)"/><circle cx="37.4" cy="26" r="3.4" fill="var(--pet-eye)"/><circle cx="27" cy="26" r="1.8" fill="var(--pet-3)"/><circle cx="37.8" cy="26" r="1.8" fill="var(--pet-3)"/>';
const RW_ND_BAND = '<rect x="22" y="19.5" width="20" height="3.4" rx="1.7" fill="var(--pet-2)"/>';
Object.assign(RW_PET_ART, {
  'pet-pup': rwPetGrow('<ellipse cx="22" cy="56" rx="5.5" ry="3" fill="var(--pet-1)"/><ellipse cx="42" cy="56" rx="5.5" ry="3" fill="var(--pet-1)"/><path d="M45 48c7 0 10-5 9-11" fill="none" stroke="var(--pet-1)" stroke-width="4.6" stroke-linecap="round"/><ellipse cx="32" cy="44" rx="14" ry="12" fill="var(--pet-1)"/><circle cx="26" cy="43" r="1.3" fill="var(--pet-2)"/><circle cx="32" cy="48" r="1.3" fill="var(--pet-2)"/><circle cx="38" cy="43" r="1.3" fill="var(--pet-2)"/><circle cx="32" cy="26" r="12" fill="var(--pet-1)"/><ellipse cx="19" cy="29" rx="4.6" ry="9" fill="var(--pet-2)"/><ellipse cx="45" cy="29" rx="4.6" ry="9" fill="var(--pet-2)"/><circle cx="27" cy="24" r="3.3" fill="var(--pet-eye)"/><circle cx="37" cy="24" r="3.3" fill="var(--pet-eye)"/><circle cx="27.6" cy="24" r="1.7" fill="var(--pet-3)"/><circle cx="37.6" cy="24" r="1.7" fill="var(--pet-3)"/><ellipse cx="32" cy="31" rx="5.6" ry="4" fill="var(--pet-2)"/><ellipse cx="32" cy="29.4" rx="2.3" ry="1.6" fill="var(--pet-3)"/>',
    '<rect x="21" y="16.5" width="22" height="4" rx="2" fill="var(--pet-2)"/><circle cx="32" cy="18.5" r="1.1" fill="var(--pet-3)"/>'),
  'pet-blob': rwPetGrow('<ellipse cx="23" cy="57" rx="5" ry="2.8" fill="var(--pet-1)"/><ellipse cx="41" cy="57" rx="5" ry="2.8" fill="var(--pet-1)"/><circle cx="32" cy="37" r="20" fill="var(--pet-1)"/><path d="M13 27q19 10 38 0M13 47q19-10 38 0" fill="none" stroke="var(--pet-2)" stroke-width="2.6" stroke-linecap="round"/><circle cx="25" cy="37" r="4.2" fill="var(--pet-eye)"/><circle cx="39" cy="37" r="4.2" fill="var(--pet-eye)"/><circle cx="25.8" cy="37" r="2.1" fill="var(--pet-3)"/><circle cx="39.8" cy="37" r="2.1" fill="var(--pet-3)"/><path d="M28 44q4 3.2 8 0" fill="none" stroke="var(--pet-3)" stroke-width="2" stroke-linecap="round"/>',
    '<rect x="14" y="21" width="36" height="4.6" rx="2.3" fill="var(--pet-2)"/><path d="M20 23.3h24" stroke="var(--pet-3)" stroke-width="1.4" stroke-linecap="round"/>'),
  'pet-bat': rwPetGrow('<ellipse cx="16" cy="32" rx="8" ry="12.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><ellipse cx="48" cy="32" rx="8" ry="12.5" fill="var(--pet-2)" stroke="var(--pet-1)" stroke-width="2.2"/><path d="M16 27v10M48 27v10" stroke="var(--pet-3)" stroke-width="1.8" stroke-linecap="round"/><ellipse cx="32" cy="37" rx="12.5" ry="15" fill="var(--pet-1)"/><polygon points="22,25 20,10 30,19" fill="var(--pet-1)"/><polygon points="42,25 44,10 34,19" fill="var(--pet-1)"/><polygon points="22.6,22 21.6,14 27,19" fill="var(--pet-2)"/><polygon points="41.4,22 42.4,14 37,19" fill="var(--pet-2)"/><circle cx="26.6" cy="32" r="3.7" fill="var(--pet-eye)"/><circle cx="37.4" cy="32" r="3.7" fill="var(--pet-eye)"/><circle cx="27" cy="32" r="1.9" fill="var(--pet-3)"/><circle cx="37.8" cy="32" r="1.9" fill="var(--pet-3)"/><path d="M28.5 41q3.5 3 7 0" fill="none" stroke="var(--pet-2)" stroke-width="2.2" stroke-linecap="round"/><path d="M27 52v4M37 52v4" stroke="var(--pet-1)" stroke-width="3.4" stroke-linecap="round"/>',
    '<rect x="22" y="23" width="20" height="3.6" rx="1.8" fill="var(--pet-2)"/>'),
  'pet-turtle': rwPetGrow('<ellipse cx="19" cy="53" rx="5" ry="3" fill="var(--pet-1)"/><ellipse cx="40" cy="53" rx="5" ry="3" fill="var(--pet-1)"/><polygon points="9,46 2,50 10,51" fill="var(--pet-1)"/><circle cx="52" cy="37" r="6.6" fill="var(--pet-1)"/><ellipse cx="29" cy="40" rx="21" ry="15" fill="var(--pet-1)"/><rect x="16" y="32" width="26" height="15" rx="2.4" fill="none" stroke="var(--pet-2)" stroke-width="2.2"/><path d="M29 32v15M16 39.5h26" stroke="var(--pet-2)" stroke-width="2"/><circle cx="54" cy="35.4" r="2.5" fill="var(--pet-eye)"/><circle cx="54.6" cy="35.4" r="1.2" fill="var(--pet-3)"/><path d="M50 40.4q3 2 6 0" fill="none" stroke="var(--pet-3)" stroke-width="1.6" stroke-linecap="round"/>',
    '<rect x="46" y="30" width="12" height="3" rx="1.5" fill="var(--pet-2)"/>', -7, .8),
  'pet-fox': rwPetGrow('<ellipse cx="50" cy="47" rx="8" ry="5.2" fill="var(--pet-1)"/><circle cx="56" cy="46.6" r="3.4" fill="var(--pet-2)"/><ellipse cx="32" cy="48" rx="11" ry="9" fill="var(--pet-1)"/><ellipse cx="27" cy="57" rx="4.4" ry="2.4" fill="var(--pet-1)"/><ellipse cx="37" cy="57" rx="4.4" ry="2.4" fill="var(--pet-1)"/><polygon points="19,24 18,8 30,17" fill="var(--pet-1)"/><polygon points="45,24 46,8 34,17" fill="var(--pet-1)"/><polygon points="20.4,21 19.8,12.6 26.4,17.4" fill="var(--pet-2)"/><polygon points="43.6,21 44.2,12.6 37.6,17.4" fill="var(--pet-2)"/><circle cx="32" cy="28" r="12" fill="var(--pet-1)"/><polygon points="32,41 20,29.5 44,29.5" fill="var(--pet-2)"/><ellipse cx="25.4" cy="26" rx="3" ry="3.4" fill="var(--pet-eye)"/><ellipse cx="38.6" cy="26" rx="3" ry="3.4" fill="var(--pet-eye)"/><circle cx="26" cy="26.4" r="1.6" fill="var(--pet-3)"/><circle cx="39.2" cy="26.4" r="1.6" fill="var(--pet-3)"/><circle cx="32" cy="34.4" r="2.2" fill="var(--pet-3)"/>',
    '<rect x="21" y="18.5" width="22" height="3.6" rx="1.8" fill="var(--pet-2)"/>', -9),
  'pet-netdragon': rwPetGrow(RW_ND_BASE, RW_ND_BAND, -4)
});
// Supernova dragon (WI-13, Mythic): the Net dragon's body on its own cosmic palette (CSS, data-pet="pet-supernova") with a bright core on the belly and a spark.
const RW_PET_NOVA_CORE = '<circle cx="32" cy="48" r="3.6" fill="var(--pet-1)"/><circle cx="32" cy="48" r="1.5" fill="var(--pet-eye)"/>';
const RW_PET_NOVA_SPARK = '<path d="M10 14l1.5 3.5L15 19l-3.5 1.5L10 24l-1.5-3.5L5 19l3.5-1.5z" fill="var(--pet-2)"/>';
const rwNova = rwPetGrow(RW_ND_BASE + RW_PET_NOVA_CORE, RW_ND_BAND, -4); // the core is inside the grown body so it follows the Veteran step aside
RW_PET_ART['pet-supernova'] = Object.fromEntries([1, 2, 3].map(n => [n, rwNova[n] + RW_PET_NOVA_SPARK]));

const rwPetNormId = id => {
  const s = String(id || '');
  const full = s.startsWith('pet-') ? s : 'pet-' + s;
  return RW_PET_ART[full] ? full : '';
};
const rwPetNormStage = stage => (stage === 2 || stage === 3 ? stage : 1);
const rwPetStageLabel = stage => RW_PET_STAGE_LABELS[rwPetNormStage(stage)];
const rwPetName = id => RW_PET_NAMES[rwPetNormId(id)] || '';

// Accessible name for a pet portrait (used on role="img" SVGs and tests).
function rwPetAccessibleName(id, stage = 1, shiny = false) {
  const key = rwPetNormId(id);
  if (!key) return '';
  const st = rwPetStageLabel(stage);
  return `${RW_PET_NAMES[key]}, ${st}${shiny ? ', shiny coat' : ''}`;
}

// Pure SVG renderer for any pet, growth stage (1|2|3) and optional weekly shiny star pip.
// Decorative SVGs (inside labelled buttons) get aria-hidden="true"; standalone portraits get role="img" and aria-label.
function rwPetSvg(id, { stage = 1, shiny = false, decorative = false, size = 44 } = {}) {
  const key = rwPetNormId(id);
  if (!key) return '';
  const st = rwPetNormStage(stage);
  const px = Number.isFinite(size) && size >= 16 && size <= 128 ? Math.round(size) : 44;
  const body = RW_PET_ART[key][st] + (shiny ? RW_PET_STAR_SVG : '');
  const a11y = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${esc(rwPetAccessibleName(key, st, !!shiny))}"`;
  return `<svg viewBox="0 0 64 64" width="${px}" height="${px}" focusable="false" ${a11y}>${body}</svg>`;
}

// Circular tokenised pet badge (reusable at 20 px, 36 px, 40 px, 44 px).
function rwPetBadgeHTML(id, { stage = 1, shiny = false, decorative = false, size = 40 } = {}) {
  const key = rwPetNormId(id);
  if (!key) return '';
  const cls = size <= 22 ? ' sm' : size <= 36 ? ' md' : size >= 44 ? ' lg' : '';
  return `<span class="rw-pet${cls}" data-pet="${esc(key)}" data-pet-stage="${rwPetNormStage(stage)}" data-pet-shiny="${shiny ? 'true' : 'false'}">${rwPetSvg(key, { stage, shiny, decorative, size })}</span>`;
}

// Plain-words growth stage line showing current stage and verified play days to the next stage.
function rwPetStageLine(pet) {
  if (!pet) return '';
  const st = rwPetNormStage(pet.stage);
  const label = pet.stageLabel && RW_PET_STAGE_LABELS[st] === pet.stageLabel ? pet.stageLabel : rwPetStageLabel(st);
  const days = Number.isFinite(pet.playDays) ? Math.max(0, Math.floor(pet.playDays)) : 0;
  const nextDays = Number.isFinite(pet.nextStageDays) && pet.nextStageDays > days ? Math.floor(pet.nextStageDays) : null;
  if (nextDays !== null && st < 3) {
    const left = nextDays - days;
    const nextLabel = rwPetStageLabel(st + 1);
    return `${label} · ${left} more ${left === 1 ? 'play day' : 'play days'} to ${nextLabel} (${days}/${nextDays})`;
  }
  return days > 0 ? `${label} · ${days} ${days === 1 ? 'play day' : 'play days'}` : label;
}

// Plain-words shiny rotation explanation, one pet a week in turn over every pet (zero FOMO, deterministic Monday 00:00 UTC cadence).
function rwPetRotationCopy(shinyWeek) {
  const order = RW_PET_ORDER.filter(id => !RW_PET_NO_SHINY.includes(id)).map(id => RW_PET_NAMES[id]).join(' → ');
  const cur = shinyWeek && rwPetName(shinyWeek.petId);
  return cur
    ? `Each pet gets a free shiny coat in turn, rotating every Monday (UTC): ${order}.`
    : `Pets grow through verified play days: Rookie (0–4), Club (5–14), Veteran (15+). Free shiny coat rotates every Monday (UTC): ${order}.`;
}

// Dedicated "Court pets" section for the Shop sheet: court-green spotlight header, owned pet picker with growth progress,
// one-tap weekly Shiny coat toggle (shown ONLY during the pet's featured week), and Adopt list for unowned pets.
function rwPetsSectionHTML(c, s) {
  if (!s || !Array.isArray(s.items)) return '';
  const pets = s.items.filter(i => i.slot === 'pet');
  if (!pets.length) return '';
  const owned = pets.filter(i => i.owned);
  const unowned = pets.filter(i => !i.owned && i.rarity !== 'legendary' && i.rarity !== 'mythic'); // those two sit on the Legendary and Mythic shelves
  const wornPet = (s.worn && s.worn.pet) || '';
  const sw = s.shinyWeek && rwPetNormId(s.shinyWeek.petId) ? s.shinyWeek : null;
  const featuredOwned = owned.find(p => p.featuredShiny) || null;
  const headPetId = sw ? sw.petId : 'pet-frog';
  const headStage = featuredOwned && featuredOwned.id === headPetId ? featuredOwned.stage : 2;
  // Hero card for the week's shiny coat: the end is a date (Monday 00:00 UTC), never a countdown. Free toggle for an owner, a quiet locked state otherwise.
  const swName = sw ? rwPetName(sw.petId) : '';
  const swEnd = sw && Number.isFinite(sw.end) ? new Date(sw.end - 1).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  const swOwned = !!featuredOwned;
  const head = sw
    ? `<div class="rw-hero">${rwPetBadgeHTML(headPetId, { stage: headStage, shiny: true, decorative: true, size: 44 })}<div class="rw-hero-txt"><span class="rw-badge" data-rarity="shiny"><span aria-hidden="true">✦ </span>Shiny this week</span><b>Shiny ${esc(swName.toLowerCase())}</b><p>A rare colour version for anyone who owns the ${esc(swName)}. It keeps its level.${swEnd ? ` Free until ${esc(swEnd)}.` : ''} Next week, another pet.</p>${swOwned ? '' : `<button type="button" class="btn btn-soft rw-hero-lock" aria-disabled="true">Get the ${esc(swName.toLowerCase())} first</button>`}</div></div><p class="note">${esc(rwPetRotationCopy(sw))}</p>`
    : `<div class="rw-pets-head">${rwPetBadgeHTML(headPetId, { stage: headStage, shiny: false, decorative: true, size: 44 })}<span><b>Court companions</b><small>${esc(rwPetRotationCopy(null))}</small></span></div>`;

  let picker = '';
  if (owned.length) {
    const noneBtn = `<button type="button" class="rw-pet-opt" data-rw-wear="pet:" aria-pressed="${!wornPet}" ${c.busy ? 'disabled' : ''}><span class="rw-pet-meta"><b>None</b><small>Hide your pet companion on Your Dink</small></span></button>`;
    const petBtns = owned.map(p => {
      const active = wornPet === p.id;
      const badge = rwPetBadgeHTML(p.id, { stage: p.stage, shiny: !!p.shiny, decorative: true, size: 36 });
      const sub = rwPetStageLine(p) + (p.shiny ? ' · Shiny coat on' : p.featuredShiny ? ' · Shiny coat available this week' : '');
      return `<button type="button" class="rw-pet-opt" data-rw-wear="pet:${esc(p.id)}" aria-pressed="${active}" ${c.busy ? 'disabled' : ''}>${badge}<span class="rw-pet-meta"><b>${esc(p.name)}</b><small>${esc(sub)}</small></span></button>`;
    }).join('');
    picker = `<fieldset class="rw-pick rw-pet-pick"><legend>Your companion</legend>${noneBtn}${petBtns}</fieldset>`;
  }

  let shinyToggle = '';
  if (featuredOwned) {
    const on = !!featuredOwned.shiny;
    const wornIt = wornPet === featuredOwned.id;
    const note = on
      ? `Active this week — switches back to classic next Monday (UTC).`
      : wornIt
        ? `Free this week while ${featuredOwned.name} is featured.`
        : `Free this week — tapping puts ${featuredOwned.name} on in its shiny coat.`;
    shinyToggle = `<button type="button" class="rw-share rw-pet-shiny" data-rw-shiny="${esc(featuredOwned.id)}:${on ? '0' : '1'}" aria-pressed="${on}" ${c.busy ? 'disabled' : ''}><span><b>Shiny coat for ${esc(featuredOwned.name)} (this week)</b><small>${esc(note)}</small></span><span class="rw-pill" aria-hidden="true">${on ? 'On' : 'Off'}</span></button>`;
  }

  const adoptRows = unowned.length && typeof rwShelf === 'function' ? rwShelf(c, s, unowned) : '';
  const adopt = adoptRows
    ? `<div><p class="note">Fixed prices, bought once. Pets grow through verified play days: Rookie (0–4), Club (5–14), Veteran (15+).</p>${adoptRows}</div>`
    : '<p class="note">You have adopted every court pet.</p>';

  const more = `<button type="button" class="btn btn-soft rw-pets-more" data-rw="pets"${c.busy ? ' disabled' : ''}>Pet collection: see how every pet grows</button>`;
  return `${rwSecHead('Pets', 'A little buddy that hangs out by your picture.')}<section class="rw-pets" aria-label="Court pets">${head}${picker}${shinyToggle}${adopt}${more}</section>`;
}

// "Pet collection" sheet: every pet at its three growth stages, drawn with the same renderer as everywhere else. Reads the shop answer already on the phone.
const RW_PET_STAGE_DAYS = { 1: 'from day 1', 2: 'after 5 play days', 3: 'after 15 play days' };
function rwPetCollectionHTML(c) {
  const done = '<div class="btns"><button type="button" class="btn btn-soft" data-rw="store">Back to the shop</button></div>';
  const head = '<h2 id="club-h" tabindex="-1">Pet collection</h2>';
  if (!rwShown()) return `${head}<p class="note">Rewards are hidden on this phone.</p>${done}`;
  const items = (c.store && c.store.items || []).filter(i => i.slot === 'pet');
  const rows = RW_PET_ORDER.map(id => {
    const it = items.find(i => i.id === id), stages = [1, 2, 3].map(n => `<li><span class="rw-stage-art">${rwPetBadgeHTML(id, { stage: n, decorative: true, size: 44 })}</span><b>${rwPetStageLabel(n)}</b><small>${RW_PET_STAGE_DAYS[n]}</small></li>`).join('');
    const mine = it && it.owned ? `<small class="rw-stage-own">Yours: ${esc(it.stageLabel || rwPetStageLabel(it.stage || 1))}</small>` : '';
    return `<li class="rw-stage-pet"><div class="rw-stage-top"><b>${esc(rwPetName(id))}</b>${mine}</div><ol class="rw-stages">${stages}</ol></li>`;
  }).join('');
  return `${head}<p class="note">Every pet grows with the days you play, not with scores or wins: Rookie, then Club after 5 play days, then Veteran after 15. A pet keeps its level in its shiny coat.</p><ul class="rw-stage-list">${rows}</ul>${done}`;
}
