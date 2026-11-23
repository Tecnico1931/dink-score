// ---- Import players and teams from a Google Sheet or a CSV (the parsing and checks live in sheet-import.js, loaded on demand) ----
// The preview is edited in place: typing updates the draft and the messages next to each row without redrawing the form.
let imMod = null;
function imLoad() {
  if (imMod || imLoad.started) return;
  imLoad.started = true;
  import('./sheet-import.js').then(m => { imMod = m; renderEvents(true); })
    .catch(() => { imLoad.started = false; const im = evScreen && evScreen.form && evScreen.form.imp; if (im) { im.error = 'The importer could not load. Check your connection and try again.'; renderEvents(true); } });
}
const evRotating = f => f.partners === 'rotating' && (f.format === 'roundrobin' || f.format === 'pool_knockout');
const evImpOpts = f => ({ format: f.format, partners: evRotating(f) ? 'rotating' : 'fixed' });
const IMP_TABS = [['link', 'Google Sheet'], ['paste', 'Paste CSV'], ['file', 'Upload a file']];
function impHelpHTML() {
  const C = imMod.COLUMNS, list = ids => ids.map(id => `<li><b>${esc(C[id].label)}</b>: ${esc(C[id].about.replace(/^(one row per \w+|optional): /, ''))}</li>`).join('');
  return `<details class="ev-more"><summary>Accepted columns and templates</summary>
    <p class="note">The first row names the columns, in any order, in any capitals. Other columns are ignored. Two layouts work:</p>
    <p class="note"><b>One row per player</b>, rows with the same Team form a team:</p><ul class="note imp-cols">${list(imMod.LAYOUT_COLUMNS.players)}</ul>
    <p class="note"><b>One row per team</b>, with a Player 1 and a Player 2 column:</p><ul class="note imp-cols">${list(imMod.LAYOUT_COLUMNS.teams)}</ul>
    <div class="ev-actions"><button type="button" class="btn btn-soft ev-small" data-ev="imp-tpl" data-v="players">Template: one row per player</button><button type="button" class="btn btn-soft ev-small" data-ev="imp-tpl" data-v="teams">Template: one row per team</button></div></details>`;
}
function evImportHTML(f) {
  const im = f.imp;
  if (!im) return `<div class="field"><button type="button" class="btn btn-soft block" data-ev="imp-open">Import players and teams from a sheet</button><p class="note">From a Google Sheet or a CSV file: player names, team names, team logo links and DUPR IDs.</p></div>`;
  if (!imMod) { imLoad(); return `<div class="ev-card imp"><p class="note" role="status">${im.error ? esc(im.error) : 'Loading the importer…'}</p></div>`; }
  if (im.draft) return evPreviewHTML(f);
  const tabs = `<div class="seg" role="group" aria-label="Where the players come from">${IMP_TABS.map(([v, l]) => `<button type="button" data-ev="imp-tab" data-v="${v}" aria-pressed="${im.tab === v}">${l}</button>`).join('')}</div>`;
  const src = im.tab === 'link'
    ? `<div class="field"><label class="lab" for="imp-link">Link to the sheet</label><input id="imp-link" class="field-input" data-ev-input="imp-link" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(im.link)}">
        <p class="note">In Google Sheets choose <b>Share</b>, then <b>General access: Anyone with the link</b> (Viewer). A sheet published to the web works too. Dink Score only reads the sheet once, when you tap Read; it never asks for your Google login. If the sheet has several tabs, open the one with the players before copying the link.</p></div>`
    : im.tab === 'paste'
      ? `<div class="field"><label class="lab" for="imp-text">Paste the rows, header row first</label><textarea id="imp-text" class="field-input imp-text" data-ev-input="imp-text" rows="7" spellcheck="false" autocapitalize="off" placeholder="Player,Team,DUPR ID,Logo URL">${esc(im.text)}</textarea><p class="note">CSV, or rows copied straight from a spreadsheet.</p></div>`
      : `<div class="field"><label class="lab" for="imp-file">A .csv file</label><input id="imp-file" type="file" class="field-input" accept=".csv,text/csv,text/plain" data-ev-file="imp"><p class="note">${im.fileName ? esc(im.fileName) + ' · ' : ''}Up to 512 KB and 200 rows. In Google Sheets: File, Download, Comma-separated values.</p></div>`;
  return `<div class="ev-card imp"><div class="ev-item-head"><h3>Import from a sheet</h3><button type="button" class="link" data-ev="imp-close">Cancel</button></div>${tabs}${src}
    ${im.error ? `<p class="err" role="alert">${esc(im.error)}</p>` : ''}
    ${im.tab === 'file' ? '' : `<button type="button" class="btn btn-ink" data-ev="imp-read" ${im.busy ? 'disabled' : ''}>${im.busy ? 'Reading…' : im.tab === 'link' ? 'Read the sheet' : 'Preview'}</button>`}
    ${impHelpHTML()}</div>`;
}
function impMsgHTML(V, at) {
  return V.errors.filter(e => e.at === at).map(e => `<span class="err">${esc(e.msg)}</span>`).join('') + V.warnings.filter(w => w.at === at).map(w => `<span class="note imp-warn">Check: ${esc(w.msg)}</span>`).join('');
}
function impSummaryHTML(f, V) {
  const teams = V.usesTeams ? `, ${V.teams.length} team${V.teams.length === 1 ? '' : 's'}` : '';
  const glob = V.errors.filter(e => e.at === 'g').map(e => `<span class="err">${esc(e.msg)}</span>`).join('');
  const other = V.errors.length - V.errors.filter(e => e.at === 'g').length;
  return `<b>${V.players.length} player${V.players.length === 1 ? '' : 's'}${teams}</b> · ${V.ok ? 'ready to create' : `${V.errors.length} problem${V.errors.length === 1 ? '' : 's'} to fix${other ? ' (marked below)' : ''}`}${V.warnings.length ? ` · ${V.warnings.length} to check` : ''}${glob}`;
}
function impPlayerRow(at, p, label) {
  return `<div class="imp-pl"><input class="field-input" data-ev-draft="${at}:name" value="${esc(p.name)}" maxlength="60" autocomplete="off" placeholder="Player" aria-label="${esc(label)} name"><input class="field-input imp-dupr" data-ev-draft="${at}:dupr" value="${esc(p.dupr)}" maxlength="14" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DUPR ID" aria-label="${esc(label)} DUPR ID, reference only"><button type="button" class="link" data-ev="imp-del" data-at="${at}" aria-label="Remove ${esc(label)}">Remove</button></div><div class="imp-msg" data-imp-at="${at}"></div>`;
}
function evPreviewHTML(f) {
  const im = f.imp, d = im.draft, V = imMod.validate(d, evImpOpts(f));
  const layout = d.layout === 'teams' ? 'one row per team (Player 1 and Player 2 columns)' : 'one row per player (rows with the same Team form a team)';
  const why = V.usesTeams ? 'The teams from the sheet are used, in sheet order. In a bracket the first team is seed 1.'
    : d.teams.length && evRotating(f) ? 'Partners rotate every round in this format, so team names and logos are not used: only the players are added. To use the sheet\'s teams, choose Fixed teams or a single or double elimination format above.'
    : d.teams.length ? 'The teams in the sheet are not used here. The app forms the teams with the setting above.' : 'The sheet has no teams, so the app forms them with the setting above.';
  let body = '';
  if (V.usesTeams) {
    body = d.teams.map((t, i) => {
      const at = 't' + i, ok = !imMod.cleanLogoUrl(t.logo).error ? imMod.cleanLogoUrl(t.logo).value : '';
      return `<fieldset class="imp-team"><legend class="vh">Team ${i + 1}</legend>
        <div class="imp-head">${ok ? BK.logoOfUrl(ok, t.name || (t.players[0] || {}).name) : ''}<input class="field-input" data-ev-draft="${at}:name" value="${esc(t.name)}" maxlength="60" autocomplete="off" placeholder="Team ${i + 1} name (optional)" aria-label="Team ${i + 1} name"><button type="button" class="link" data-ev="imp-del" data-at="${at}" aria-label="Remove team ${i + 1}">Remove</button></div>
        <input class="field-input" data-ev-draft="${at}:logo" value="${esc(t.logo)}" maxlength="400" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Logo link, https://… (optional)" aria-label="Team ${i + 1} logo link">
        <div class="imp-msg" data-imp-at="${at}"></div>${t.players.map((p, j) => impPlayerRow(`${at}p${j}`, p, `Team ${i + 1} player ${j + 1}`)).join('')}</fieldset>`;
    }).join('');
    if (d.loose.length) body += `<fieldset class="imp-team"><legend>No team</legend>${d.loose.map((p, j) => impPlayerRow('l' + j, p, `Player without a team ${j + 1}`)).join('')}</fieldset>`;
  } else {
    const rows = [...d.teams.flatMap((t, i) => t.players.map((p, j) => [`t${i}p${j}`, p])), ...d.loose.map((p, j) => ['l' + j, p])];
    body = `<fieldset class="imp-team"><legend class="vh">Players</legend>${rows.map(([at, p], k) => impPlayerRow(at, p, `Player ${k + 1}`)).join('')}</fieldset>`;
  }
  const anyLogo = V.usesTeams && d.teams.some(t => imMod.cleanLogoUrl(t.logo).value);
  return `<div class="ev-card imp"><div class="ev-item-head"><h3>Check the import</h3><button type="button" class="link" data-ev="imp-reset">Use a different sheet</button></div>
    <p class="note">Detected ${layout}. Columns found: ${esc(im.parsed.found.join(', '))}.</p><p class="note">${esc(why)}</p>
    ${d.notes.map(n => `<p class="note imp-warn">${esc(n)}</p>`).join('')}
    <p class="imp-sum" role="status" aria-live="polite" data-imp-sum>${impSummaryHTML(f, V)}</p>
    <p class="note">Fix a name, team or link here, or edit the sheet and read it again. Nothing is created until you tap the button at the bottom.</p>
    ${body}
    <p class="note"><b>DUPR ID</b> is a private reference for organizers only. It is not checked with DUPR, never sent to DUPR, and never shown on the public bracket page. DUPR does not accept typed-in IDs for results, so it is unverified.</p>
    ${anyLogo ? `<label class="imp-check"><input type="checkbox" data-ev-input="imp-publiclogos" ${im.publicLogos ? 'checked' : ''}> Show team logos on the public bracket page</label><p class="note">Logos load from the websites in your links, so a viewer's browser contacts those sites. Team names show either way. You can change this later.</p>` : ''}</div>`;
}
function evImpRefresh() {
  const s = evScreen, f = s && s.form;
  if (!f || !f.imp || !f.imp.draft || !imMod) return;
  const V = imMod.validate(f.imp.draft, evImpOpts(f)), root = $('#events');
  const sum = root.querySelector('[data-imp-sum]'); if (sum) sum.innerHTML = impSummaryHTML(f, V);
  root.querySelectorAll('[data-imp-at]').forEach(el => { el.innerHTML = impMsgHTML(V, el.dataset.impAt); });
  const go = root.querySelector('[data-imp-go]'); if (go) go.disabled = f.busy || !V.ok;
}
function impTarget(d, at) {
  const m = /^t(\d+)(?:p(\d+))?$/.exec(at) || [], l = /^l(\d+)$/.exec(at) || [];
  if (l[1] !== undefined) return d.loose[+l[1]] || null;
  const t = d.teams[+m[1]];
  return !t ? null : m[2] !== undefined ? t.players[+m[2]] || null : t;
}
function evImpSet(at, field, value) {
  const f = evScreen && evScreen.form, d = f && f.imp && f.imp.draft, t = d && imMod && impTarget(d, at);
  if (!t) return;
  t[field] = field === 'dupr' ? value.trim().toUpperCase() : field === 'logo' ? value.trim() : imMod.cleanText(value);
  evImpRefresh();
}
function evImpParse(text) {
  const f = evScreen.form, im = f.imp, r = imMod.parseSheet(text);
  im.busy = false;
  if (!r.ok) { im.error = r.error; im.draft = null; }
  else { im.error = ''; im.draft = r.draft; im.parsed = { layout: r.layout, found: r.found }; f.error = ''; }
  renderEvents(true);
}
async function evImpRead() {
  const s = evScreen, f = s && s.form, im = f && f.imp;
  if (!im || im.busy || !imMod) return;
  im.error = '';
  if (im.tab !== 'link') { evImpParse(im.text); return; }
  if (!im.link.trim()) { im.error = 'Paste the link to your Google Sheet first.'; renderEvents(true); return; }
  im.busy = true; renderEvents(true);
  try {
    const data = await evCall({ action: 'sheet-fetch', url: im.link.trim() });
    if (evScreen !== s || f.imp !== im) return;
    im.text = data.csv;
    evImpParse(data.csv);
  } catch (err) {
    if (err.status === 403) forgetPin();
    if (evScreen !== s || f.imp !== im) return;
    im.busy = false; im.error = err.message; renderEvents(true);
  }
}
function evImpFile(input) {
  const s = evScreen, f = s && s.form, im = f && f.imp, file = input.files && input.files[0];
  if (!im || !file || !imMod) return;
  im.fileName = file.name;
  if (file.size > imMod.LIMITS.bytes) { im.error = 'That file is too large. Keep it under 512 KB.'; renderEvents(true); return; }
  file.text().then(t => { if (evScreen === s && f.imp === im) { im.text = t; im.error = ''; evImpParse(t); } })
    .catch(() => { im.error = 'Could not read that file.'; renderEvents(true); });
}
function evImpDownload(which) {
  if (!imMod) return;
  const url = URL.createObjectURL(new Blob([which === 'teams' ? imMod.TEMPLATE_TEAMS : imMod.TEMPLATE_PLAYERS], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `dink-score-${which === 'teams' ? 'teams' : 'players'}-template.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Buttons of the import. Returns true when the action was one of these.
function evImpAct(a, d, f) {
  if (a === 'imp-open') { f.imp = { tab: 'link', link: '', text: '', fileName: '', busy: false, error: '', draft: null, parsed: null, publicLogos: true }; imLoad(); renderEvents(true); const i = $('#imp-link'); if (i) i.focus({ preventScroll: true }); return true; }
  if (!a.startsWith('imp-') || !f.imp) return false;
  const im = f.imp;
  if (a === 'imp-close') { f.imp = null; renderEvents(true); return true; }
  if (a === 'imp-tab') { im.tab = d.v; im.error = ''; renderEvents(true); return true; }
  if (a === 'imp-read') { evImpRead(); return true; }
  if (a === 'imp-tpl') { evImpDownload(d.v); return true; }
  if (a === 'imp-reset') { im.draft = null; im.parsed = null; im.error = ''; renderEvents(true); return true; }
  if (a === 'imp-del' && im.draft) {
    const dr = im.draft, m = /^t(\d+)(?:p(\d+))?$/.exec(d.at), l = /^l(\d+)$/.exec(d.at);
    if (l) dr.loose.splice(+l[1], 1);
    else if (m && m[2] !== undefined) dr.teams[+m[1]].players.splice(+m[2], 1);
    else if (m) dr.teams.splice(+m[1], 1);
    if (!dr.teams.length && !dr.loose.length) { im.draft = null; im.error = 'Nothing is left to import.'; }
    renderEvents(true); return true;
  }
  return false;
}
