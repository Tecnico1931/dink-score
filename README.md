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
- Offline support and a first-visit tour

## Events: tournaments and rotating doubles

Open **Events** from the Play tab (in a club). An organizer starts an event; anyone in the club scores its matches, each on its own court, with the usual live scoring screen or by typing in a final score.

- **Formats:** round robin, round robin then a knockout, single elimination, double elimination.
- **Partners:** rotate every round (the 8-player, 2-court rotation gives every pair exactly one game together and two against), or fixed teams.
- **Rotation modes:** *fair rotation* spreads partners and opponents as evenly as it can; *random draw* mixes it up every round; *I pick* gives you a suggested round to change and open. Any round nobody has scored yet can be re-paired by hand.
- **More players than courts:** extra players sit out in turn (nobody sits out twice more than anyone else).
- **Courts:** up to 8, played at the same time. In a bracket the next ready match takes the next free court.
- **Record:** each finished match is saved once to the club's games (its id comes from the event and match), so ratings, the leaderboard and history count it exactly once. Fixing a score in the event fixes the game too.
- **Organizers only:** creating an event, planning rounds, changing pairings, starting the knockout and fixing scores need the creating phone or the organizer PIN, like the shop settings. Everyone else can watch and score.
- **Export for DUPR:** on a finished event, organizers get *Export for DUPR* (a CSV download) and *Copy results* (plain text), one row per completed match with a clear winner of at least 6 points. Anything left out (not played, tied, winner under 6) is listed on screen with the reason. The columns are a generic layout defined in one place (`DUPR_COLUMNS` in `dupr-export.js`), **not** DUPR's official club import template, which could not be read; compare with the template downloaded from DUPR and adjust. Names only, no DUPR IDs. It is built in the browser from what the organizer already sees.

## DUPR rating (self-reported)

A player can add an optional DUPR rating (2.000 to 8.000) to their profile for reference inside the club. It is stored on the saved player (`roster.dupr_rating`), labelled "self-reported, not verified", visible to everyone in the club, and never sent to DUPR. It does not feed the Dink Rating, XP, achievements, leaderboard order or event seeding. Only that name's phone or an organizer can set or clear it; releasing a name clears it. It is not stored as a DUPR ID, name, link or password. Validation lives in `api/_dupr.js`. Any public or spectator view (such as a shared bracket) must not include it.

### Brackets page and the public link

- **Brackets** (a button on every event) draws the knockout as a real bracket: one column per round, matches as cards joined by lines, byes shown, where each winner (and, in double elimination, each loser) goes next, and the champion at the end. Double elimination shows the winners and losers brackets and the grand final; pool play shows the standings with the cut line and a jump into the knockout; a round robin explains it has no bracket and points to the schedule and standings. Tap a match to score it with the same entry the event page uses; results appear in the next round without a reload.
- **Phone, laptop, TV:** one layout. On a phone the rounds scroll sideways and snap; where the whole bracket fits at a readable size (text is never drawn below 93% of its design size) it is scaled to fit instead.
- **Share bracket** (organizers) makes an unguessable public link, `https://dinkscore.vercel.app/b/<token>`, that shows the bracket, standings and champion with no editing, no club and no way into the rest of the app. It refreshes by itself every few seconds (paused while the tab is hidden) and shows when it last changed. `?tv=1`, or the TV mode button (or the T key), hides everything but the bracket and fits it to the screen. Organizers can replace the link (the old one stops working) or stop sharing, and deleting the event ends it.
- The link is a 192-bit random token stored in `events.share_token`. `GET /api/bracket?token=...` answers only from `publicView()` in `api/_share.js`, a field-by-field allow-list, so nothing private (club code, PIN, owner token, draw seed, game ids) can be added to the response by accident. Bad, revoked and deleted tokens all get the same 404, and good answers are cached for 5 seconds at the edge so a screen that polls is cheap.


## DUPR link and send (built, switched off)

