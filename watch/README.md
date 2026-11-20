# Dink Score for Apple Watch

A watch-only SwiftUI app (no iPhone app) that scores a game from your wrist and records it as a pickleball workout. It talks straight to the Dink back end over HTTPS (`/api/live`, the `watch-*` actions in `api/_watch.js`) and is linked to a club by scanning a QR code on the watch from the Dink Score web app on your phone.

```
watch/
  DinkWatch.xcodeproj        watch-only app target (no iOS target), folder-synchronised groups
  DinkWatch/                 SwiftUI: Link, Idle, Score, Game over; workout recording
  Config/                    Info.plist (base URL, background mode) and the HealthKit entitlement
  Packages/DinkCore/         plain Swift, tested on the Mac: PB rules port, QR encoder, API client, outbox, session
```

## What the watch does

| Screen | When | What |
|---|---|---|
| Link | not linked | *Enter a game code* (below the QR) and the QR code as large as the screen allows (a square under the clock, whole-pixel modules on white), then, one scroll or Digital Crown turn below it, the 4 numbers the phone asks for and 6 characters to type if the camera is no use. A new code every ~4.5 minutes. |
| Game code | *Enter a game code* | the 6 characters and 4 numbers the scoring phone shows; links the watch to that one game |
| Idle | linked, no game sent | club name (or *Linked to one game*), *Link another phone* (or *Enter a game code*), *Unlink* |
| Score | a game is attached | the call (serving side first, as the phone says it) with undo beside it, then one full-width button per team that fills the rest of the screen: team name (17 pt, up to two lines), a dot on the serving team, and the score in 68 pt type (shrinks for 3 digits) |
| Game over | the game is won | winner and score, *Finish* (`watch-finish`), *Undo last point*, *Close without saving* |

**One game, no club.** A watch can hold a link to a single game instead of the club: the scoring phone (club sheet, *Apple Watch*, *This game*) shows *a code for the watch to type* (6 characters and 4 numbers, one watch per code, good for 10 minutes), and the watch's *Enter a game code* sends them with `watch-join`. A phone with no club, such as Safari opened from the watch's QR with the iPhone Camera, can instead enter the scoring phone's code on that page (`watch-claim-game`), and the scoring phone can also scan the watch's QR (*Link a watch*, *This game only*). That link reads and scores only that game, is never told the club's name, lasts 8 hours from when the watch collects it (it does not slide), lapses 15 minutes after the watch finishes the game, and ends at once when the phone ends the game or unlinks it. A link icon beside the call marks it on the score screen. The club-wide link and *Send this game to a watch* are unchanged.

Taps are written to an outbox first (`Application Support/outbox.json`), each with its own id, and sent in order. A lost answer is retried with the same id and the server counts that tap once, so the score survives a flaky connection.

**Workout.** When a game appears on the watch an `HKWorkoutSession` (pickleball) starts; it is saved to Health when the game finishes or is left, and dropped if no point was scored. Health asks for permission the first time. It also keeps the app in front instead of the watch falling back to the clock face. Nothing from it is sent to Dink. If you say no to Health the game is scored all the same.

**Finish.** *Finish* calls `watch-finish {opId, game}` (stage 2 of the plan). Until that is deployed the server answers 400 and the watch says *Save this game on your phone*; the phone still has the game.

## Build and check (on a Mac with Xcode)

```sh
# logic: rules, QR matrix and hashes against the JS (golden vectors), client, outbox, session
swift test --package-path watch/Packages/DinkCore

# the same client against the real API handlers over HTTP, on a throwaway in-memory Postgres
npm ci && npm i --no-save @electric-sql/pglite && node tools/watch-swift-check.mjs

# the app compiles for watchOS (no signing, no simulator runtime needed)
xcodebuild -project watch/DinkWatch.xcodeproj -scheme DinkWatch -destination 'generic/platform=watchOS' CODE_SIGNING_ALLOWED=NO build

# after changing api/_pb.js, api/_watchrules.js or the vendored QR library
node tools/pb-vectors.mjs          # rewrites the fixtures; CI runs it with --check
```

The site address is the `DINK_BASE_URL` build setting (default `https://dinkscore.vercel.app`; the QR carries it). Override it for a staging site: `xcodebuild ... DINK_BASE_URL=https://staging.example.test`.

## Stage 4: put it on your own watch

You need a Mac with Xcode, an iPhone paired with the watch, and an Apple ID. A free Apple ID is enough for your own watch; the app then stops opening after 7 days and has to be run again from Xcode (the link should survive a reinstall with the same bundle ID, which stage 4 should confirm). TestFlight or other people's watches need the paid program.

1. Xcode, Settings, Accounts: sign in with your Apple ID. Open `watch/DinkWatch.xcodeproj`, select the DinkWatch target, Signing & Capabilities: tick *Automatically manage signing*, pick your Personal Team, and change the bundle identifier from `com.example.DinkWatch` to one that is yours (for example `com.yourname.dinkwatch`). The HealthKit capability is already in the project; if Xcode will not provision it on a free account, untick HealthKit there (the app then scores without recording a workout).
2. iPhone: Settings, Privacy & Security, Developer Mode on (restarts the phone); the watch needs it too (Settings, Privacy & Security on the watch). Connect the iPhone to the Mac; Xcode lists the watch.
3. Choose the watch as the run destination and press Run. Trust the developer profile if the watch asks.
4. On the watch the Link screen shows a QR code. On the phone open Dink Score, Club, Apple Watch, *Link a watch* (stage 2), scan it and type the 4 numbers. (Typing the 6 characters also works.)
5. Play a game: taps, undo, a point with the watch in airplane mode and then back online, finish. Check that Health has a pickleball workout, and whether the app stays in front while you play (the stage 3 risk in the design report).
6. Re-run from Xcode within 7 days (free account).

## Not done here, deliberately

- Not run on a real watch. It was run in the watchOS 27 simulator against the real API handlers on throwaway PGlite (`DINK_BASE_URL=http://127.0.0.1:<port>`, unsigned build): `docs/01-link.png` to `04-gameover.png` (46 mm; `01-link` and `03-score` also at 40 mm and 49 mm as `*-40mm.png` and `*-49mm.png`); the QR in each link screenshot decodes to the pairing URL. Taps, the HealthKit prompt and the Keychain on a signed build are untested.
- No app icon yet (needs a 1024 px image); no complications; no league or event scoring; no `scoredBy`.
- Linking makes a registration on the server; the server allows 1500 an hour per network (a flood ceiling: a tournament of 100 watches behind one Wi-Fi, each renewing its 5-minute QR 12 times an hour, uses 1200) and 2000 live QR codes app-wide, and the watch only asks while the Link screen is up.
- CI has no Mac job; the vector check runs in the normal job, the Swift tests are run by hand.
