// Public, read-only pages for one finished game or one club session: what a stranger may see, the preview text and the page.
// Pure functions, no database. Like _share.js (the bracket), everything is copied field by field, so a field added to a game
// later stays private until it is listed here. Never in it: the club code or name, member lists, organizer or player
// tokens, who recorded or confirmed the game, ratings, game ids, or the rally log itself (only the chart numbers made from it).
import { checkLog, flow } from './_rallylog.js';
import { cardText } from './_card.js';

const str = (v, n = 40) => (typeof v === 'string' ? v.slice(0, n) : '');
const int = v => (Number.isFinite(v) ? Math.trunc(v) : null);
const team = t => (Array.isArray(t) ? t.slice(0, 2).map(p => str(p)) : []);
const nums = a => (Array.isArray(a) ? a.slice(0, 401).map(int) : []);
const one = g => ({
  mode: g.mode === 'singles' ? 'singles' : 'doubles',
  teams: [team(g.teams && g.teams[0]), team(g.teams && g.teams[1])],
  score: [int(g.score && g.score[0]) ?? 0, int(g.score && g.score[1]) ?? 0],
  winner: g.winner === 1 ? 1 : 0,
  endedAt: int(g.endedAt)
});

// `data` is the stored game, `log` its rally log (or null). The chart numbers are only sent when the log replays to the saved score.
export function gameView(data, log) {
  const out = { v: 1, kind: 'game', ...one(data), scoring: data.scoring === 'rally' ? 'rally' : 'sideout', target: int(data.target), winBy: int(data.winBy), flow: null };
  const f = log && !data.logged && checkLog(data, log) ? flow(data, log) : null;
  if (f) out.flow = { n: f.n, lead: nums(f.lead), sideouts: nums(f.sideouts), span: int(f.span), runs: f.runs.slice(0, 80).map(r => ({ team: r.team ? 1 : 0, from: int(r.from), to: int(r.to), n: int(r.n) })), best: f.best ? { team: f.best.team ? 1 : 0, n: int(f.best.n) } : null };
  return out;
}
export function sessionView(rows, from, to) {
  return { v: 1, kind: 'session', from: int(from), to: int(to), games: rows.slice(0, 60).map(one) };
}

const label = t => t.join(' & ');
const DAY = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export function preview(v) {
  if (v.kind === 'game') {
    const w = v.winner, l = 1 - w;
    return {
      title: `${label(v.teams[w])} beat ${label(v.teams[l])} ${v.score[w]}\u2013${v.score[l]}`,
      description: `${v.mode === 'singles' ? 'Singles' : 'Doubles'} pickleball, ${DAY(v.endedAt)}. Scored with Dink Score.`
    };
  }
  const n = v.games.length;
  return { title: `${n} pickleball game${n === 1 ? '' : 's'}, ${DAY(v.from)}`, description: 'Results from one session. Scored with Dink Score.' };
}
// The card image text for a view.
export function cardModel(v) {
  if (v.kind === 'game') return { kicker: `${v.mode === 'singles' ? 'Singles' : 'Doubles'} - ${DAY(v.endedAt)}`, teams: [0, 1].map(i => ({ name: label(v.teams[i]), score: v.score[i], win: v.winner === i })) };
  const n = v.games.length;
  return { kicker: `Session - ${DAY(v.from)}`, headline: `${n} game${n === 1 ? '' : 's'}`, lines: v.games.slice(-4).map(g => { const w = g.winner, l = 1 - w; return `${label(g.teams[w])} ${g.score[w]}-${g.score[l]} ${label(g.teams[l])}`; }) };
}
export { cardText };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only a plain host name (optionally with a port) is ever put into a link; anything else falls back to a relative one.
export const safeOrigin = req => {
  const h = String((req.headers || {})['x-forwarded-host'] || (req.headers || {}).host || '').split(',')[0].trim();
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(h) ? `${/^(localhost|127\.|\[)/.test(h) ? 'http' : 'https'}://${h}` : '';
};
const meta = (o, token, v) => {
  const p = preview(v), url = `${o}/r/${token}`, img = `${url}/card.png`;
  return `<meta name="description" content="${esc(p.description)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Dink Score">
<meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(p.title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(p.title)}"><meta name="twitter:description" content="${esc(p.description)}"><meta name="twitter:image" content="${esc(img)}">`;
};
const when = ms => `<time datetime="${new Date(ms).toISOString()}">${esc(DAY(ms))}</time>`;
const line = (g, i) => `<div class="rs-line ${g.winner === i ? 'win' : ''}" style="--c:var(${i ? '--green' : '--blue'})"><span class="tick"></span><span class="who">${esc(label(g.teams[i]))}</span><span class="pts num">${g.score[i]}</span></div>`;
const head = (title, o, token, v, noindex = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0F241E">
<script src="/analytics.js"></script><script defer src="/_vercel/insights/script.js"></script>
<title>${esc(title)}</title><link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
${v ? meta(o, token, v) : ''}
<link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/r.css"></head>`;

// The page itself: readable with no script at all; /r.js only draws the score-flow chart from the embedded numbers.
export function pageHTML(v, token, origin) {
  const p = preview(v);
  let body;
  if (v.kind === 'game') {
    body = `<p class="rs-brand">Dink Score \u00b7 ${v.mode === 'singles' ? 'singles' : 'doubles'}</p><h1>${esc(p.title)}</h1>
<p class="rs-meta">${when(v.endedAt)} \u00b7 to ${v.target}, win by ${v.winBy} \u00b7 ${v.scoring === 'rally' ? 'rally scoring' : 'side-out scoring'}</p>
<section class="rs-card" aria-label="Final score">${line(v, 0)}${line(v, 1)}</section>
${v.flow ? `<section class="rs-card"><h2>Score flow</h2><div id="rs-chart"></div><p class="rs-note">${v.flow.best ? `Longest run: ${v.flow.best.n} unanswered points by ${v.flow.best.team ? 'Green' : 'Blue'}. ` : ''}${v.flow.sideouts.length} side-out${v.flow.sideouts.length === 1 ? '' : 's'} in ${v.flow.n} rallies.</p></section>
<script type="application/json" id="rs-data">${JSON.stringify(v.flow).replace(/</g, '\\u003c')}</script><script src="/r.js" defer></script>` : ''}`;
  } else {
    body = `<p class="rs-brand">Dink Score \u00b7 session</p><h1>${esc(p.title)}</h1><p class="rs-meta">${when(v.from)}</p>
<ol class="rs-games">${v.games.map(g => `<li class="rs-card">${line(g, 0)}${line(g, 1)}</li>`).join('')}</ol>`;
  }
  return `${head(p.title, origin, token, v)}<body><main class="rs">${body}<p class="rs-foot">A read-only result shared from Dink Score. It shows names and scores only.</p></main></body></html>`;
}
export const deadHTML = () => `${head('Link not active \u00b7 Dink Score')}<body><main class="rs"><div class="rs-card"><h1>This link is not active</h1><p class="rs-note">It may have been turned off or replaced. Ask whoever sent it for a current link.</p></div></main></body></html>`;
