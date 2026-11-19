/* ---------- avatars: initials, an emoji, a pickleball icon, or a photo ---------- */
const AVATAR_ICONS = {
  paddle: '<path d="M8.6 3.6a5.4 5.4 0 017.6 7.6l-3.4 3.4a5.4 5.4 0 01-7.6-7.6z" fill="currentColor" fill-opacity=".22"/><path d="M8.6 3.6a5.4 5.4 0 017.6 7.6l-3.4 3.4a5.4 5.4 0 01-7.6-7.6z"/><path d="M11.4 16.2l-1.6 1.6M9.6 18l-3.3 3.3" stroke-width="2.6" stroke-linecap="round"/><circle cx="19" cy="18.5" r="2.3" fill="currentColor" stroke="none"/>',
  ball: '<circle cx="12" cy="12" r="8.6" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="12" r="8.6"/><g fill="currentColor" stroke="none"><circle cx="9" cy="8.6" r="1.1"/><circle cx="14.6" cy="8.2" r="1.1"/><circle cx="12" cy="12.4" r="1.1"/><circle cx="8.2" cy="14.6" r="1.1"/><circle cx="15.6" cy="14" r="1.1"/><circle cx="12.4" cy="17" r="1.1"/></g>',
  paddles: '<path d="M4.2 6.6a3.6 3.6 0 015.1-5.1l2.3 2.3a3.6 3.6 0 01-5.1 5.1zM19.8 6.6a3.6 3.6 0 00-5.1-5.1l-2.3 2.3a3.6 3.6 0 005.1 5.1z" fill="currentColor" fill-opacity=".22"/><path d="M4.2 6.6a3.6 3.6 0 015.1-5.1l2.3 2.3a3.6 3.6 0 01-5.1 5.1zM19.8 6.6a3.6 3.6 0 00-5.1-5.1l-2.3 2.3a3.6 3.6 0 005.1 5.1z"/><path d="M9.5 11l9.7 9.7M14.5 11l-9.7 9.7" stroke-width="2.4" stroke-linecap="round"/>',
  net: '<path d="M3 7v13M21 7v13" stroke-width="2.2" stroke-linecap="round"/><path d="M3 8h18v7H3z" fill="currentColor" fill-opacity=".14"/><path d="M3 8h18M3 15h18M7.5 8v7M12 8v7M16.5 8v7M3 11.5h18" stroke-width="1.2"/><path d="M3 8h18" stroke-width="2.4"/>',
  court: '<rect x="5" y="2.5" width="14" height="19" rx="1.5" fill="currentColor" fill-opacity=".16"/><rect x="5" y="2.5" width="14" height="19" rx="1.5"/><path d="M5 12h14" stroke-width="2.4"/><path d="M5 9h14M5 15h14M12 2.5V9M12 15v6.5"/>',
  trophy: '<path d="M7 3.5h10v5.5a5 5 0 01-10 0z" fill="currentColor" fill-opacity=".22"/><path d="M7 3.5h10v5.5a5 5 0 01-10 0zM7 5.5H4.2a3 3 0 003 4.4M17 5.5h2.8a3 3 0 01-3 4.4M12 14v3.5M8.5 21h7M9.5 17.5h5V21h-5z"/>',
  pickle: '<path d="M7.2 18.8c-3-3-1.9-9.4 2.4-13.6 2.6-2.6 6.4-3.4 8.2-1.6s1 5.6-1.6 8.2c-4.2 4.3-6 9.9-9 7z" fill="currentColor" fill-opacity=".22"/><path d="M7.2 18.8c-3-3-1.9-9.4 2.4-13.6 2.6-2.6 6.4-3.4 8.2-1.6s1 5.6-1.6 8.2c-4.2 4.3-6 9.9-9 7z"/><g fill="currentColor" stroke="none"><circle cx="11" cy="8.6" r=".9"/><circle cx="14.6" cy="6.8" r=".9"/><circle cx="9.4" cy="12.6" r=".9"/><circle cx="12.6" cy="11.4" r=".9"/><circle cx="9.2" cy="16.4" r=".9"/></g>',
  lightning: '<path d="M13.5 2.5L5 13.5h6l-1.5 8 8.5-11h-6z" fill="currentColor" fill-opacity=".25" stroke-linejoin="round"/>',
  flame: '<path d="M12 21.5c-4 0-6.8-2.8-6.8-6.6 0-3.4 2.4-5.6 3.6-8.6.4 1.8 1.4 2.8 2.4 3.3.2-3 1.7-5.6 4.1-7.1-.3 2.6.9 4.4 2.3 6.2 1.1 1.5 1.9 3.3 1.9 5.5 0 4.2-3.3 7.3-7.5 7.3z" fill="currentColor" fill-opacity=".22" stroke-linejoin="round"/><path d="M12 21.5c-2 0-3.3-1.4-3.3-3.2 0-1.9 1.6-2.8 2.2-4.7 1.6 1 3.9 2.6 3.9 4.8 0 1.8-1.2 3.1-2.8 3.1z" fill="currentColor" stroke="none" fill-opacity=".7"/>',
  target: '<circle cx="12" cy="12" r="9" fill="currentColor" fill-opacity=".14"/><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>'
};
const AVATAR_ICON_NAMES = { paddle: 'Paddle', ball: 'Ball', paddles: 'Crossed paddles', net: 'Net', court: 'Court', trophy: 'Trophy', pickle: 'Pickle', lightning: 'Banger', flame: 'On fire', target: 'Target' };
const iconSvg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${AVATAR_ICONS[k] || ''}</svg>`;
const AVATAR_EMOJI = ['🏓', '🥒', '🔥', '⚡', '🏆', '👑', '🎯', '💪', '😎', '🤩', '🥳', '😤', '🦖', '🦈', '🐯', '🦊', '🐼', '🦄', '🐸', '🦅', '🌶️', '🍕', '🌮', '🍀', '⭐', '🌈', '🚀', '💎', '🎸', '🧠'];
function avatarOf(name) {
  if (!club) return null;
  const p = clubPlayers().find(x => sameName(x.name, name));
  return (p && p.avatar) || null;
}
// What goes inside an avatar circle. Photos only come back from the server as JPEG or WebP data URLs.
function avatarInner(name, override) {
  const a = override !== undefined ? override : avatarOf(name);
  if (a && a.type === 'photo' && /^data:image\/(jpeg|webp);base64,/.test(a.value)) return `<img class="av-img" src="${esc(a.value)}" alt="">`;
  if (a && a.type === 'emoji') return `<span class="av-emoji">${esc(a.value)}</span>`;
  if (a && a.type === 'icon' && AVATAR_ICONS[a.value]) return `<span class="av-icon">${iconSvg(a.value)}</span>`;
  return esc(initials(name || '?'));
}
// Shrink a photo on the phone to a 160px square JPEG before it's sent.
function photoToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Pick a photo.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), S = 160;
      const c = document.createElement('canvas'); c.width = c.height = S;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      let q = 0.82, out = c.toDataURL('image/jpeg', q);
      while (out.length > 55000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be opened. Try a different one.")); };
    img.src = url;
  });
}
function avatarSheetHTML(c) {
  const name = myName();
  const tabs = [['emoji', 'Emoji'], ['icon', 'Icons'], ['photo', 'Photo'], ['initials', 'Initials']];
  const cur = c.pending !== undefined ? c.pending : avatarOf(name);
  const sel = (type, value) => cur && cur.type === type && cur.value === value;
  let body = '';
  if (c.atab === 'emoji') body = `<div class="av-grid">${AVATAR_EMOJI.map(e => `<button type="button" class="av-pick ${sel('emoji', e) ? 'on' : ''}" data-av-emoji="${esc(e)}" aria-label="${esc(e)}"><span class="av-emoji">${esc(e)}</span></button>`).join('')}</div>
    <form class="club-form" data-form="av-emoji"><label class="lab" for="av-emoji-in">Or type any emoji</label><div class="add-player"><input id="av-emoji-in" maxlength="16" autocomplete="off" placeholder="Tap the emoji key"><button type="submit" class="btn btn-soft" style="padding:10px 16px;border-radius:12px">Use</button></div></form>`;
  if (c.atab === 'icon') body = `<div class="av-grid icons">${Object.keys(AVATAR_ICONS).map(k => `<button type="button" class="av-pick ${sel('icon', k) ? 'on' : ''}" data-av-icon="${k}"><span class="av-icon">${iconSvg(k)}</span><small>${AVATAR_ICON_NAMES[k]}</small></button>`).join('')}</div>`;
  if (c.atab === 'photo') body = `<label class="photo-drop" for="av-file"><span>${cur && cur.type === 'photo' ? 'Choose a different photo' : 'Choose a photo'}</span><small>It's cropped to a square and shrunk before it's saved. Everyone in ${esc(club.name)} can see it.</small></label><input id="av-file" type="file" accept="image/*" hidden>`;
  if (c.atab === 'initials') body = `<p class="note">Use the letters of your name, like everyone starts with.</p><button type="button" class="btn btn-soft" data-av-initials="1">Use my initials</button>`;
  return `<h2 id="club-h">Your picture</h2>
    <div class="av-preview"><span class="av">${avatarInner(name, cur || null)}</span><span>${esc(name)}</span></div>
    ${seg('data-av-tab', tabs, c.atab, 'sm')}
    ${body}
    ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}
    <div class="btns"><button class="btn btn-ink" data-act="av-save" ${c.busy || c.pending === undefined ? 'disabled' : ''}>Save picture</button><button class="btn btn-soft" data-act="club-close">Cancel</button></div>`;
}
async function saveAvatar() {
  const c = clubSheet;
  c.busy = true; c.error = ''; renderClub();
  try {
    await playerCall({ action: 'avatar', name: myName(), playerToken: myToken(), avatar: c.pending || { type: 'initials' } });
    clubSheet = null; showToast('Picture saved', false);
    await refreshClub(); render(); renderProfile();
  } catch (err) { c.busy = false; c.error = err.message; renderClub(); }
}

// Organizer: releasing linked names and removing pictures.
function adminCreds() { return { pin: pins[club.code] || '', ownerToken: owners[club.code] || '' }; }
function gamesHTML(c) {
  const mine = live && !live.event ? (live.id || liveGameId()) : null;
  const line = (teams, score, winner, serving, t) => `<div class="line ${winner === t ? 'win' : ''}" style="--c:${TEAM_COLOR[t]}"><span class="tick"></span><span class="who">${esc(teamLabel(teams[t]))}</span>${serving === t ? '<span class="tag">serving</span>' : ''}<span class="pts">${Number(score[t])}</span></div>`;
  let rows;
  if (!c.games) rows = '<p class="note">Loading\u2026</p>';
  else if (!c.games.length) rows = '<p>No games are being scored right now. Start one from the Play tab and it shows up here, on every phone in the club.</p>';
  else rows = c.games.map(g => {
    const ago = Math.max(0, Math.round((Date.now() - (g.updatedAt || Date.now())) / 1000));
    const when = g.winner !== null && g.winner !== undefined ? 'final' : ago < 8 ? 'live now' : ago < 90 ? ago + 's ago' : Math.round(ago / 60) + ' min ago';
    const btn = g.id === mine ? '<button class="btn btn-soft block" data-act="club-game-mine" style="margin-top:8px">This phone is scoring it \u2014 open</button>'
      : (g.winner !== null && g.winner !== undefined) ? ''
      : `<button class="btn btn-soft block" data-act="club-game-open" data-game="${esc(g.id)}" style="margin-top:8px">Score this game</button>`;
    const join = c.joinId === g.id ? `<form class="club-form" data-form="game-join" style="margin-top:10px"><label class="lab" for="game-secret">Game secret \u2014 shown on the scoring phone, on its club page under "Score from your Apple Watch"</label><input id="game-secret" class="field-input" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="the game's secret"><button type="submit" class="btn btn-ink">Open and score</button></form>` : '';
    return `<div class="game" style="list-style:none"><div class="lines">${line(g.teams, g.score, g.winner, g.serving, 0)}${line(g.teams, g.score, g.winner, g.serving, 1)}</div><div class="meta"><span>${esc(when)}</span><span class="tag">${g.mode === 'doubles' ? 'Doubles' : 'Singles'}</span><span class="tag">${g.scoring === 'rally' ? 'Rally' : 'Side-out'} to ${Number(g.target)}</span></div>${btn}${join}</div>`;
  }).join('');
  const fin = clubGames().slice().sort((x, y) => (y.endedAt || 0) - (x.endedAt || 0)).slice(0, 5);
  const finRows = fin.length ? '<h3 style="margin:18px 0 6px">Just finished</h3>' + fin.map(g => `<div class="game" style="list-style:none"><div class="lines">${line(g.teams, g.score, g.winner, null, 0)}${line(g.teams, g.score, g.winner, null, 1)}</div></div>`).join('') : '';
  return `<h2 id="club-h">Games going on</h2>
  <p>Every live game in ${esc(club.name)}, with players and the score as it stands. Anyone in the club can watch; scoring a game needs its secret, so a tap on one court never lands on another.</p>
  ${c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : ''}${rows}${finRows}
  <div class="btns"><button class="btn btn-soft" data-act="club-back">Back</button><button class="btn btn-soft" data-act="club-close">Done</button></div>`;
}
async function refreshClubGames() {
  if (!club || !clubSheet || clubSheet.view !== 'games') return;
  try { const d = await api('live?code=' + club.code); if (clubSheet && clubSheet.view === 'games') { clubSheet.games = d.games || []; renderClub(); } } catch {}
}
setInterval(() => { if (clubSheet && clubSheet.view === 'games' && club && !document.hidden) refreshClubGames(); }, 4000);
