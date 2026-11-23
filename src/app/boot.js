if (live && live.state.winner === null && live.open) keepAwake(true);
applyDisplay();
render();
if (importedCount) showToast(`Moved ${importedCount} game${importedCount === 1 ? '' : 's'} from the old site`, false);
if (club) { flush(); refreshClub(); }
checkInvite().finally(() => { urlReady = true; syncUrl(); });
// Know at once whether a sign-in is alive, so the club screens can say so and offer the account's clubs.
if (API_OK && passkeysOk()) acctLoad().then(() => {
  const c = clubSheet, f = document.activeElement;
  if (acctIn() && c && !c.busy && (c.view === 'add' || c.view === 'club') && !(f && f.closest && f.closest('#sheet3') && /^(INPUT|TEXTAREA)$/.test(f.tagName))) renderClub();
});
