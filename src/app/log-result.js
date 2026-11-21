/* ---------- log a result from another court ---------- */
function localDateTimeValue(t) {
  const d = new Date(t); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// With no club, games and logged results stay on this device (pb.games) until saved to a club.
// saveAfterJoin: game ids to upload once a club is joined ("Save to a club" after a game).
let saveAfterJoin = null;
function beginGame() {
  newGameOpen = false; addingPlayer = false;
  addToRoster([...teamPlayers(0), ...teamPlayers(1)]);
  startGame();
}
function openLog() {
  logForm = { mode: setup.mode, target: +setup.target, names: [['', ''], ['', '']], score: ['', ''], when: localDateTimeValue(Date.now()), error: '' };
  renderLog();
}
function renderLog() {
  const root = $('#sheet2');
  if (!logForm) { root.innerHTML = ''; if (!(live && live.open)) lockBody(false); return; }
  lockBody(true);
  const f = logForm;
  const n = f.mode === 'doubles' ? 2 : 1;
  const team = t => `<div class="log-team" style="--c:${TEAM_COLOR[t]}"><div class="names">
      ${Array.from({ length: n }, (_, i) => `<input type="text" id="log-${t}-${i}" data-log-name="${t}-${i}" list="roster-list-log" placeholder="${TEAM_NAME[t]} player ${i + 1}" value="${esc(f.names[t][i])}" autocomplete="off" aria-label="${TEAM_NAME[t]} team, player ${i + 1}">`).join('')}</div>
      <div class="stepper"><input type="number" inputmode="numeric" min="0" max="99" id="log-score-${t}" data-log-score="${t}" value="${esc(f.score[t])}" placeholder="0" aria-label="${TEAM_NAME[t]} team score">
        <div class="sb"><button type="button" data-step="${t}" data-d="-1" aria-label="Lower ${TEAM_NAME[t]} score">−</button><button type="button" data-step="${t}" data-d="1" aria-label="Raise ${TEAM_NAME[t]} score">+</button></div></div></div>`;
  root.innerHTML = `<div class="sheet-bg top" role="dialog" aria-modal="true" aria-labelledby="log-h"><form class="sheet" data-form="log" novalidate><span class="grip"></span>
    <div class="sheet-head"><h2 id="log-h">${f.editId ? 'Edit result' : 'Log a result'}</h2><span style="display:flex;gap:8px;align-items:center">${f.editId ? `<button type="button" class="btn btn-ball share-pill" data-share="${esc(f.editId)}">${ICON.share}Share</button>` : ''}<button type="button" class="x" data-act="log-close" aria-label="Close">✕</button></span></div>
    <p>${f.editId ? `Fix the score, players, format or date. Ratings are recalculated from the corrected game.${club && club.hasPin && !hasOrganizer() ? ' Saving needs the organizer PIN.' : ''}` : `Add a finished game from another court. It counts toward the record and Dink Ratings${live && live.open ? ', and your live game keeps its score' : ''}.`}</p>
    <div class="seg-row" style="margin:0"><div class="field" style="margin:0"><span class="lab">Format</span>${seg('data-log-mode', [['doubles', 'Doubles'], ['singles', 'Singles']], f.mode, 'sm')}</div>
      <div class="field" style="margin:0"><span class="lab">Played to</span>${seg('data-log-target', [[11, '11'], [15, '15'], [21, '21']], f.target, 'sm')}</div></div>
    <div class="log-teams">${team(0)}${team(1)}</div>
    ${rosterNames().length ? `<div class="field" style="margin:0"><span class="lab">${pickup ? 'Players in this session' : 'Saved players'}</span><div class="chips">${chipsHTML(f.names, f.mode, 'log')}</div></div>` : ''}
    <datalist id="roster-list-log">${rosterNames().map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
    <div class="field" style="margin:0"><label class="lab" for="log-when">Finished at</label><div class="when"><input type="datetime-local" id="log-when" data-log-when value="${esc(f.when)}"></div></div>
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <button type="submit" class="btn btn-blue block">${f.editId ? 'Save changes' : 'Save result'}</button></form></div>`;
}
// Opens the log form filled in with a saved game, so its score, players, format or date can be corrected.
function openEdit(id) {
  const g = allGames().find(x => x.id === id);
  if (!g) return;
  const names = g.teams.map(t => [t[0] || '', t[1] || '']);
  logForm = { editId: id, original: g, mode: g.mode === 'singles' ? 'singles' : 'doubles', target: [11, 15, 21].includes(+g.target) ? +g.target : 11,
    names, score: [String(g.score[0]), String(g.score[1])], when: localDateTimeValue(g.endedAt), error: '' };
  renderLog();
}
function submitLog() {
  const f = logForm;
  const n = f.mode === 'doubles' ? 2 : 1;
  const teams = [0, 1].map(t => Array.from({ length: n }, (_, i) => (f.names[t][i] || '').trim()));
  const score = f.score.map(v => parseInt(v, 10));
  const err = msg => { f.error = msg; renderLog(); };
  if (teams.flat().some(x => !x)) return err(`Add a name for all ${n * 2} players.`);
  const flat = teams.flat().map(x => x.toLowerCase());
  if (new Set(flat).size !== flat.length) return err('Each player can only appear once.');
  if (score.some(v => !Number.isFinite(v) || v < 0 || v > 99)) return err('Enter both scores, from 0 to 99.');
  if (score[0] === score[1]) return err("Scores can't be tied. Pickleball games need a winner.");
  const endedAt = f.when ? new Date(f.when).getTime() : Date.now();
  if (!Number.isFinite(endedAt)) return err('Pick when the game finished.');
  const winner = score[0] > score[1] ? 0 : 1;
  if (f.editId) {
    // Keep how long the game took: if the finish time moved, move the start with it.
    const o = f.original;
    const updated = Object.assign({}, o, { mode: f.mode, target: f.target, teams, score, winner, endedAt, startedAt: endedAt - Math.max(0, o.endedAt - o.startedAt), editedAt: Date.now() });
    // A rally log only describes the result it was scored to; a corrected score, format or target no longer matches it.
    if (o.score[0] !== score[0] || o.score[1] !== score[1] || o.mode !== f.mode || o.target !== f.target) { delete updated.rallyLog; delete updated.replay; }
    logForm = null;
    editGame(updated);
    return;
  }
  saveGame({ id: newId(endedAt), startedAt: endedAt, endedAt, mode: f.mode, scoring: 'sideout', target: f.target, winBy: 2, teams, score, winner, rallies: 0, logged: true });
  logForm = null;
  render();
  showToast(`Saved: ${teamLabel(teams[winner])} won ${score[winner]}–${score[1 - winner]}`, false);
}
// Saves a corrected game. Clubs go through the organizer PIN like deleting; games on this device just update.
function editGame(g) {
  if (club) { withPin({ type: 'edit', id: g.id, game: g }); return; }
  localGames = localGames.map(x => x.id === g.id ? g : x);
  store.set('pb.games', localGames);
  if (cloudGames) cloudGames = cloudGames.map(x => x.id === g.id ? g : x);
  if (gamesCol) { const { id, ...rest } = g; gamesCol.doc(id).set(rest).catch(() => {}); }
  render();
  showToast('Result updated', false);
}

