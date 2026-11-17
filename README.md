# Dink Score

A pickleball scorekeeper you can install on your phone: **https://dinkscore.vercel.app**

- Side-out or rally scoring, singles or doubles, to 11, 15 or 21
- Tracks server 1 and 2, which side to serve from, and when to change ends
- Log results from other courts, even mid-game
- Saved players, so you can pick names with a tap
- Dink Rating: the app's own 2.00–8.00 player rating (new players start at 2.00) with score forecasts and a leaderboard
- Clubs: one shared record of games, players and rankings across everyone's phones, with no accounts
- Club display page: open `/?display=CODE` on a TV or monitor at the courts for a full-screen sign with the club's name, a big QR code (the invite link) and the club code, so new players can join by scanning. There's a link to it in the club sheet, under the invite link
- Watch scoring (prototype): while a game is scored on a phone, an Apple Watch can send points through Shortcuts. The phone publishes the live game to `api/live.js`; the watch appends point and undo intents; the phone polls every few seconds, applies them with the same scoring rules as a screen tap and republishes. The phone stays the referee, and the setup steps live in the club sheet (Score from your Apple Watch)
- Shared scoring: a club game is held by the server (`api/live.js` actions `rally`/`unrally`, rules ported to `api/_pb.js` and parity-tested against the client's PB in `tools/api-check.mjs`). Any phone or watch holding the game's secret can score; every screen follows the server state, and a version check keeps simultaneous taps in order. The club sheet's **Games going on** view lists the club's live games with players and scores for anyone with the club code, and opens one for scoring with its secret. Older point/undo intents still work: a phone with the game open forwards them as rallies.
- Offline support and a first-visit tour

## Events: tournaments and rotating doubles

Open **Events** from the Play tab (in a club). An organizer starts an event; anyone in the club scores its matches, each on its own court, with the usual live scoring screen or by typing in a final score.

- **Formats:** round robin, round robin then a knockout, single elimination, double elimination.
- **Partners:** rotate every round (the 8-player, 2-court rotation gives every pair exactly one game together and two against), or fixed teams.
- **Rotation modes:** *fair rotation* spreads partners and opponents as evenly as it can; *random draw* mixes it up every round; *I pick* gives you a suggested round to change and open. Any round nobody has scored yet can be re-paired by hand.
- **More players than courts:** extra players sit out in turn (nobody sits out twice more than anyone else).
- **Courts:** up to 8, played at the same time. In a bracket the next ready match takes the next free court.
- **Record:** each finished match is saved once to the club's games (its id comes from the event and match), so ratings, the leaderboard and history count it exactly once. Fixing a score in the event fixes the game too.
- **Organizers only:** creating an event, planning rounds, changing pairings, starting the knockout and fixing scores need the creating phone or the organizer PIN, like the club's other organizer settings. Everyone else can watch and score.
- **Export for DUPR:** on a finished event, organizers get *Export for DUPR* (a CSV download) and *Copy results* (plain text), one row per completed match with a clear winner of at least 6 points. Anything left out (not played, tied, winner under 6) is listed on screen with the reason. The columns are a generic layout defined in one place (`DUPR_COLUMNS` in `dupr-export.js`), **not** DUPR's official club import template, which could not be read; compare with the template downloaded from DUPR and adjust. Names only, no DUPR IDs. It is built in the browser from what the organizer already sees.

## DUPR rating (self-reported)

A player can add an optional DUPR rating (2.000 to 8.000) to their profile for reference inside the club. It is stored on the saved player (`roster.dupr_rating`), labelled "self-reported, not verified", visible to everyone in the club, and never sent to DUPR. It does not feed the Dink Rating, achievements, leaderboard order or event seeding. Only that name's phone or an organizer can set or clear it; releasing a name clears it. It is not stored as a DUPR ID, name, link or password. Validation lives in `api/_dupr.js`. Any public or spectator view (such as a shared bracket) must not include it.

### Brackets page and the public link

- **Brackets** (a button on every event) draws the knockout as a real bracket: one column per round, matches as cards joined by lines, byes shown, where each winner (and, in double elimination, each loser) goes next, and the champion at the end. Double elimination shows the winners and losers brackets and the grand final; pool play shows the standings with the cut line and a jump into the knockout; a round robin explains it has no bracket and points to the schedule and standings. Tap a match to score it with the same entry the event page uses; results appear in the next round without a reload.
- **Phone, laptop, TV:** one layout. On a phone the rounds scroll sideways and snap; where the whole bracket fits at a readable size (text is never drawn below 93% of its design size) it is scaled to fit instead.
- **Share bracket** (organizers) makes an unguessable public link, `https://dinkscore.vercel.app/b/<token>`, that shows the bracket, standings and champion with no editing, no club and no way into the rest of the app. It refreshes by itself every few seconds (paused while the tab is hidden) and shows when it last changed. `?tv=1`, or the TV mode button (or the T key), hides everything but the bracket and fits it to the screen. Organizers can replace the link (the old one stops working) or stop sharing, and deleting the event ends it.
- The link is a 192-bit random token stored in `events.share_token`. `GET /api/bracket?token=...` answers only from `publicView()` in `api/_share.js`, a field-by-field allow-list, so nothing private (club code, PIN, owner token, draw seed, game ids) can be added to the response by accident. Bad, revoked and deleted tokens all get the same 404, and good answers are cached for 5 seconds at the edge so a screen that polls is cheap.


## DUPR link and send (built, switched off)

Lets a saved player connect their DUPR account, shows their DUPR rating, and lets an organizer send finished event matches to DUPR. **It is invisible and inert until the server has DUPR keys**: `GET /api/dupr` answers `{enabled:false}`, every other DUPR action answers 404, no DUPR tables are created, and the app looks exactly as it did. It is separate from the self-reported rating above. **Real DUPR behaviour is unverified until DUPR issues UAT keys;** everything was built from DUPR's public OpenAPI specs and docs and tested only against a local mock (`tools/dupr-mock.mjs`).

**Turning it on (the captain):** get UAT keys from DUPR (tech@mydupr.com), then in Vercel set `DUPR_CLIENT_KEY` and `DUPR_CLIENT_SECRET` (and `DUPR_ENV=uat`, the default; `prod` only once DUPR approves production). Redeploy. Do UAT first; switch to production keys and `DUPR_ENV=prod` only after the checks below. Unsetting either key turns everything off again.

- **Link:** a player opens their profile, taps Connect DUPR and signs in inside DUPR's own login iframe (DUPR forbids typing IDs). The browser passes the sign-in token to `api/dupr.js` (`link`), which checks the phone claimed that name (or an organizer), asks DUPR who the token belongs to, and stores only `roster.dupr_id`, the link time and a small rating snapshot. The sign-in token is used once and **never stored**. One DUPR account links to one name per club. Unlink deletes the stored ID and rating.
- **Ratings:** shown as "DUPR 3.52 doubles / 3.61 singles", labelled as DUPR's. Refresh reads DUPR at most every 15 minutes per player; a 403 or lost consent asks the player to connect again. DUPR numbers never feed the Dink Rating, achievements or leaderboard order.
- **Send to DUPR:** organizers only. The review screen lists every finished event match as Ready or Blocked with the reason (a player not linked, tie, winner under 6, a player twice). Nothing is sent until the organizer ticks the confirm box and taps Send; it is never automatic. Ready matches go to `POST /match/v1.0/batch` in chunks of 100 (identifier `dink-<club>-<gameId>-r<revision>`, `PARTNER` source, `COMPLETED` only; `TOURNAMENT` for pool or knockout events, otherwise `RECREATIONAL`). Each match is saved as `pending` in `dupr_matches` before DUPR is called, so a retry reuses the same identifier. A score fixed afterwards is sent as an update; a deleted game is removed from DUPR; a restored one goes again as the next revision. A 403 or 417 pauses all sending for an hour. Sending never writes to `games` or touches ratings.
- **Privacy:** the consent note in the Connect screen says what is sent (DUPR IDs, scores, date, event name). DUPR data is kept out of `/api/club`, the events API and anything public. Keep it out of the public bracket serializer (`publicView()` in `api/_share.js`) too.
- **Security:** secrets come only from the environment, are redacted from errors and never reach the browser (it gets the base64 client key for the iframe URL only). The CSP gains `frame-src https://dashboard.dupr.com https://uat.dupr.gg` (via `build.cjs`).

**Test in UAT before trusting it:** (1) whether update takes `matchId` equal to the saved `matchCode` (the spec says `matchId`, the docs say `matchCode`); (2) recovering a lost `matchCode` after a dropped reply (today such a match is recorded as sent without a code and can't be updated from the app); (3) how a restricted partner's player detail behaves for players who have not connected (we treat 403 as "connect again"); (4) the postMessage payload of the login iframe (we accept `userToken` or `accessToken`, only from the DUPR login origin and that iframe), and whether the iframe needs `allow="payment"` (our Permissions-Policy blocks `payment`); (5) the exact response shapes of `/public/user/info`, `/subscription/active` and `GET /user/v1.0/{id}` (the code reads both documented shapes); (6) how DUPR treats `matchPlayType` and whether a winner under 6 points is ever acceptable; (7) the base64 client key in the iframe URL (we URL-encode it).

**Follow-ups, not built:** rating webhooks (Phase 2b), DUPR club matches (`matchSource: CLUB`), forfeits and retirements, removing matches of an event that was deleted.

## Import players and teams from a sheet

On **New event**, an organizer can tap *Import players and teams from a sheet* instead of picking players one by one. Nothing is created until the preview is checked and confirmed.

**Three ways in** (no Google login, OAuth or API key anywhere):

1. **Google Sheets link.** In the sheet choose **Share**, then **General access: Anyone with the link** (Viewer). A sheet *published to the web* works too. Paste the address. If the sheet has several tabs, open the tab with the players first, so the link carries its `gid`. The server reads the sheet once, as CSV, when the organizer taps *Read the sheet*.
2. **Paste CSV**, or rows copied straight from a spreadsheet (tab-separated is detected).
3. **Upload a .csv** (in Google Sheets: File, Download, Comma-separated values).

**Columns.** The first row names them, in any order and capitals, spaces and punctuation ignored; other columns are ignored. The app says which layout it detected:

| One row per player | One row per team |
| --- | --- |
| `Player` (required) | `Player 1`, `Player 2` (required) |
| `Team` (rows sharing a name form a team) | `Team` |
| `DUPR ID`, `Logo URL` (optional) | `DUPR ID 1`, `DUPR ID 2`, `Logo URL` (optional) |

The screen offers a downloadable template for each layout; the accepted headers are defined in one place (`COLUMNS` in `sheet-import.js`), so the screen, the templates and the parser agree.

**Preview.** Rows are grouped into teams, with a message beside each problem: missing or duplicate names, a team without exactly 2 players, a bad DUPR ID or logo link, too few players or teams for the format. Fix them in the preview or in the sheet and read it again. Up to 200 rows, 512 KB and 32 players.

**What gets created.** Fixed-team round robin and single/double elimination use the sheet's teams, in sheet order (the first team is seed 1). With rotating partners there are no fixed teams, so only the players are added, and the preview says so. A sheet with no team column still works: the app pairs the players as set on the form. A team shows its name and logo, or its two players when it has neither, in the event, the standings, the Brackets page and the public page.

**DUPR IDs** are an optional, private reference: uppercase, 5 to 10 letters and numbers, stored in their own column (`events.refs`), never inside the event. Only organizers can read them (the *Teams* card on the event). They are not checked with DUPR, never sent to DUPR, never on the public bracket page or any other response, and are labelled *reference only, unverified*, because DUPR does not accept typed-in IDs for results. Linking players for real is a separate feature.

**Logos** are `https` links only (no `http`, `data:`, `javascript:`, credentials, ports, IP addresses or local names, 300 characters at most). The server never fetches them. Browsers load them with `referrerpolicy="no-referrer"`, lazily, in a fixed box with `object-fit: contain`, and the initials show if one fails. **Privacy tradeoff:** the Content-Security-Policy now allows images from any `https` site (`img-src https:`), so anyone who opens a page showing a logo, including spectators on the public bracket page, makes their browser contact the logo's website. Logos on the public page are on by default for imported events and organizers can switch them off per event (the *Team logos on the public page* card, or the checkbox in the preview). Team names are public either way.

**Fetching the sheet (SSRF hardening).** `api/_gsheet.js` accepts only `https://docs.google.com/spreadsheets/d/<id>/...` links (published `/d/e/...` links too), takes only the sheet id and tab number from them and rebuilds the CSV address itself, follows at most 4 redirects by hand and only to `docs.google.com` or `*.googleusercontent.com`, sends no cookies or credentials, stops at 512 KB or 8 seconds, and requires a CSV answer. It is organizer-only and limited to 20 reads a minute per club. Tests never call Google: `fetch` is injected or stubbed.

## Tests

```bash
npm test                                              # rotation, schedule, bracket, event and DUPR export logic (no database)
npm i --no-save @electric-sql/pglite && node tools/api-check.mjs   # the events API against a throwaway in-memory Postgres
node tools/dupr-check.mjs                                          # the DUPR API against that Postgres and a local mock DUPR
node tools/dupr-preview.mjs 4180 [off]                             # the built site with the real API and the mock, for driving the DUPR screens in a browser
```

`npm test` uses Node's built-in test runner and needs nothing installed. `tools/api-check.mjs` never touches a real database: it answers the Neon driver from an in-memory Postgres.

## How it's built

- `dink-score.html` is the app source. It's written as a page body, without `<head>`, so it can also be published as a Claude artifact (where club features are hidden).
- `build.cjs` wraps it into `index.html` with the web app manifest and offline support, and copies the site into `public/` for Vercel.
- `api/` holds the Vercel Functions for clubs (`club.js`, `games.js`, `roster.js`, `players.js`, `events.js`). They use a Neon Postgres database added through the Vercel Marketplace (`DATABASE_URL`). Tables are created on first use; new ones are only ever added, never changed destructively.
- Event logic lives in plain modules next to the functions (files starting with `_` are not routes): `_rotation.js` (partner rotation), `_schedule.js` (teams, round robin, standings), `_bracket.js` (elimination brackets), `_events.js` (an event's life from creation to champion). `test/` covers them.
- `sw.js` is the service worker. Change its `VERSION` whenever `index.html` changes. It never caches `/api/`.
- `icons/` holds the home-screen icons.

Anyone with a club's 6-character code can read and add that club's games. Deleted games can be restored for 30 days.

The old GitHub Pages address forwards to the Vercel site and carries each device's saved games over in the link.

## Updating the site

```bash
node build.cjs
```

Then bump `VERSION` in `sw.js`, commit, and push. Vercel deploys from GitHub automatically.

## Passkey accounts on more than one address

The same deployment can be served from several addresses. Set `WEBAUTHN_ORIGINS` in Vercel to a comma-separated list of origins, for example `https://dinkscore.vercel.app,https://dink.raulesantos.com`. Each request's `Origin` header must be in the list and its hostname is the passkey RP ID. Unset, the single legacy pair applies (`WEBAUTHN_RP_ID`, default `dinkscore.vercel.app`, and `WEBAUTHN_ORIGIN`).

| Variable | Meaning |
| --- | --- |
| `WEBAUTHN_ORIGINS` | Allowed page origins, comma-separated. Unset = legacy single address. |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | Legacy pair; `WEBAUTHN_RP_ID` also names the address passkeys made before this setting belong to. |

A passkey works only on the address it was made on (a WebAuthn rule); sessions are per address, account data is shared. From a signed-in address, "Get a code to add a passkey on another address" makes a 5-minute one-time code to enter on the other address. Invite links, QR codes, share links and the TV page use the address the page is open on.

## Legal and privacy

- `/privacy` and `/terms` are static pages (`privacy.html`, `terms.html`). They are **drafts for the site owner to review, not legal advice**, and have placeholders for the contact email and governing law.
- `SECURITY.md` and `/.well-known/security.txt` describe private vulnerability reporting. **Owner action:** enable *Private vulnerability reporting* in the repository settings. Dependabot is configured in `.github/dependabot.yml`; also enable Dependabot security updates in settings.
- Fonts (Bricolage Grotesque and Geist, both under the SIL Open Font License) are self-hosted in `fonts/`; no page contacts Google Fonts.
- **TODO (licence): there is no `LICENSE` file.** Neither this fork nor the upstream project has one. Do not add one until the upstream author has given written permission or chosen a licence; then add it here.
