/* ---------- game nights (api/_gamenights.js via api/club.js) ---------- */
const GN_GRACE_MS = 4 * 60 * 60 * 1000;
// The organizer's "Schedule a game night" row: a white lifted row with a coral calendar tile and a chevron (same button, same data-gn="new").
const GN_PLAN_ROW = '<button type="button" class="gn-plan" data-gn="new"><span class="np-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg></span><span class="np-txt"><b>Schedule a game night</b><small>Pick a time and see who\'s in</small></span><span class="np-chev" aria-hidden="true">›</span></button>';
const gnCanOrg = () => !!club && (isCreator() || (club.hasPin && hasOrganizer()));
const gnUpcoming = () => ((clubData && clubData.nights) || []).filter(n => n && n.status === 'open' && n.startsAt >= Date.now() - GN_GRACE_MS);

function gnMyStatus(n) {
  const mine = myName();
  if (!mine || !n || !n.rsvps) return null;
  for (const st of ['in', 'maybe', 'out']) {
    if ((n.rsvps[st] || []).some(p => sameName(p, mine))) return st;
  }
  return null;
}

function gnWhenParts(ms) {
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((target - today.getTime()) / DAY);
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : diff > 1 && diff <= 14 ? `In ${diff} days` : '';
  return { label: `${dateStr} · ${timeStr}`, rel };
}

function gnPad2(n) { return String(n).padStart(2, '0'); }
function gnDefaultDraft(night) {
  let d;
  if (night && night.startsAt) {
    d = new Date(night.startsAt);
  } else {
    d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(18, 30, 0, 0);
  }
  return {
    id: night ? night.id : '',
    title: night ? night.title : '',
    date: `${d.getFullYear()}-${gnPad2(d.getMonth() + 1)}-${gnPad2(d.getDate())}`,
    time: `${gnPad2(d.getHours())}:${gnPad2(d.getMinutes())}`,
    location: night ? (night.location || '') : '',
    cap: night && night.cap != null ? String(night.cap) : '',
    note: night ? (night.note || '') : ''
  };
}

function gnSyncLocalNight(night, removeId) {
  if (clubData) {
    const cur = (clubData.nights || []).slice();
    const id = removeId || (night && night.id);
    const idx = cur.findIndex(x => x.id === id);
    if (removeId || (night && (night.status === 'cancelled' || night.startsAt < Date.now() - GN_GRACE_MS))) {
      if (idx >= 0) cur.splice(idx, 1);
    } else if (night) {
      if (idx >= 0) cur[idx] = night; else cur.push(night);
      cur.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
    }
    clubData.nights = cur.slice(0, 10);
    store.set('pb.clubCache', clubData);
  }
  if (clubSheet && Array.isArray(clubSheet.nights)) {
    const list = clubSheet.nights.slice();
    const id = removeId || (night && night.id);
    const idx = list.findIndex(x => x.id === id);
    if (removeId) {
      if (idx >= 0) list.splice(idx, 1);
    } else if (night) {
      if (idx >= 0) list[idx] = night; else list.push(night);
      list.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
    }
    clubSheet.nights = list;
  }
}

function gnRsvpBarHTML(n, busy) {
  const mine = gnMyStatus(n);
  const full = n.cap != null && n.counts.in >= n.cap;
  const opts = [
    ['in', 'In', n.counts.in, full && mine !== 'in'],
    ['maybe', 'Maybe', n.counts.maybe, false],
    ['out', 'Out', n.counts.out, false]
  ];
  return `<div class="gn-rsvp" role="group" aria-label="Your response for ${esc(n.title)}">${opts.map(([st, label, cnt, blocked]) => {
    const sel = mine === st;
    const mark = sel ? (st === 'in' ? '✓ ' : st === 'maybe' ? '? ' : '✕ ') : '';
    const extra = blocked ? ' aria-disabled="true"' : '';
    return `<button type="button" data-gn="rsvp" data-id="${esc(n.id)}" data-st="${st}" aria-pressed="${sel}"${extra}${busy ? ' disabled' : ''}><span>${mark}${label}</span><span class="gn-cnt">${cnt}</span></button>`;
  }).join('')}</div>`;
}

