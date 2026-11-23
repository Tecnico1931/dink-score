const rightsClubExport = fmt => rightsRun(async () => {
  const res = await fetch('/api/club', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify(Object.assign({ code: club.code, action: 'export', format: fmt }, adminCreds())) }).catch(() => { throw new Error("Can't reach the server. Check your connection."); });
  if (!res.ok) { let m = {}; try { m = await res.json(); } catch {} throw new Error(m.error || 'Something went wrong. Try again.'); }
  saveFile(fmt === 'csv' ? await res.text() : JSON.stringify(await res.json(), null, 2), `dink-score-${slug(club.name)}.${fmt === 'csv' ? 'csv' : 'json'}`, fmt === 'csv' ? 'text/csv' : 'application/json');
  return fmt === 'csv' ? 'The games were downloaded as a spreadsheet file.' : 'The whole club was downloaded.';
});
const rightsClubDelete = typed => rightsRun(async () => {
  const d = await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'delete-club', confirm: typed }, adminCreds())) });
  club.deleteAt = d.deleteAt; saveClubs();
  return 'Deletion is scheduled. An organizer can undo it until the deletion time shown here.';
});
const rightsClubUndo = () => rightsRun(async () => {
  await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'cancel-delete-club' }, adminCreds())) });
  delete club.deleteAt; saveClubs();
  return 'Deletion cancelled. The club stays.';
});
// Moving to a new phone (see the MOVE block and api/transfer.js).
async function moveOut() {
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const code = Move.newCode();
    const blob = await Move.seal(code, Move.pack(clubs, me, owners, pins));
    await api('transfer', { method: 'POST', body: JSON.stringify({ action: 'create', id: await Move.id(code), blob }) });
    let qr = ''; try { qr = ShareLink.qrSvg(qrcode, location.origin + '/#move=' + code); } catch {}
    clubSheet = { view: 'move-out', code, qr };
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  renderClub();
}
function adoptMoved() {
  store.set('pb.clubs', clubs); store.set('pb.me', me); store.set('pb.owners', owners); store.set('pb.pins', pins);
}
async function moveIn(raw) {
  const code = Move.clean(raw);
  if (!code) { clubSheet.error = 'Transfer codes are 12 letters and numbers.'; renderClub(); return; }
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const data = await api('transfer', { method: 'POST', body: JSON.stringify({ action: 'claim', id: await Move.id(code) }) });
    let payload; try { payload = await Move.open(code, data.blob); } catch { throw new Error('That code did not unlock the transfer.'); }
    const added = Move.merge(payload, clubs, me, owners, pins);
    adoptMoved();
    const first = club || clubs[0];
    if (first) await joinClub(first.code, first.name);
    clubSheet = { view: 'club', msg: `Moved ${added} club${added === 1 ? '' : 's'} to this phone. Organizer access and player claims came with them.` };
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  afterJoin();
}
async function recoveryMake() {
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const data = await api('transfer', { method: 'POST', body: JSON.stringify({ action: 'recovery-create', code: club.code, ownerToken: owners[club.code] || '' }) });
    clubSheet = { view: 'recovery', recovery: data.recovery, recoveryExpires: data.expires };
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  renderClub();
}
async function recoverClub(clubCode, raw) {
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const data = await api('transfer', { method: 'POST', body: JSON.stringify({ action: 'recovery-redeem', code: clubCode, recovery: raw }) });
    rememberOwner(data.club.code, data.ownerToken);
    await joinClub(data.club.code, data.club.name);
    clubSheet = { view: 'club', msg: 'Organizer access is back on this phone. Set a new PIN if the old one may have been seen.' };
  } catch (err) { clubSheet.busy = false; clubSheet.error = err.message; }
  afterJoin();
}
