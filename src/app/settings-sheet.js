let settingsOpen = false;
let settingsOpener = null;
function openSettings() {
  settingsOpener = document.activeElement;
  settingsOpen = true;
  renderSettings();
  const h = $('#settings-h'); if (h) h.focus();
}
function closeSettings() {
  settingsOpen = false;
  renderSettings();
  if (settingsOpener && settingsOpener.isConnected && settingsOpener.focus) settingsOpener.focus();
  settingsOpener = null;
}
function renderSettings() {
  const root = $('#sheet9');
  if (!root) return;
  if (!settingsOpen) { root.innerHTML = ''; root._html = root._key = ''; return; }
  const prefersDark = !!(darkMQ && darkMQ.matches);
  const themeNote = display.outdoor
    ? 'Sunlight contrast is on, so the app stays bright white until you turn it off.'
    : display.theme === 'auto'
      ? `Following your phone (currently ${prefersDark ? 'Dark' : 'Light'}).`
      : display.theme === 'dark' ? 'Always dark on this device.' : 'Always light on this device.';
  const soundNote = celebration.on
    ? (celebration.muted ? 'Chime is muted. Confetti still shows unless reduced motion is on.' : 'Plays a brief chime when a live game ends.')
    : 'Applies when win celebration is on. Mute to keep this device silent.';
  setSheet(root, `<div class="sheet-bg top"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-h"><span class="grip"></span>
    <div class="sheet-head"><h2 id="settings-h" tabindex="-1">Settings</h2><button type="button" class="x" data-act="settings-close" aria-label="Close">✕</button></div>
    <div class="field" style="margin:0"><span class="lab" id="set-app-l">Appearance</span>
      ${seg('data-theme-pick', [['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']], display.theme).replace('role="group"', 'role="group" aria-labelledby="set-app-l"')}
      <p class="note">${themeNote}</p></div>
    <div class="field" style="margin:0"><span class="lab" id="disp-o">Sunlight contrast</span>
      ${seg('data-disp', [['outdoor-0', 'Standard'], ['outdoor-1', 'Sunlight']], 'outdoor-' + display.outdoor).replace('role="group"', 'role="group" aria-labelledby="disp-o"')}
      <p class="note">White page, black text and solid team colours for bright sun.</p></div>
    <div class="field" style="margin:0"><span class="lab" id="disp-l">Court scores</span>
      ${seg('data-disp', [['large-0', 'Normal'], ['large-1', 'Large']], 'large-' + display.large).replace('role="group"', 'role="group" aria-labelledby="disp-l"')}
      <p class="note">Bigger numbers, names and score call on the scoring screen.</p></div>
    <div class="field" style="margin:0"><span class="lab" id="disp-c">Win celebration</span>
      ${seg('data-celebration', [['0', 'Off'], ['1', 'On']], String(celebration.on)).replace('role="group"', 'role="group" aria-labelledby="disp-c"')}
      <p class="note">Optional confetti and a short chime when a live game ends. Confetti stays off when reduced motion is on.</p></div>
    <div class="field" style="margin:0"><span class="lab" id="disp-s">Celebration sound</span>
      ${seg('data-celebration-sound', [['0', 'Sound on'], ['1', 'Muted']], String(celebration.muted)).replace('role="group"', 'role="group" aria-labelledby="disp-s"')}
      <p class="note">${soundNote}</p></div>
    <p class="note">Saved on this device only. Nothing is sent to the club.</p>
    <div class="btns"><button type="button" class="btn btn-soft" data-act="settings-close">Done</button></div></div></div>`, 'settings');
}
