async function joinLiveGame(secret) {
  const c = clubSheet; if (!c || !c.joinId || !club) return;
  const sec = String(secret || '').trim();
  try {
    const d = await api('live?code=' + club.code + '&id=' + encodeURIComponent(c.joinId) + '&secret=' + encodeURIComponent(sec));
    if (!d.state) { c.error = 'That game is not live any more.'; renderClub(); refreshClubGames(); return; }
    live = { state: d.state, stack: [], open: true, secret: sec, shared: true, id: c.joinId, version: d.version || 0 };
    clubSheet = null; renderClub(); persistLive(); keepAwake(true); render();
  } catch (e) { c.error = (e && e.message) || 'Could not open that game.'; renderClub(); }
}
