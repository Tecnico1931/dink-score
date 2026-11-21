/* ---------- moving from the old GitHub Pages address ---------- */
// The old site redirects here, carrying this device's games in the link so they aren't left behind.
if (/github\.io$/.test(location.hostname)) {
  let hash = '';
  try {
    const games = JSON.parse(localStorage.getItem('pb.games') || '[]');
    const savedPlayers = JSON.parse(localStorage.getItem('pb.roster') || '[]');
    if (!localStorage.getItem('pb.movedToNewSite') && (games.length || savedPlayers.length)) {
      const json = JSON.stringify({ v: 1, games, roster: savedPlayers, setup: JSON.parse(localStorage.getItem('pb.setup') || 'null'), tutorialSeen: !!localStorage.getItem('pb.tutorialSeen') });
      hash = '#import=' + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem('pb.movedToNewSite', '1');
    }
  } catch {}
  location.replace(SITE_URL + '/' + location.search + hash);
  throw new Error('Dink Score has moved to ' + SITE_URL);
}
// Imported data arrives in a link, so treat it as untrusted: rebuild every record from checked values only.
const cleanPlayer = n => typeof n === 'string' ? n.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
function cleanImportedGame(g) {
  if (!g || typeof g !== 'object' || !/^[A-Za-z0-9_-]{4,40}$/.test(String(g.id))) return null;
  const mode = g.mode === 'singles' ? 'singles' : 'doubles';
  const n = mode === 'doubles' ? 2 : 1;
  if (!Array.isArray(g.teams) || g.teams.length !== 2) return null;
  const teams = g.teams.map(t => Array.isArray(t) && t.length === n ? t.map(cleanPlayer) : null);
  if (teams.some(t => !t || t.some(x => !x))) return null;
  const score = Array.isArray(g.score) ? g.score.slice(0, 2).map(v => Math.trunc(Number(v))) : [];
  if (score.length !== 2 || score.some(v => !Number.isFinite(v) || v < 0 || v > 99) || score[0] === score[1]) return null;
  const endedAt = Math.trunc(Number(g.endedAt));
  if (!Number.isFinite(endedAt) || endedAt <= 0) return null;
  const startedAt = Math.trunc(Number(g.startedAt));
  return {
    id: String(g.id), mode, teams, score, winner: score[0] > score[1] ? 0 : 1,
    scoring: g.scoring === 'rally' ? 'rally' : 'sideout',
    target: [11, 15, 21].includes(Number(g.target)) ? Number(g.target) : 11,
    winBy: Number(g.winBy) === 1 ? 1 : 2,
    rallies: Math.max(0, Math.min(999, Math.trunc(Number(g.rallies)) || 0)),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.min(startedAt, endedAt) : endedAt, endedAt,
    logged: !!g.logged
  };
}
let importedCount = 0;
if (location.hash.startsWith('#import=')) {
  try {
    const b64 = location.hash.slice(8).replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
    const have = store.get('pb.games', []);
    const ids = new Set(have.map(g => g.id));
    const incoming = (Array.isArray(data.games) ? data.games : []).slice(0, 2000).map(cleanImportedGame).filter(g => g && !ids.has(g.id));
    importedCount = incoming.length;
    store.set('pb.games', [...incoming, ...have].sort((a, b) => b.endedAt - a.endedAt));
    const names = store.get('pb.roster', []);
    for (const raw of (Array.isArray(data.roster) ? data.roster.slice(0, 300) : [])) {
      const n = cleanPlayer(raw);
      if (n && !names.some(r => r.toLowerCase() === n.toLowerCase())) names.push(n);
    }
    store.set('pb.roster', names);
    if (data.tutorialSeen === true) store.set('pb.tutorialSeen', true);
  } catch {}
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}