function gnCapBadgeHTML(n) {
  if (n.status === 'cancelled') return '<span class="badge gn-bad">Cancelled</span>';
  if (n.cap == null) return '';
  const full = n.counts.in >= n.cap;
  return `<span class="badge ${full ? 'gn-full' : 'prov'}">${full ? `Full · ${n.counts.in}/${n.cap}` : `${n.counts.in}/${n.cap} spots`}</span>`;
}

// Home screen card for the next game night; nothing when none is scheduled (scheduling lives in the club sheet).
function gnHomeHTML() {
  if (!club || !API_OK) return '';
  const list = gnUpcoming();
  if (!list.length) return '';
  const n = list[0], w = gnWhenParts(n.startsAt);
  const inNames = (n.rsvps && n.rsvps.in) || [];
  const preview = inNames.length ? `In: ${inNames.slice(0, 6).join(', ')}${inNames.length > 6 ? ` +${inNames.length - 6} more` : ''}` : 'Be the first to say you\'re in.';
  return `<section class="card gn-home" aria-labelledby="gn-home-h">
    <div class="sec-head"><h2 id="gn-home-h" class="h-sub">Next game night</h2><button type="button" class="link" data-gn="open">${list.length > 1 ? `See all (${list.length})` : 'Details'}</button></div>
    <div class="gn-head"><div><div class="gn-title">${esc(n.title)}</div><div class="gn-when">${w.rel ? `<span class="gn-rel">${esc(w.rel)}</span> · ` : ''}${esc(w.label)}</div></div>${gnCapBadgeHTML(n)}</div>
    ${n.location ? `<div class="gn-loc">${esc(n.location)}</div>` : ''}
    ${gnRsvpBarHTML(n, false)}
    <p class="note gn-preview">${esc(preview)}</p>
  </section>`;
}

// The Events tab: upcoming game nights with In / Maybe / Out, and the organizer's button to schedule one.
function gnTabHTML() {
  if (!club || !API_OK) return '';
  const list = gnUpcoming(), org = gnCanOrg(), actLabel = org ? 'Manage' : 'Details';
  const cards = list.slice(0, 3).map(n => {
    const w = gnWhenParts(n.startsAt), inNames = (n.rsvps && n.rsvps.in) || [];
    const preview = inNames.length ? `In: ${inNames.slice(0, 6).join(', ')}${inNames.length > 6 ? ` +${inNames.length - 6} more` : ''}` : 'Be the first to say you\'re in.';
    return `<article class="card gn-home" aria-label="${esc(n.title)}">
      <div class="gn-head"><div class="gn-head-main"><h3 class="gn-title">${esc(n.title)}</h3><div class="gn-when">${w.rel ? `<span class="gn-rel">${esc(w.rel)}</span> · ` : ''}${esc(w.label)}</div></div><div class="gn-head-end"><button type="button" class="link gn-card-act" data-gn="open" aria-label="${actLabel}: ${esc(n.title)}">${actLabel}</button>${gnCapBadgeHTML(n)}</div></div>
      ${n.location ? `<div class="gn-loc">${esc(n.location)}</div>` : ''}
      ${gnRsvpBarHTML(n, false)}
      <p class="note gn-preview">${esc(preview)}</p>
    </article>`;
  }).join('');
  const unlock = !org && club.hasPin ? '<button type="button" class="link" data-act="pin-unlock-open">Organizer? Unlock this phone to schedule a game night</button>' : '';
  return `<section aria-labelledby="gn-tab-h" class="ev-sec">
    <div class="sec-head"><h2 id="gn-tab-h">Game nights</h2>${list.length ? `<button type="button" class="link" data-gn="open">See all${list.length > 3 ? ` (${list.length})` : ''}</button>` : ''}</div>
    ${org ? GN_PLAN_ROW : ''}
    ${cards || '<p class="note">No game nights scheduled yet.</p>'}${unlock}
  </section>`;
}

