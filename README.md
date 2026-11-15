# Dink Score

A pickleball scorekeeper you can install on your phone: **https://dinkscore.vercel.app**

- Side-out or rally scoring, singles or doubles, to 11, 15 or 21
- Tracks server 1 and 2, which side to serve from, and when to change ends
- Log results from other courts, even mid-game
- Saved players, so you can pick names with a tap
- Dink Rating: the app's own 2.00–8.00 player rating (new players start at 2.00) with score forecasts and a leaderboard
- Clubs: one shared record of games, players and rankings across everyone's phones, with no accounts
- Club display page: open `/?display=CODE` on a TV or monitor at the courts for a full-screen sign with the club's name, a big QR code (the invite link) and the club code, so new players can join by scanning. There's a link to it in the club sheet, under the invite link
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

### Brackets page and the public link

- **Brackets** (a button on every event) draws the knockout as a real bracket: one column per round, matches as cards joined by lines, byes shown, where each winner (and, in double elimination, each loser) goes next, and the champion at the end. Double elimination shows the winners and losers brackets and the grand final; pool play shows the standings with the cut line and a jump into the knockout; a round robin explains it has no bracket and points to the schedule and standings. Tap a match to score it with the same entry the event page uses; results appear in the next round without a reload.
- **Phone, laptop, TV:** one layout. On a phone the rounds scroll sideways and snap; where the whole bracket fits at a readable size (text is never drawn below 93% of its design size) it is scaled to fit instead.
- **Share bracket** (organizers) makes an unguessable public link, `https://dinkscore.vercel.app/b/<token>`, that shows the bracket, standings and champion with no editing, no club and no way into the rest of the app. It refreshes by itself every few seconds (paused while the tab is hidden) and shows when it last changed. `?tv=1`, or the TV mode button (or the T key), hides everything but the bracket and fits it to the screen. Organizers can replace the link (the old one stops working) or stop sharing, and deleting the event ends it.
- The link is a 192-bit random token stored in `events.share_token`. `GET /api/bracket?token=...` answers only from `publicView()` in `api/_share.js`, a field-by-field allow-list, so nothing private (club code, PIN, owner token, draw seed, game ids) can be added to the response by accident. Bad, revoked and deleted tokens all get the same 404, and good answers are cached for 5 seconds at the edge so a screen that polls is cheap.

## Tests

```bash
npm test                                              # rotation, schedule, bracket, event and DUPR export logic (no database)
npm i --no-save @electric-sql/pglite && node tools/api-check.mjs   # the events API against a throwaway in-memory Postgres
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
