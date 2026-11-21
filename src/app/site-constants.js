const TEAM_NAME = ['Blue', 'Green'];
const DAY = 864e5;
const SITE_URL = 'https://dinkscore.vercel.app';
const FRAMED = (() => { try { return window.self !== window.top; } catch { return true; } })();
// Club sync needs this site's own /api, so it is off inside the Claude artifact and on the old GitHub Pages address.
const API_OK = !FRAMED && /^https?:$/.test(location.protocol) && !/github\.io$/.test(location.hostname);