async function gnOpen(from) {
  if (!club) return;
  clubSheet = { view: 'nights', from: from || null, nights: clubData && clubData.nights ? clubData.nights.slice() : null, pushEnabled: null, loading: true, error: '', msg: '' };
  renderClub();
  await gnLoad();
}

async function gnLoad() {
  const c = clubSheet;
  if (!c || !club) return;
  try {
    const d = await api('club?code=' + encodeURIComponent(club.code) + '&nights=1');
    if (clubSheet !== c) return;
    if (!d.notModified) {
      c.nights = Array.isArray(d.nights) ? d.nights : [];
      c.pushEnabled = d.pushEnabled !== false;
    }
    c.loading = false; c.error = '';
    renderClub();
  } catch (err) {
    if (clubSheet === c) { c.loading = false; c.error = err.message; renderClub(); }
  }
}

async function gnRsvp(id, status) {
  if (!club) return;
  if (!myName() || !myToken()) {
    clubSheet = { view: 'whoami', msg: '' };
    renderClub();
    showToast('Pick your name in the club first to answer.', false);
    announce('Pick your name in the club first to answer.');
    return;
  }
  const all = (clubSheet && clubSheet.nights) || (clubData && clubData.nights) || [];
  const cur = all.find(x => x.id === id);
  const mine = cur ? gnMyStatus(cur) : null;
  if (cur && status === 'in' && cur.cap != null && cur.counts.in >= cur.cap && mine !== 'in') {
    const msg = `This game night is full (${cur.cap}/${cur.cap} In). You can still mark Maybe or Out.`;
    showToast(msg, false);
    announce(msg);
    return;
  }
  const nextStatus = mine === status ? 'none' : status;
  if (clubSheet && clubSheet.view === 'nights') { clubSheet.busy = true; clubSheet.error = ''; clubSheet.msg = ''; renderClub(); }
  try {
    const d = await api('club', {
      method: 'POST',
      body: JSON.stringify({ code: club.code, action: 'night-rsvp', id, status: nextStatus, playerName: myName(), playerToken: myToken() })
    });
    gnSyncLocalNight(d.night);
    const label = nextStatus === 'none' ? 'Response cleared' : `Marked ${{ in: 'In', maybe: 'Maybe', out: 'Out' }[nextStatus]}`;
    const msg = `${label} for ${d.night.title}.`;
    if (clubSheet && clubSheet.view === 'nights') { clubSheet.busy = false; clubSheet.msg = msg; }
    showToast(label, false);
    announce(msg);
    render();
  } catch (err) {
    if (clubSheet && clubSheet.view === 'nights') { clubSheet.busy = false; clubSheet.error = err.message; renderClub(); }
    else showToast(err.message, false);
    announce(err.message);
  }
}

function gnFormOpen(night) {
  const from = clubSheet ? clubSheet.from : null;
  const cachedNights = clubSheet ? clubSheet.nights : null;
  const pushEnabled = clubSheet ? clubSheet.pushEnabled : null;
  clubSheet = { view: 'night-form', from, nights: cachedNights, pushEnabled, draft: gnDefaultDraft(night), editing: !!night, error: '', busy: false };
  renderClub();
  const t = $('#gn-title'); if (t) t.focus();
}

function gnSyncDraftFromDom() {
  if (!clubSheet || clubSheet.view !== 'night-form' || !clubSheet.draft) return;
  const d = clubSheet.draft;
  const val = sel => { const el = $(sel); return el ? el.value : null; };
  for (const [k, sel] of [['title', '#gn-title'], ['date', '#gn-date'], ['time', '#gn-time'], ['location', '#gn-loc'], ['cap', '#gn-cap'], ['note', '#gn-note']]) {
    const v = val(sel); if (v !== null) d[k] = v;
  }
}

