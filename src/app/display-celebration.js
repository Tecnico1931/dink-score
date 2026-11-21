/*DISPLAY-START*/
const DisplayPrefs = (() => {
  const THEMES = { auto: 'auto', light: 'light', dark: 'dark' };
  const normalize = d => {
    const o = d && typeof d === 'object' ? d : {};
    return { theme: THEMES[o.theme] || 'auto', outdoor: o.outdoor ? 1 : 0, large: o.large ? 1 : 0 };
  };
  const resolve = (d, prefersDark) => {
    const p = normalize(d);
    const dataTheme = p.theme === 'light' || p.theme === 'dark' ? p.theme : null;
    const effective = p.outdoor ? 'light' : (dataTheme || (prefersDark ? 'dark' : 'light'));
    const colorScheme = p.outdoor ? 'light' : (dataTheme || 'light dark');
    const themeColor = p.outdoor ? '#000000' : (effective === 'dark' ? '#0A0F17' : '#F2F4F7');
    return { dataTheme, effective, colorScheme, themeColor, outdoor: !!p.outdoor, large: !!p.large };
  };
  return { normalize, resolve };
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
