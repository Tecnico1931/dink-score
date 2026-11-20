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
| Link | not linked | QR code, 4 numbers the phone asks for, and 6 characters to type if the camera is no use. A new code every ~4.5 minutes. |
| Idle | linked, no game sent | club name, *Link another phone*, *Unlink* |
| Score | a game is attached | the call (serving side first, as the phone says it), a big button per team, undo, a sync dot |
| Game over | the game is won | winner and score, *Finish* (`watch-finish`), *Undo last point*, *Close without saving* |

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

- Not run on a real watch. It was run in the watchOS 27 simulator against the real API handlers on throwaway PGlite (`DINK_BASE_URL=http://127.0.0.1:<port>`, unsigned build): `docs/01-link.png` to `04-gameover.png`; the QR in `01-link.png` decodes to the pairing URL. Taps, the HealthKit prompt and the Keychain on a signed build are untested.
- No app icon yet (needs a 1024 px image); no complications; no league or event scoring; no `scoredBy`.
- Linking makes a registration on the server; the server allows 10 an hour per network, and the watch only asks while the Link screen is up.
- CI has no Mac job; the vector check runs in the normal job, the Swift tests are run by hand.