async function gnFormSave() {
  if (!clubSheet || clubSheet.view !== 'night-form') return;
  gnSyncDraftFromDom();
  const d = clubSheet.draft;
  const title = String(d.title || '').trim();
  if (!title) { clubSheet.error = 'Give this game night a title.'; renderClub(); announce(clubSheet.error); return; }
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d.date || '').trim());
  const tm = /^(\d{2}):(\d{2})$/.exec(String(d.time || '').trim());
  if (!dm || !tm) { clubSheet.error = 'Pick both a date and a start time.'; renderClub(); announce(clubSheet.error); return; }
  const startsAt = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0).getTime();
  if (!Number.isFinite(startsAt)) { clubSheet.error = 'Pick a valid date and time.'; renderClub(); announce(clubSheet.error); return; }
  const capRaw = String(d.cap || '').trim();
  let cap = null;
  if (capRaw !== '') {
    const n = Number(capRaw);
    if (!Number.isInteger(n) || n < 2 || n > 128) { clubSheet.error = 'Player limit must be a whole number from 2 to 128.'; renderClub(); announce(clubSheet.error); return; }
    cap = n;
  }
  clubSheet.busy = true; clubSheet.error = ''; renderClub();
  try {
    const action = clubSheet.editing ? 'night-edit' : 'night-create';
    const payload = Object.assign({
      code: club.code, action,
      ...(clubSheet.editing ? { id: d.id } : {}),
      night: { title, startsAt, location: String(d.location || '').trim(), note: String(d.note || '').trim(), cap },
      ...(clubSheet.editing ? {} : { tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })() })
    }, adminCreds());
    const res = await api('club', { method: 'POST', body: JSON.stringify(payload) });
    const saved = res.night;
    inboxAck('night', saved.id, saved.status === 'cancelled' ? null : Inbox.nightFp(saved));
    const from = clubSheet.from, pushEnabled = clubSheet.pushEnabled, list = clubSheet.nights;
    clubSheet = { view: 'nights', from, nights: Array.isArray(list) ? list : [], pushEnabled, msg: clubSheet.editing ? 'Game night updated.' : 'Game night scheduled.' };
    gnSyncLocalNight(saved);
    announce(clubSheet.msg);
    render();
    gnLoad();
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message; renderClub(); announce(err.message);
  }
}

async function gnCancel(id) {
  if (!clubSheet || clubSheet.view !== 'nights') return;
  if (clubSheet.armedCancel !== id) { clubSheet.armedCancel = id; clubSheet.armedDelete = null; renderClub(); return; }
  clubSheet.busy = true; clubSheet.armedCancel = null; clubSheet.error = ''; clubSheet.msg = ''; renderClub();
  try {
    const res = await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'night-cancel', id }, adminCreds())) });
    inboxAck('night', id, null);
    gnSyncLocalNight(res.night);
    clubSheet.busy = false; clubSheet.msg = `${res.night.title} was cancelled.`;
    announce(clubSheet.msg);
    render();
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message; renderClub(); announce(err.message);
  }
}

async function gnDelete(id) {
  if (!clubSheet || clubSheet.view !== 'nights') return;
  if (clubSheet.armedDelete !== id) { clubSheet.armedDelete = id; clubSheet.armedCancel = null; renderClub(); return; }
  clubSheet.busy = true; clubSheet.armedDelete = null; clubSheet.error = ''; clubSheet.msg = ''; renderClub();
  try {
    await api('club', { method: 'POST', body: JSON.stringify(Object.assign({ code: club.code, action: 'night-delete', id }, adminCreds())) });
    inboxAck('night', id, null);
    gnSyncLocalNight(null, id);
    clubSheet.busy = false; clubSheet.msg = 'Game night removed.';
    announce(clubSheet.msg);
    render();
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message; renderClub(); announce(err.message);
  }
}