Lets a saved player connect their DUPR account, shows their DUPR rating, and lets an organizer send finished event matches to DUPR. **It is invisible and inert until the server has DUPR keys**: `GET /api/dupr` answers `{enabled:false}`, every other DUPR action answers 404, no DUPR tables are created, and the app looks exactly as it did. It is separate from the self-reported rating above. **Real DUPR behaviour is unverified until DUPR issues UAT keys;** everything was built from DUPR's public OpenAPI specs and docs and tested only against a local mock (`tools/dupr-mock.mjs`).

**Turning it on (the captain):** get UAT keys from DUPR (tech@mydupr.com), then in Vercel set `DUPR_CLIENT_KEY` and `DUPR_CLIENT_SECRET` (and `DUPR_ENV=uat`, the default; `prod` only once DUPR approves production). Redeploy. Do UAT first; switch to production keys and `DUPR_ENV=prod` only after the checks below. Unsetting either key turns everything off again.

- **Link:** a player opens their profile, taps Connect DUPR and signs in inside DUPR's own login iframe (DUPR forbids typing IDs). The browser passes the sign-in token to `api/dupr.js` (`link`), which checks the phone claimed that name (or an organizer), asks DUPR who the token belongs to, and stores only `roster.dupr_id`, the link time and a small rating snapshot. The sign-in token is used once and **never stored**. One DUPR account links to one name per club. Unlink deletes the stored ID and rating.
- **Ratings:** shown as "DUPR 3.52 doubles / 3.61 singles", labelled as DUPR's. Refresh reads DUPR at most every 15 minutes per player; a 403 or lost consent asks the player to connect again. DUPR numbers never feed the Dink Rating, Dinks, achievements or leaderboard order.
- **Send to DUPR:** organizers only. The review screen lists every finished event match as Ready or Blocked with the reason (a player not linked, tie, winner under 6, a player twice). Nothing is sent until the organizer ticks the confirm box and taps Send; it is never automatic. Ready matches go to `POST /match/v1.0/batch` in chunks of 100 (identifier `dink-<club>-<gameId>-r<revision>`, `PARTNER` source, `COMPLETED` only; `TOURNAMENT` for pool or knockout events, otherwise `RECREATIONAL`). Each match is saved as `pending` in `dupr_matches` before DUPR is called, so a retry reuses the same identifier. A score fixed afterwards is sent as an update; a deleted game is removed from DUPR; a restored one goes again as the next revision. A 403 or 417 pauses all sending for an hour. Sending never writes to `games` or touches ratings.
- **Privacy:** the consent note in the Connect screen says what is sent (DUPR IDs, scores, date, event name). DUPR data is kept out of `/api/club`, the events API and anything public. Keep it out of the public bracket serializer (`publicView()` in `api/_share.js`) too.
- **Security:** secrets come only from the environment, are redacted from errors and never reach the browser (it gets the base64 client key for the iframe URL only). The CSP gains `frame-src https://dashboard.dupr.com https://uat.dupr.gg` (via `build.cjs`).

**Test in UAT before trusting it:** (1) whether update takes `matchId` equal to the saved `matchCode` (the spec says `matchId`, the docs say `matchCode`); (2) recovering a lost `matchCode` after a dropped reply (today such a match is recorded as sent without a code and can't be updated from the app); (3) how a restricted partner's player detail behaves for players who have not connected (we treat 403 as "connect again"); (4) the postMessage payload of the login iframe (we accept `userToken` or `accessToken`, only from the DUPR login origin and that iframe), and whether the iframe needs `allow="payment"` (our Permissions-Policy blocks `payment`); (5) the exact response shapes of `/public/user/info`, `/subscription/active` and `GET /user/v1.0/{id}` (the code reads both documented shapes); (6) how DUPR treats `matchPlayType` and whether a winner under 6 points is ever acceptable; (7) the base64 client key in the iframe URL (we URL-encode it).

**Follow-ups, not built:** rating webhooks (Phase 2b), DUPR club matches (`matchSource: CLUB`), forfeits and retirements, removing matches of an event that was deleted.

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
- `api/` holds the Vercel Functions for clubs (`club.js`, `games.js`, `roster.js`, `shop.js`, `events.js`). They use a Neon Postgres database added through the Vercel Marketplace (`DATABASE_URL`). Tables are created on first use; new ones are only ever added, never changed destructively.
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
