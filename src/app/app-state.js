/* ---------- state ---------- */
const defaults = { mode: 'doubles', scoring: 'sideout', target: 11, winBy: 2, first: 0, names: [['', ''], ['', '']] };
let setup = Heal.setup(store.get('pb.setup', {}), defaults);
let setupOptsOpen = false;
let newGameOpen = false, addingPlayer = false; // the New game bottom sheet, and its "+ Add" player input
let tab = store.get('pb.tab', 'play');
if (!['play', 'leaders', 'events', 'history', 'rules'].includes(tab)) tab = 'play';
let live = Heal.live(store.get('pb.live', null)); // { state, stack, open }; a damaged game in progress is dropped, not allowed to blank the app
if (live) Scoring.restore(live);
let localGames = (() => { const r = Heal.games(store.get('pb.games', [])); if (r.bad.length) { Heal.quarantine('pb.games', r.bad); store.set('pb.games', r.ok); } return r.ok; })();
let cloudGames = null;
let gamesCol = null;
let syncOn = false;
let syncNote = 'On this device';
let armedDelete = null;
let bumpTeam = null;
let ratingMode = store.get('pb.rmode', 'doubles') === 'singles' ? 'singles' : 'doubles';
let logForm = null; // the "log a result" sheet when open
let shareSheet = null; // the "share result" sheet when open: { data, theme, url, file, token }

const r2 = n => n.toFixed(2);
const isDefaultName = n => /^Player \d+$/.test(n);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const initials = n => n.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
function deltaHTML(d) {
  const v = Math.round(d * 100) / 100;
  if (v === 0) return `<span class="delta flat">±0.00</span>`;
  return `<span class="delta ${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲ ' : '▼ '}${Math.abs(v).toFixed(2)}</span>`;
}
function deltaBtnHTML(name, d, mode, scope = 'all') {
  const v = Math.round(d * 100) / 100;
  const cls = v === 0 ? 'flat' : v > 0 ? 'up' : 'down';
  const txt = v === 0 ? '±0.00' : `${v > 0 ? '▲ ' : '▼ '}${Math.abs(v).toFixed(2)}`;
  const dir = v === 0 ? 'unchanged' : `${v > 0 ? 'up' : 'down'} ${Math.abs(v).toFixed(2)}`;
  return `<button type="button" class="delta-btn" data-explain-player="${esc(name)}" data-explain-mode="${mode}" data-explain-scope="${scope}" aria-label="Rating ${dir} for ${esc(name)}. Explain rating change"><span class="delta-pill delta ${cls}">${txt}</span></button>`;
}
function namesFor(names, mode, t) {
  const n = mode === 'doubles' ? 2 : 1;
  return Array.from({ length: n }, (_, i) => (names[t][i] || '').trim() || `Player ${t * 2 + i + 1}`);
}
const teamPlayers = t => namesFor(setup.names, setup.mode, t);
const teamLabel = players => players.join(' & ');
function allGames() {
  if (club) return clubGames();
  const map = new Map();
  for (const g of localGames) map.set(g.id, g);
  if (cloudGames) for (const g of cloudGames) map.set(g.id, g);
  return [...map.values()].sort((a, b) => b.endedAt - a.endedAt);
}
// Games that count toward ratings, the leaderboard and profiles: with the club's "confirmed games only" setting on, unconfirmed ones are held out.
const ratedGames = () => allGames().filter(g => !g.hold);
const minutes = g => Math.max(1, Math.round((g.endedAt - g.startedAt) / 60000));