function gnRemindOpen(id) {
  if (!clubSheet || clubSheet.view !== 'nights') return;
  const n = (clubSheet.nights || []).find(x => x.id === id);
  if (!n) return;
  clubSheet = {
    view: 'night-remind', from: clubSheet.from, nights: clubSheet.nights, pushEnabled: clubSheet.pushEnabled,
    id, audience: 'all', busy: false, error: '', msg: ''
  };
  renderClub();
}

async function gnRemindSend() {
  if (!clubSheet || clubSheet.view !== 'night-remind') return;
  clubSheet.busy = true; clubSheet.error = ''; clubSheet.msg = ''; renderClub();
  let tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch {}
  try {
    const res = await api('club', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ code: club.code, action: 'night-remind', id: clubSheet.id, audience: clubSheet.audience || 'all', tz }, adminCreds()))
    });
    if (res.night) gnSyncLocalNight(res.night);
    clubSheet.busy = false;
    if (res.enabled === false) {
      clubSheet.pushEnabled = false;
      clubSheet.msg = res.message || 'Notifications are not set up on this server yet.';
    } else if (res.sent > 0) {
      clubSheet.msg = `Reminder sent to ${res.sent} device${res.sent === 1 ? '' : 's'}.`;
    } else {
      clubSheet.msg = res.message || 'No subscribed members to notify right now.';
    }
    announce(clubSheet.msg);
    renderClub();
  } catch (err) {
    clubSheet.busy = false; clubSheet.error = err.message; renderClub(); announce(err.message);
  }
}

function gnPeopleListHTML(label, names, cls) {
  if (!names || !names.length) return '';
  return `<div class="gn-group"><span class="gn-g-lab ${cls}">${label} (${names.length})</span><span class="gn-g-names">${names.map(p => `${esc(p)}${youTag(p)}`).join(', ')}</span></div>`;
}

function gnCardHTML(n, c, org, isPast) {
  const w = gnWhenParts(n.startsAt);
  const open = n.status === 'open' && !isPast;
  const total = n.counts.in + n.counts.maybe + n.counts.out;
  const lists = total ? `<div class="gn-lists">${gnPeopleListHTML('In', n.rsvps.in, 'in')}${gnPeopleListHTML('Maybe', n.rsvps.maybe, 'maybe')}${gnPeopleListHTML('Out', n.rsvps.out, 'out')}</div>` : '<p class="note" style="margin:6px 0 0">No responses yet.</p>';
  const remMeta = n.remindedAt ? `<p class="note" style="margin:6px 0 0">Last reminder: ${esc(new Date(n.remindedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} (${n.reminderCount}/5)</p>` : '';
  const orgRow = !org || isPast ? '' : n.status === 'open'
    ? `<div class="gn-org-row">
        <button type="button" class="btn btn-soft gn-sm" data-gn="remind-open" data-id="${esc(n.id)}" ${c.busy ? 'disabled' : ''}>Remind</button>
        <button type="button" class="btn btn-soft gn-sm" data-gn="edit" data-id="${esc(n.id)}" ${c.busy ? 'disabled' : ''}>Edit</button>
        <button type="button" class="btn ${c.armedCancel === n.id ? 'btn-line-danger' : 'btn-soft'} gn-sm" data-gn="cancel" data-id="${esc(n.id)}" ${c.busy ? 'disabled' : ''}>${c.armedCancel === n.id ? 'Tap again to cancel' : 'Cancel night'}</button>
      </div>`
    : `<div class="gn-org-row"><button type="button" class="btn ${c.armedDelete === n.id ? 'btn-line-danger' : 'btn-soft'} gn-sm" data-gn="delete" data-id="${esc(n.id)}" ${c.busy ? 'disabled' : ''}>${c.armedDelete === n.id ? 'Tap again to remove' : 'Remove'}</button></div>`;
  return `<article class="gn-card${n.status === 'cancelled' ? ' is-off' : ''}">
    <div class="gn-head"><div><h3 class="gn-title">${esc(n.title)}</h3><div class="gn-when">${w.rel && !isPast ? `<span class="gn-rel">${esc(w.rel)}</span> · ` : ''}${esc(w.label)}</div></div>${gnCapBadgeHTML(n)}</div>
    ${n.location ? `<div class="gn-loc">${esc(n.location)}</div>` : ''}
    ${n.note ? `<p class="gn-note">${esc(n.note)}</p>` : ''}
    ${open ? gnRsvpBarHTML(n, c.busy) : `<div class="gn-counts-row"><span><b>${n.counts.in}</b> In</span><span><b>${n.counts.maybe}</b> Maybe</span><span><b>${n.counts.out}</b> Out</span></div>`}
    ${lists}${remMeta}${orgRow}
  </article>`;
}

