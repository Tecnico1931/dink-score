# Dink Score

A pickleball scorekeeper you can install on your phone: **https://dinkscore.vercel.app**

- Side-out or rally scoring, singles or doubles, to 11, 15 or 21
- Tracks server 1 and 2, which side to serve from, and when to change ends
- Log results from other courts, even mid-game
- Saved players, so you can pick names with a tap
- Dink Rating: the app's own 2.00–8.00 player rating with score forecasts and a leaderboard
- Clubs: one shared record of games, players and rankings across everyone's phones, with no accounts
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

## Tests

```bash
npm test                                              # rotation, schedule, bracket and event logic (no database)
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
