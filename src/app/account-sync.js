/* ---------- account sync (Claude artifact only; private to each signed-in viewer) ---------- */
(async () => {
  try {
    if (!window.claude || !window.claude.use) return;
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !user) return;
    const uid = await user.id();
    if (!uid) return;
    profileDoc = db.doc('data/users/' + uid + '/profile');
    gamesCol = profileDoc.collection('games');
    let rosterSynced = false;
    profileDoc.onSnapshot(snap => {
      const remote = snap.exists && Array.isArray((snap.data() || {}).roster) ? snap.data().roster : [];
      const before = roster.length;
      for (const n of remote) if (typeof n === 'string' && !roster.some(r => sameName(r, n))) roster.push(n);
      store.set('pb.roster', roster);
      if (!snap.metadata.fromCache && !rosterSynced) { rosterSynced = true; if (roster.length !== remote.length) persistRoster(); }
      if (roster.length !== before && !(live && live.open) && !logForm) render();
    }, () => {});
    let first = true;
    const timer = setTimeout(() => { syncNote = 'Sync unavailable'; render(); }, 10000);
    gamesCol.orderBy('endedAt', 'desc').limit(500).onSnapshot(snap => {
      cloudGames = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (!snap.metadata.fromCache) {
        clearTimeout(timer); syncOn = true; syncNote = 'Synced';
        if (first) { first = false; uploadLocalOnly(); }
      }
      if (!logForm) render();
    }, () => { clearTimeout(timer); gamesCol = null; syncOn = false; syncNote = 'On this device'; render(); });
  } catch {}
})();
async function uploadLocalOnly() {
  const have = new Set((cloudGames || []).map(g => g.id));
  for (const g of localGames) {
    if (have.has(g.id)) continue;
    try { const { id, ...rest } = g; await gamesCol.doc(id).set(rest); } catch { break; }
  }
}
async function saveGame(rec) {
  if (pickup) { pickupSave(rec); return; } // while this phone is in a pickup session, results go to the session only (never a club or the saved players)
  if (club) { queueOp({ type: 'game', game: Object.assign({}, rec, senderGuess(rec)) }); addToRoster([...rec.teams[0], ...rec.teams[1]]); return; }
  localGames = [rec, ...localGames.filter(g => g.id !== rec.id)].slice(0, 1000);
  store.set('pb.games', localGames);
  addToRoster([...rec.teams[0], ...rec.teams[1]]);
  if (gamesCol) { try { const { id, ...rest } = rec; await gamesCol.doc(id).set(rest); } catch {} }
}
async function deleteGame(id) {
  if (club) { withPin({ type: 'delete', id }); return; }
  localGames = localGames.filter(g => g.id !== id);
  store.set('pb.games', localGames);
  if (cloudGames) cloudGames = cloudGames.filter(g => g.id !== id);
  render();
  if (gamesCol) { try { await gamesCol.doc(id).delete(); } catch {} }
}
const newId = t => 'g' + t.toString(36) + Math.random().toString(36).slice(2, 6);