function gnSheetHTML(c) {
  const err = c.error ? `<p class="err" role="alert">${esc(c.error)}</p>` : '';
  const msg = c.msg ? `<p class="note" role="status">${esc(c.msg)}</p>` : '';
  if (c.view === 'night-form') {
    const d = c.draft || gnDefaultDraft(null);
    return `<h2 id="club-h">${c.editing ? 'Edit game night' : 'Schedule a game night'}</h2>
      <form class="club-form" data-form="gn-save" novalidate>
        <label class="lab" for="gn-title">Title</label>
        <input id="gn-title" class="field-input" data-gn-in="title" maxlength="60" autocomplete="off" required placeholder="Tuesday open play, Friday lights…" value="${esc(d.title)}">
        <div class="gn-dt-row">
          <div><label class="lab" for="gn-date">Date</label><input id="gn-date" class="field-input" data-gn-in="date" type="date" required value="${esc(d.date)}"></div>
          <div><label class="lab" for="gn-time">Start time</label><input id="gn-time" class="field-input" data-gn-in="time" type="time" required value="${esc(d.time)}"></div>
        </div>
        <label class="lab" for="gn-loc">Location or courts (optional)</label>
        <input id="gn-loc" class="field-input" data-gn-in="location" maxlength="80" autocomplete="off" placeholder="West Park, Courts 1–3" value="${esc(d.location)}">
        <label class="lab" for="gn-cap">Player limit (optional)</label>
        <span id="gn-cap-hint" class="note">Leave blank for no cap. Once full, others can still mark Maybe or Out.</span>
        <input id="gn-cap" class="field-input" data-gn-in="cap" type="number" inputmode="numeric" min="2" max="128" aria-describedby="gn-cap-hint" placeholder="No limit" value="${esc(d.cap)}">
        <label class="lab" for="gn-note">Note (optional)</label>
        <textarea id="gn-note" class="field-input" data-gn-in="note" rows="3" maxlength="300" placeholder="Warm-up time, balls to bring, skill level…">${esc(d.note)}</textarea>
        ${err}
        <button type="submit" class="btn btn-ink block" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Saving…' : c.editing ? 'Save changes' : 'Schedule game night'}</button>
      </form>
      <div class="btns"><button type="button" class="btn btn-soft" data-gn="back-list" ${c.busy ? 'disabled' : ''}>Cancel</button></div>`;
  }
  if (c.view === 'night-remind') {
    const n = (c.nights || []).find(x => x.id === c.id);
    if (!n) return `<h2 id="club-h">Send reminder</h2><p class="note">That game night is no longer in the list.</p><div class="btns"><button type="button" class="btn btn-soft" data-gn="back-list">Back</button></div>`;
    const w = gnWhenParts(n.startsAt);
    const aud = c.audience || 'all';
    const audOpts = [['all', 'Everyone not Out'], ['going', 'In & Maybe'], ['unanswered', 'Not answered']];
    return `<h2 id="club-h">Send reminder</h2>
      <div class="org-card"><div class="gn-title">${esc(n.title)}</div><div class="gn-when">${esc(w.label)}${n.location ? ` · ${esc(n.location)}` : ''}</div></div>
      ${msg}${err}
      ${c.pushEnabled === false
        ? `<div class="org-card" role="status"><p>Notifications are not set up on this server yet. Once push notifications are configured, you can remind club members here.</p></div>`
        : `<div class="field" style="margin:0"><span class="lab">Who should get this reminder?</span>
            <div class="seg" role="group" aria-label="Reminder audience">${audOpts.map(([v, l]) => `<button type="button" data-gn="aud" data-v="${v}" aria-pressed="${aud === v}">${l}</button>`).join('')}</div>
            <p class="note">Only goes to members who turned on notifications for ${esc(club.name)}. The notification never includes the club code.</p></div>
          ${n.remindedAt ? `<p class="note">Last reminder sent ${esc(new Date(n.remindedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} (${n.reminderCount} of 5).</p>` : ''}
          <button type="button" class="btn btn-ink block" data-gn="remind-send" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Sending…' : 'Send push reminder'}</button>`}
      <div class="btns"><button type="button" class="btn btn-soft" data-gn="back-list" ${c.busy ? 'disabled' : ''}>Back</button></div>`;
  }
  const org = gnCanOrg();
  const now = Date.now();
  const all = c.nights || [];
  const upcoming = all.filter(n => n.startsAt >= now - GN_GRACE_MS);
  const past = all.filter(n => n.startsAt < now - GN_GRACE_MS).reverse();
  const orgPrompt = org
    ? GN_PLAN_ROW
    : club.hasPin
      ? '<div class="org-card"><p>Scheduling game nights and sending reminders needs the organizer PIN.</p><button type="button" class="btn btn-ink" data-act="pin-unlock-open">Unlock this phone</button></div>'
      : '';
  const body = c.loading && !all.length ? skel(2, true)
    : upcoming.length ? `<div class="gn-stack">${upcoming.map(n => gnCardHTML(n, c, org, false)).join('')}</div>`
    : '<div class="org-card"><p>No upcoming game nights yet. An organizer can schedule a future night and members can tap In, Maybe or Out.</p></div>';
  const pastHTML = past.length ? `<details class="gn-past"><summary>Recent past nights (${past.length})</summary><div class="gn-stack" style="margin-top:10px">${past.map(n => gnCardHTML(n, c, org, true)).join('')}</div></details>` : '';
  return `<h2 id="club-h">Game nights</h2>
    ${msg}${err}${orgPrompt}${body}${pastHTML}
    <div class="btns">${c.from === 'club' ? '<button type="button" class="btn btn-soft" data-act="club-back">Back</button>' : ''}<button type="button" class="btn btn-soft" data-act="club-close">Done</button></div>`;
}

function gnAct(act, ds) {
  if (act === 'open') { gnOpen(ds.gnFrom || null); return; }
  if (act === 'rsvp') { gnRsvp(ds.id, ds.st); return; }
  if (act === 'new') { gnFormOpen(null); return; }
  if (act === 'edit') {
    const n = ((clubSheet && clubSheet.nights) || (clubData && clubData.nights) || []).find(x => x.id === ds.id);
    if (n) gnFormOpen(n);
    return;
  }
  if (act === 'cancel') { gnCancel(ds.id); return; }
  if (act === 'delete') { gnDelete(ds.id); return; }
  if (act === 'remind-open') { gnRemindOpen(ds.id); return; }
  if (act === 'aud' && clubSheet && clubSheet.view === 'night-remind') { clubSheet.audience = ds.v; renderClub(); return; }
  if (act === 'remind-send') { gnRemindSend(); return; }
  if (act === 'back-list') {
    const from = clubSheet ? clubSheet.from : null, list = clubSheet ? clubSheet.nights : null, pushEnabled = clubSheet ? clubSheet.pushEnabled : null;
    clubSheet = { view: 'nights', from, nights: list, pushEnabled, loading: !list, error: '', msg: '' };
    renderClub();
    gnLoad();
  }
}
