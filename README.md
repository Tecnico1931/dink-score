# Dink Score

A pickleball scorekeeper you can install on your phone.

- Side-out or rally scoring, singles or doubles, to 11, 15 or 21
- Tracks server 1 and 2, which side to serve from, and when to change ends
- Saved players, so you can pick names with a tap
- Dink Rating: the app's own 2.00–8.00 player rating with score forecasts and a leaderboard
- Game record, rules reference, and offline support

Games and players are saved in the browser on each device.

## Files

- `dink-score.html` is the app source. It's written as a page body, without `<head>`, so it can also be published as a Claude artifact.
- `build.js` wraps it into `index.html` with the web app manifest and offline support.
- `sw.js` is the service worker. Change its `VERSION` whenever `index.html` changes.
- `icons/` holds the home-screen icons.

## Updating the site

```bash
node build.js
```

Then bump `VERSION` in `sw.js`, commit, and push. GitHub Pages redeploys on its own.
