/* ---------- reactions on finished games (L12: api/_reactions.js via api/games.js) ---------- */
const GAME_REACTIONS = [
  { key: 'clap', emoji: '\u{1F44F}', label: 'Great game' },
  { key: 'fire', emoji: '\u{1F525}', label: 'On fire' },
  { key: 'pickle', emoji: '\u{1F952}', label: 'Nice dink' },
  { key: 'sweat', emoji: '\u{1F605}', label: 'Close one' },
  { key: 'trophy', emoji: '\u{1F3C6}', label: 'Clutch' }
];
let rxOpenGame = null;
const rxBusy = new Set();

function canReactGame(g) {
  return !!club && !!g && !outbox.some(o => o.type === 'game' && o.game && o.game.id === g.id);
}

function rxNamesLabel(names) {
  if (!names.length) return '';
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;
}

function reactionsHTML(g) {
  if (!canReactGame(g)) return '';
  const rx = g.reactions && typeof g.reactions === 'object' ? g.reactions : {};
  const meName = myName();
  const open = rxOpenGame === g.id;
  const shown = open
    ? GAME_REACTIONS
    : GAME_REACTIONS.filter(r => Array.isArray(rx[r.key]) && rx[r.key].length > 0);
  const chips = shown.map(r => {
    const who = Array.isArray(rx[r.key]) ? rx[r.key] : [];
    const mine = !!meName && who.some(n => sameName(n, meName));
    const count = who.length;
    const tip = count ? `${r.label}: ${rxNamesLabel(who)}` : r.label;
    const a11y = count
      ? `${r.label}, ${count} reaction${count === 1 ? '' : 's'} (${rxNamesLabel(who)})${mine ? '. You reacted' : ''}`
      : `${r.label}, add reaction`;
    return `<button type="button" class="rx-btn" data-react="${esc(g.id)}" data-rx="${esc(r.key)}" aria-pressed="${mine ? 'true' : 'false'}" aria-label="${esc(a11y)}" title="${esc(tip)}"><span class="rx-emoji" aria-hidden="true">${r.emoji}</span>${count ? `<span class="rx-n">${count}</span>` : ''}</button>`;
  }).join('');
  const hasAny = GAME_REACTIONS.some(r => Array.isArray(rx[r.key]) && rx[r.key].length > 0);
  const toggleText = open ? 'Done' : hasAny ? '+' : '+ React';
  const toggleLabel = open ? 'Close reactions' : 'Add reaction';
  return `<div class="g-reacts" role="group" aria-label="Game reactions">${chips}<button type="button" class="rx-btn rx-add" data-rx-open="${esc(g.id)}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${esc(toggleLabel)}">${toggleText}</button></div>`;
}

function toggleReactionPicker(gameId) {
  const opening = rxOpenGame !== gameId;
  rxOpenGame = opening ? gameId : null;
  render();
  announce(opening ? 'Reaction picker opened' : 'Reaction picker closed');
  const btn = document.querySelector(`[data-rx-open="${CSS.escape ? CSS.escape(gameId) : gameId}"]`);
  if (btn) btn.focus({ preventScroll: true });
}

async function toggleGameReaction(gameId, key) {
  if (!club) return;
  if (!myName() || !myToken()) {
    clubSheet = { view: 'whoami' };
    renderClub();
    showToast('Pick your name first to react to games', false);
    return;
  }
  const busyKey = gameId + ':' + key;
  if (rxBusy.has(busyKey)) return;
  rxBusy.add(busyKey);
  try {
    const data = await api('games', {
      method: 'POST',
      body: JSON.stringify({ code: club.code, react: gameId, reaction: key, playerName: myName(), playerToken: myToken() })
    });
    if (clubData && Array.isArray(clubData.games)) {
      const target = clubData.games.find(x => x.id === gameId);
      if (target) {
        if (data.reactions && Object.keys(data.reactions).length) target.reactions = data.reactions;
        else delete target.reactions;
        store.set('pb.clubCache', clubData);
      }
    }
    const meta = GAME_REACTIONS.find(r => r.key === key);
    const label = meta ? meta.label : key;
    render();
    announce(data.added ? `Added ${label} reaction` : `Removed ${label} reaction`);
    const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(gameId) : gameId;
    const escKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key;
    const nextBtn = document.querySelector(`[data-react="${escId}"][data-rx="${escKey}"]`) || document.querySelector(`[data-rx-open="${escId}"]`);
    if (nextBtn) nextBtn.focus({ preventScroll: true });
  } catch (err) {
    showToast(err.message, false);
  } finally {
    rxBusy.delete(busyKey);
  }
}
