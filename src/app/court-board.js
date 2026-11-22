/* ---------- open play court board ---------- */
// Courts, a waiting queue and who plays next, kept on the server (api/_courtboard.js) so every phone and the club display show the
// same board. The server decides who may do what; this only hides buttons that would be refused.
const isOrg = () => !!club && !!(pins[club.code] || owners[club.code]);
const cbNames = t => (t || []).map(esc).join(' &amp; ');
const boardCreds = () => Object.assign({ playerName: myName() || '', playerToken: myToken() || '' }, adminCreds());
const boardHere = b => !!myName() && b.present.some(p => sameName(p, myName()));
const boardRunner = b => isOrg() || (b.config.control === 'players' && boardHere(b));
function boardHTML(c) {
  const b = c.board, org = isOrg();
  const head = `<h2 id="club-h">Court board</h2>`;
  const foot = `<div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '';
  if (b === undefined) return `${head}${skel(3)}${err}${foot}`;
  if (!b) return `${head}<p>Open play with a queue: players check in, get called to a free court, and the next group is suggested when a game ends, spread so people meet new partners and opponents. It also shows on the club's TV page.</p>${err}
    ${org ? '<button class="btn btn-ink block" data-act="board-on">Turn on the court board</button>' : '<p class="note">An organizer can turn the court board on from this screen.</p>'}${foot}`;
  const runner = boardRunner(b), here = boardHere(b), hasName = !!myName();
  const who = hasName ? (here
    ? `<div class="me-row"><span>You are checked in as <b>${esc(myName())}</b></span><button class="link" data-act="board-out">Leave the board</button></div>`
    : `<div class="me-row"><span>Playing as <b>${esc(myName())}</b></span><button class="btn btn-blue" data-act="board-in">I'm here</button></div>`)
    : `<p class="note">Choose your name in the club to check yourself in${org ? ', or add players below' : ''}.</p>`;
  const courts = b.courts.map(ct => {
    const sug = (b.suggestions || []).find(s => s.court === ct.court);
    let inner;
    if (ct.teams) {
      const lv = ct.live, over = lv && lv.winner !== null;
      const teamRow = i => `<div class="cb-team${lv && lv.winner === i ? ' win' : ''}"><span>${cbNames(ct.teams[i])}</span>${lv ? `<b class="n">${Number(lv.score[i])}</b>` : ''}</div>`;
      inner = `${teamRow(0)}<div class="cb-vs">vs</div>${teamRow(1)}`;
      if (runner) inner += `<div class="cb-row-btns">${over
        ? `<button class="btn btn-ink" data-act="board-finish" data-court="${ct.court}">Game over: free the court</button>`
        : `<button class="btn btn-soft" data-act="board-finish" data-court="${ct.court}" data-winner="0">${esc(ct.teams[0][0])}'s team won</button><button class="btn btn-soft" data-act="board-finish" data-court="${ct.court}" data-winner="1">${esc(ct.teams[1][0])}'s team won</button>`}<button class="btn btn-soft" data-act="board-cancel" data-court="${ct.court}">Cancel game</button></div>`;
      if (!lv) inner += `<p class="note" style="margin:8px 0 0">Score it from the Play tab with these players and the score shows here.</p>`;
    } else {
      inner = `<p style="margin:0">${ct.hold ? `<b>Winners stay:</b> ${cbNames(ct.hold)} (${Number(ct.streak)} in a row)` : 'Free'}</p>`;
      if (sug) inner += `<p class="cb-next">Next: ${cbNames(sug.teams[0])} <span class="cb-vs">vs</span> ${cbNames(sug.teams[1])}</p>${runner ? `<button class="btn btn-blue" data-act="board-call" data-court="${ct.court}">Call them to court ${ct.court}</button>` : ''}`;
      else inner += `<p class="cb-next">Waiting for ${ct.hold ? 'challengers' : 'more players'}.</p>`;
    }
    return `<section class="cb-court"><h3>Court ${ct.court}</h3>${inner}</section>`;
  }).join('');
  const next = new Set(b.suggestions.flatMap(s => s.teams.flat()));
  const queue = b.queue.length ? `<ol class="cb-queue">${b.queue.map((p, i) => `<li><span><span class="pos">${i + 1}</span>${esc(p)}${youTag(p)}${next.has(p) ? ' <span class="badge on">Up next</span>' : ''}</span><span>${isMe(p) && b.queue.length > 1 ? `<button class="link" data-act="board-rest" data-name="${esc(p)}">Sit one out</button>` : ''}${org ? `<button class="link" data-act="board-remove" data-name="${esc(p)}">Remove</button>` : ''}</span></li>`).join('')}</ol>` : '<p class="note">Nobody is waiting.</p>';
  const sel = (id, label, opts, cur) => `<label class="lab" for="${id}">${label}</label><select id="${id}" class="field-input">${opts.map(o => `<option value="${esc(o[0])}"${String(o[0]) === String(cur) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  const admin = org ? `<h3 style="margin:18px 0 6px">Organizer</h3>
    <form class="club-form" data-form="board-add"><label class="lab" for="board-names">Check in players (names, separated by commas)</label><input id="board-names" class="field-input" autocomplete="off" placeholder="Ana, Ben, a guest"><button type="submit" class="btn btn-ink">Check them in</button></form>
    <form class="club-form" data-form="board-config" style="margin-top:12px">
      ${sel('board-courts', 'Courts', Array.from({ length: 12 }, (_, i) => [i + 1, String(i + 1)]), b.config.courts)}
      ${sel('board-format', 'Format', [['doubles', 'Doubles (4 per court)'], ['singles', 'Singles (2 per court)']], b.config.format)}
      ${sel('board-mode', 'When a game ends', [['rotate', 'Everyone goes to the back of the queue'], ['winners-stay', 'Winners stay on court']], b.config.mode)}
      ${sel('board-stay', 'Winners stay for at most', Array.from({ length: 9 }, (_, i) => [i + 1, (i + 1) + (i ? ' games in a row' : ' game')]), b.config.stayLimit)}
      ${sel('board-control', 'Who runs the courts', [['players', 'Any player checked in'], ['organizer', 'Organizers only']], b.config.control)}
      <label class="lab" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="board-enabled" ${b.config.enabled ? 'checked' : ''}> Show the board (including on the TV page)</label>
      <button type="submit" class="btn btn-soft">Save settings</button>
    </form>
    <button class="btn btn-soft block" style="margin-top:10px" data-act="board-reset">${c.confirmReset ? 'Tap again to clear everyone off the board' : 'End of session: clear the board'}</button>` : '';
  return `${head}<p class="note">${b.config.format === 'singles' ? 'Singles' : 'Doubles'}, ${b.config.mode === 'winners-stay' ? `winners stay up to ${b.config.stayLimit} in a row` : 'everyone rotates'}. ${b.config.control === 'players' ? 'Any checked-in player can run the courts.' : 'Organizers run the courts.'} Finished games are saved from the Play tab as usual; the board only organizes who plays next.</p>
    ${err}${who}<div class="cb-courts">${courts}</div>
    <h3 style="margin:18px 0 6px">Waiting (${b.queue.length})</h3>${queue}${admin}${foot}`;
}
async function boardDo(action, extra) {
  const c = clubSheet;
  if (!c || c.view !== 'board' || !club) return;
  try {
    const d = await api('live', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action }, boardCreds(), extra || {})) });
    c.board = d.board; c.error = ''; c.confirmReset = false;
  } catch (e) { c.error = (e && e.message) || 'Could not update the board.'; }
  if (clubSheet === c) renderClub();
}
function boardClick(ds) {
  const a = ds.act, court = ds.court ? +ds.court : undefined;
  if (a === 'board-on') return boardDo('board-config', { enabled: true });
  if (a === 'board-in') return boardDo('board-checkin', { name: myName() });
  if (a === 'board-out') return boardDo('board-checkout', { name: myName() });
  if (a === 'board-rest') return boardDo('board-rest', { name: myName(), target: ds.name });
  if (a === 'board-remove') return boardDo('board-checkout', { target: ds.name });
  if (a === 'board-call') return boardDo('board-call', { court });
  if (a === 'board-finish') return boardDo('board-finish', ds.winner === undefined ? { court } : { court, winner: +ds.winner });
  if (a === 'board-cancel') return boardDo('board-cancel', { court });
  if (a === 'board-reset') {
    if (!clubSheet.confirmReset) { clubSheet.confirmReset = true; renderClub(); return; }
    return boardDo('board-reset');
  }
}
async function refreshBoard() {
  const c = clubSheet;
  if (!club || !c || c.view !== 'board') return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.closest('#sheet3') && c.board !== undefined) return; // don't wipe what someone is typing
  try { const d = await api('live?code=' + club.code + '&board=1'); if (clubSheet === c) { c.board = d.board; renderClub(); } } catch (e) { if (clubSheet === c && c.board === undefined) { c.board = null; c.error = (e && e.message) || ''; renderClub(); } }
}
setInterval(() => { if (clubSheet && clubSheet.view === 'board' && club && !document.hidden) refreshBoard(); }, 4000);
