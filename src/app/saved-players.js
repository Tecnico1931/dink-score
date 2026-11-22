/* ---------- saved players ---------- */
let roster = Heal.strs(store.get('pb.roster', []));
let rosterEdit = false;
let profileDoc = null;
let rosterWriting = Promise.resolve();
function persistRoster() {
  roster.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  store.set('pb.roster', roster);
  if (profileDoc) { const snap = roster.slice(); rosterWriting = rosterWriting.then(() => profileDoc.set({ roster: snap })).catch(() => {}); }
}
function addToRoster(names) {
  if (pickup) { pickupAddNames(names); return; }
  let changed = false;
  for (const raw of names) {
    const n = String(raw || '').trim().slice(0, 40);
    if (!n || isDefaultName(n) || roster.some(r => sameName(r, n))) continue;
    roster.push(n); changed = true;
    if (club) queueOp({ type: 'roster-add', name: n });
  }
  if (changed) { if (club) roster.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })); else persistRoster(); }
}
function removeFromRoster(name) {
  if (pickup) return;
  // In a club with a PIN, removing a saved player is an organizer action: withPin asks for the PIN first if needed.
  if (club && club.hasPin && !hasOrganizer()) { withPin({ type: 'roster-del', name }); return; }
  roster = roster.filter(r => !sameName(r, name));
  if (club) withPin({ type: 'roster-del', name }); else persistRoster();
}
// Toggle a saved player into the first open slot of a names grid, or out of it if already there.
function pickInto(names, mode, name) {
  const n = mode === 'doubles' ? 2 : 1;
  for (const t of [0, 1]) for (let i = 0; i < n; i++) if (sameName(names[t][i] || '', name)) { names[t][i] = ''; return; }
  for (const t of [0, 1]) for (let i = 0; i < n; i++) if (!(names[t][i] || '').trim()) { names[t][i] = name; return; }
}
function chipsHTML(names, mode, scope) {
  const { tables } = DR.compute(ratedGames());
  const n = mode === 'doubles' ? 2 : 1;
  const inUse = name => [0, 1].some(t => names[t].slice(0, n).some(v => sameName(v || '', name)));
  const editing = scope === 'setup' && rosterEdit;
  return rosterNames().map(name => {
    const p = DR.lookup(tables, mode, name);
    return `<button type="button" class="chip-btn ${editing ? 'editing' : ''}" data-pick="${esc(name)}" data-scope="${scope}" aria-pressed="${!editing && inUse(name)}" ${editing ? `aria-label="Remove ${esc(name)}"` : ''}>${esc(name)}${p && p.games && !editing ? `<span class="r">${r2(p.rating)}</span>` : ''}</button>`;
  }).join('');
}

