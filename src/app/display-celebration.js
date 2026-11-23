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
  const PALETTE_BY_ID = Object.fromEntries(PALETTES.map(p => [p.id, p]));
  const paletteInfo = id => PALETTE_BY_ID[id] || PALETTE_BY_ID.green;
  const normalize = d => {
    const o = d && typeof d === 'object' ? d : {};
    const palette = PALETTE_BY_ID[o.palette] ? o.palette : 'green';
    return { theme: THEMES[o.theme] || 'auto', palette, outdoor: o.outdoor ? 1 : 0, large: o.large ? 1 : 0 };
  };
  const resolve = (d, prefersDark) => {
    const p = normalize(d);
    const info = PALETTE_BY_ID[p.palette];
    const dataTheme = p.theme === 'light' || p.theme === 'dark' ? p.theme : null;
    const dataPalette = p.palette === 'green' ? null : p.palette;
    const effective = p.outdoor ? 'light' : (dataTheme || (prefersDark ? 'dark' : 'light'));
    const colorScheme = p.outdoor ? 'light' : (dataTheme || 'light dark');
    const themeColor = p.outdoor ? '#000000' : (effective === 'dark' ? info.dark : info.light);
    return { dataTheme, dataPalette, palette: p.palette, effective, colorScheme, themeColor, outdoor: !!p.outdoor, large: !!p.large };
  };
  return { PALETTES, paletteInfo, normalize, resolve };
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
  const palette = winner => PALETTES[winner === 1 ? 1 : 0];
  return { normalize, justFinished, shouldConfetti, shouldSound, palette };
})();
/*CELEBRATION-END*/
