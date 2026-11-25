/*DISPLAY-START*/
const DisplayPrefs = (() => {
  const THEMES = { auto: 'auto', light: 'light', dark: 'dark' };
  const PALETTES = [
    { id: 'green', name: 'Court Green', light: '#F2F4F7', dark: '#0A0F17', c1: '#0E7A55', c2: '#0A5E42' },
    { id: 'blue', name: 'Court Blue', light: '#F1F4F9', dark: '#090E18', c1: '#1552A3', c2: '#0D3A78' },
    { id: 'clay', name: 'Clay Red', light: '#F6F3F0', dark: '#120C0B', c1: '#A83224', c2: '#7E2218' },
    { id: 'violet', name: 'Indoor Violet', light: '#F4F2F8', dark: '#0D0A14', c1: '#5E2CA5', c2: '#441D7D' },
    { id: 'sunset', name: 'Sunset Orange', light: '#F7F4EF', dark: '#120E0A', c1: '#A64100', c2: '#7E2F00' },
    { id: 'slate', name: 'Club Slate', light: '#F3F4F6', dark: '#0A0C10', c1: '#2C384A', c2: '#1B2330' }
  ];
  // Rewarded court themes (WI-16): extra palettes, set only from the worn `theme` item; never in the free picker. c1/c2 draw the card preview.
  const SHOP_THEMES = [
    { id: 't-sunset', item: 'theme-sunset', name: 'Sunset court', light: '#F6F0EF', dark: '#150C0A', c1: '#B42236', c2: '#5F3286' },
    { id: 't-clay', item: 'theme-clay', name: 'Clay court', light: '#F6F2EF', dark: '#150E0A', c1: '#954523', c2: '#325986' },
    { id: 't-grass', item: 'theme-grass', name: 'Grass court', light: '#F1F6EF', dark: '#0E150A', c1: '#376921', c2: '#445D1D' },
    { id: 't-neon', item: 'theme-neon', name: 'Neon court', light: '#F6EFF6', dark: '#150A15', c1: '#A81594', c2: '#0C5C79' },
    { id: 't-beach', item: 'theme-beach', name: 'Beach court', light: '#F6F3EF', dark: '#15110A', c1: '#825017', c2: '#155B75' },
    { id: 't-ice', item: 'theme-ice', name: 'Ice rink', light: '#EFF3F6', dark: '#0A1015', c1: '#285E95', c2: '#315D68' },
    { id: 't-midnight', item: 'theme-midnight', name: 'Midnight court', light: '#EFF0F6', dark: '#0A0B15', c1: '#364DAB', c2: '#593286' },
    { id: 't-arcade', item: 'theme-arcade', name: 'Retro arcade', light: '#F6EFF3', dark: '#150A11', c1: '#AB1C72', c2: '#125E64' },
    { id: 't-snow', item: 'theme-snow', name: 'Snowy court', light: '#EFF5F2', dark: '#0A1210', c1: '#2D6A4F', c2: '#8E2F3A' }
  ];
  const SHOP_BY_ITEM = Object.fromEntries(SHOP_THEMES.map(t => [t.item, t]));
  const PALETTE_BY_ID = Object.fromEntries(PALETTES.map(p => [p.id, p]));
  const paletteInfo = id => PALETTE_BY_ID[id] || PALETTE_BY_ID.green;
  const normalize = d => {
    const o = d && typeof d === 'object' ? d : {};
    const palette = PALETTE_BY_ID[o.palette] ? o.palette : 'green';
    return { theme: THEMES[o.theme] || 'auto', palette, outdoor: o.outdoor ? 1 : 0, large: o.large ? 1 : 0 };
  };
  const resolve = (d, prefersDark, shopItem) => {
    const p = normalize(d), rt = SHOP_BY_ITEM[shopItem];
    const info = rt || PALETTE_BY_ID[p.palette];
    const dataTheme = p.theme === 'light' || p.theme === 'dark' ? p.theme : null;
    const dataPalette = rt ? rt.id : p.palette === 'green' ? null : p.palette;
    const effective = p.outdoor ? 'light' : (dataTheme || (prefersDark ? 'dark' : 'light'));
    const colorScheme = p.outdoor ? 'light' : (dataTheme || 'light dark');
    const themeColor = p.outdoor ? '#000000' : (effective === 'dark' ? info.dark : info.light);
    return { dataTheme, dataPalette, palette: rt ? rt.id : p.palette, effective, colorScheme, themeColor, outdoor: !!p.outdoor, large: !!p.large };
  };
  return { PALETTES, SHOP_THEMES, SHOP_BY_ITEM, paletteInfo, normalize, resolve };
})();
/*DISPLAY-END*/
/*CELEBRATION-START*/
const Celebration = (() => {
  // Team 0 = Court Blue, Team 1 = Court Green (DESIGN.md Team Color Rule).
  const PALETTES = [
    ['var(--blue)', '#4361FF', '#9DB0FF', '#FFFFFF'],
    ['var(--green)', '#17B988', '#3DD69E', '#FFFFFF']
  ];
  const normalize = d => {
    const o = d && typeof d === 'object' ? d : {};
    return { on: o.on ? 1 : 0, muted: o.muted ? 1 : 0 };
  };
  const justFinished = (beforeWinner, winner) => beforeWinner === null && (winner === 0 || winner === 1);
  const shouldConfetti = ({ on, beforeWinner, winner, reducedMotion }) => !!on && justFinished(beforeWinner, winner) && !reducedMotion;
  const shouldSound = ({ on, beforeWinner, winner, muted }) => !!on && justFinished(beforeWinner, winner) && !muted;
  // A worn rewarded celebration replaces the default burst: needs the same opt-in (Win celebration on) and a game that just ended; reduced motion shows it still.
  const shouldShopFx = ({ on, beforeWinner, winner }) => !!on && justFinished(beforeWinner, winner);
  const palette = winner => PALETTES[winner === 1 ? 1 : 0];
  return { normalize, justFinished, shouldConfetti, shouldSound, shouldShopFx, palette };
})();
/*CELEBRATION-END*/
