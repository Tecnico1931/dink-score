---
name: Dink Score
description: Pickleball scorekeeper and club record for a group of friends.
colors:
  court-blue: "#2B49E6"
  court-green: "#0B8562"
  ball-yellow: "#DDF247"
  ball-ink: "#1B2104"
  court: "#0E7A55"
  court-2: "#0A5E42"
  court-ring: "#0E7A55"
  accent: "#2B49E6"
  accent-text: "#2B49E6"
  ink: "#0E1726"
  muted-slate: "#5D6A7B"
  daylight-grey: "#F2F4F7"
  surface: "#FFFFFF"
  surface-2: "#E9EDF2"
  line: "#DEE4EA"
  up-green: "#0A7656"
  down-red: "#C2372B"
  night-bg: "#0A0F17"
  night-surface: "#131B26"
  night-surface-2: "#1B2532"
  night-ink: "#EEF2F7"
  night-muted: "#8E9BAD"
  night-line: "#243142"
  night-court: "#0F6B4B"
  night-court-2: "#0A4A34"
  night-court-ring: "#19996C"
  night-accent: "#3D5BFF"
  night-accent-text: "#9DB0FF"
  night-court-blue: "#3D5BFF"
  night-court-green: "#0B8562"
  night-up: "#3DD69E"
  night-down: "#FF7A6B"
  night-focus: "#9DB0FF"
typography:
  score:
    fontFamily: "Bricolage Grotesque, Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(112px, 25vh, 240px)"
    fontWeight: 800
    lineHeight: 0.78
    letterSpacing: "-0.045em"
    fontFeature: "tnum"
    fontVariation: "'wdth' 75"
  numeral:
    fontFamily: "Bricolage Grotesque, Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "40px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
    fontVariation: "'wdth' 75"
  wordmark:
    fontFamily: "Bricolage Grotesque, Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 85"
  headline:
    fontFamily: "Bricolage Grotesque, Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 90"
  title:
    fontFamily: "Bricolage Grotesque, Arial Narrow, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 90"
  body:
    fontFamily: "Geist, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Geist, Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
rounded:
  tag: "6px"
  input: "12px"
  segment: "14px"
  button: "16px"
  row: "18px"
  card: "22px"
  tabbar: "26px"
  sheet: "28px"
  court-panel: "30px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "18px"
  section: "22px"
  gutter: "16px"
components:
  button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.daylight-grey}"
    rounded: "{rounded.button}"
    padding: "16px 20px"
  button-ball:
    backgroundColor: "{colors.ball-yellow}"
    textColor: "{colors.ball-ink}"
    rounded: "{rounded.button}"
    padding: "16px 20px"
  button-blue:
    backgroundColor: "{colors.court-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.button}"
    padding: "16px 20px"
  button-soft:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "16px 20px"
  button-danger:
    backgroundColor: "{colors.down-red}"
    textColor: "{colors.surface}"
    rounded: "{rounded.button}"
    padding: "16px 20px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "18px"
  tile:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "16px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "7px 12px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.daylight-grey}"
    rounded: "{rounded.pill}"
    padding: "7px 12px"
  segmented:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.segment}"
    padding: "4px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    padding: "12px 14px"
  tab-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.daylight-grey}"
    rounded: "20px"
    padding: "8px 4px"
  badge-hot:
    backgroundColor: "{colors.ball-yellow}"
    textColor: "{colors.ball-ink}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
---

# Design System: Dink Score

## Overview

**Creative North Star: "The Floodlit Court"**

Dink Score has two lighting conditions. By day, the app is a calm, cool-grey phone UI: white soft-cornered cards on a pale slate ground, ink-dark type, nothing shouting. When a game starts, the scoring screen switches to a floodlit night court. It's a near-black radial field with two big rounded team panels, blue and green, lit from within. The numerals are so large and so squeezed that you can read them from the baseline. Tennis-ball yellow is the floodlight. It marks who is serving, what's live, and who's on top.

The surfaces are calm and tidy. Cards, tiles, chips and rows are restrained, and the numbers do the shouting. The one bold typographic idea runs through everything: the variable grotesque Bricolage Grotesque, squeezed to 75% width and set heavy, for every number that matters. That covers scores, ratings, ranks, totals and forecasts. Geist carries everything else at a comfortable reading size.

It must never read as a corporate fitness app (gradients everywhere, stock athletes, goal-crushing energy). Text never gets small or dense enough to need squinting outdoors.

**Key Characteristics:**
- Two worlds: a calm daylight app and a floodlit night court for scoring.
- Squeezed, heavy, tabular numerals for every number that matters.
- Ball yellow is a light source, used sparingly to mark serve, live and first place.
- Team identity is color: blue for team one, green for team two, carried from setup to scoring to history.
- Generous radii and big tap targets, so everything works one-handed and mid-game.
- Full light, dark and sunlight-contrast modes (`data-theme`, `data-outdoor`), orthogonal to six free per-device court palettes (`data-palette`).

## Colors

The default Court Green palette pairs cool slate neutrals with an emerald court surface, locked team colours and one electric ball yellow. Six selectable court palettes let players match their home court without changing team identity or ball contrast.

### Selectable Court Palettes (`data-palette`)
Stored per device in `pb.display` (never sent to the club, always free, never part of the shop, season pass or mystery box). Public bracket (`/b/<token>`) and league (`/l/<token>`) pages also accept an optional `?palette=` query parameter matching `?theme=`, falling back to Court Green for unknown values.

- **Court Green** (`green`, default — `data-palette` omitted): emerald court (`#0E7A55` → `#0A5E42` light, `#0F6B4B` → `#0A4A34` dark, `#00593F` outdoor).
- **Court Blue** (`blue`): US Open / PPA hard-court cobalt (`#1552A3` → `#0D3A78` light, `#185AB3` → `#0E3C7D` dark, `#0A3580` outdoor).
- **Clay Red** (`clay`): championship terracotta (`#A83224` → `#7E2218` light, `#A33022` → `#751F15` dark, `#8A1C12` outdoor).
- **Indoor Violet** (`violet`): deep indoor court purple (`#5E2CA5` → `#441D7D` light, `#6532AD` → `#47207F` dark, `#4B148C` outdoor).
- **Sunset Orange** (`sunset`): desert burnt copper (`#A64100` → `#7E2F00` light, `#9E3E00` → `#732B00` dark, `#7E2F00` outdoor).
- **Club Slate** (`slate`): monochrome graphite (`#2C384A` → `#1B2330` light, `#303D50` → `#1E2736` dark, `#14181F` outdoor).

Each palette defines verified Light, Dark and Outdoor (`[data-outdoor]`) values for the page neutrals (`--bg`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--line`), hero and New game court surfaces (`--court`, `--court-2`, `--court-ring`), non-team UI accents (`--accent`, `--accent-text`, `--focus`), and the always-dark club TV display (`--dsp-bg`, `--dsp-surface`, `--dsp-ink`, `--dsp-muted`, `--dsp-dim`). Share and year-in-review canvas cards derive their ground, recap hero slab and accent from the active palette's computed tokens at draw time while keeping team panels locked.

### Primary (Team Identity — Locked Across All Palettes)
- **Team 1 Blue** (`--blue` / `--blue-text`): team one's color everywhere teams appear — the team-one court panel (a gradient from `#3452EE` to `#1A2BA6`, `#0A28B8` outdoor), setup stripes, game-record ticks, bracket rows, replay runs, share-card top panel and Apple Watch.
- **Team 2 Green** (`--green`): team two's color everywhere teams appear — the team-two court panel (a gradient from `#0A7656` to `#065A43`, `#00593F` outdoor), setup stripes, game-record ticks, bracket rows, replay runs, share-card bottom panel and Apple Watch.
- Non-team chrome (links, `.btn-accent`, rating chart, logged tags, focus rings, played-day week ticks and reward badges) uses `--accent` / `--accent-text` / `--focus` / `--court` / `--court-ring`, not `--blue` or `--green`.

### Secondary
- **Ball Yellow** (`--ball`: `#DDF247`) with **Ball Ink** (`--ball-ink`: `#1B2104`) text: the floodlight, locked across all six palettes. It marks the serving pill and the serving player's avatar, the first slot of the score call, the live dot, the today outline, the "hot" badge, the toast, the first-place podium ring, the wordmark ball (with `var(--ball-ink)` holes so dark mode stays crisp), and the primary "go" action on the live tile.

### Neutral
- **Ink** (`--ink`): primary text, plus the dark fill for selected chips, the active tab, ink buttons and the live tile.
- **Muted Slate** (`--muted`): secondary text, labels, unselected tabs and losing scores.
- **Ground** (`--bg`): the app background, subtly tinted to match the active court palette.
- **Surface** (`--surface`) / **Surface 2** (`--surface-2`): cards and the recessed fills behind segments, team blocks, tags and stat cells.
- **Line** (`--line`): 1px borders on chips, inputs, the tab bar and the dividers in fact lists.
- **Up / Down** (`--up`, `--down` / `--danger`): rating movement and destructive actions, locked across all palettes.
- The **Night** set (`[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`) remaps every role above per palette. Court borders use `--court-ring` so dark-mode rings stay above 3:1; ball yellow stays the same in every mode.

### Named Rules
**The Floodlight Rule.** Ball yellow means "this one, now": the server, the live game, the leader. It never becomes a general accent, a background wash or decoration. If two things on screen are yellow, one of them is wrong.

**The Team Color Rule.** Blue is always team one and green is always team two, everywhere a team appears, in every court palette. Never swap them, never re-tint team panels with the court palette, and never use team tokens for non-team chrome.

## Typography

**Display Font:** Bricolage Grotesque (variable: opsz, wdth 75–100, wght 400–800), with Arial Narrow as the fallback
**Body Font:** Geist (400–700), with Inter and then the system UI font as fallbacks

**Character:** a squeezed, heavy, slightly quirky grotesque for numbers and headings, paired with a clean neutral sans for reading. The contrast between the two is the whole typographic identity.

### Hierarchy
- **Score** (800, wdth 75, clamp(112px, 25vh, 240px), line-height 0.78): the live score on the court panels. It drops to clamp(84px, 22vh, 200px) on short screens and min(44vh, 17vw) in landscape.
- **Numeral** (800, wdth 75, 20–54px, tabular): every other number that matters, such as tile figures, ratings, ranks, totals, forecasts, score-call digits and game-list points.
- **Wordmark** (800, wdth 85, 28px, or 24px under 380px): "Dink Score" in the top bar.
- **Headline** (700, wdth 90, 26px, balanced wrap): section and sheet headings.
- **Title** (700, wdth 90, 19px): sub-section headings.
- **Body** (Geist 400, 16px, line-height 1.45): everything readable. Inputs stay at 16px so iOS doesn't zoom.
- **Label** (Geist 500, 12–13px, muted): field labels, tile keys, meta lines. Tab labels are 11px, weight 600, the smallest the app goes.

### Named Rules
**The Squeezed Numeral Rule.** Any number a player cares about is set in the display face at 75% width, weight 800, with tabular figures. Numbers never appear in Geist at display size.

**The Outdoor Floor Rule.** Running text is never below 13px, and labels are never below 11px. No text smaller than the existing tab labels.

## Layout

The layout is a single phone column, with a maximum width of 560px centered on larger screens. Side gutters are max(16px, safe-area inset). The vertical rhythm between sections is 22px. Inside cards the spacing runs 6, 10, 14 and 18px. The home screen opens with a hero card (time-of-day greeting, club name, the week's game total and a 7-day bar strip, on the active palette's court gradient (`--court` to `--court-2`, emerald `#0E7A55` to `#0A5E42` in default Court Green light, `#0F6B4B` to `#0A4A34` in dark) with faint court lines and the 3D lime pickleball `icons/pickleball.svg` in the corner), then a two-column tile grid with a 10px gap. The "New game" tile (the same court gradient) sits next to "Log a result" (ball lime, ink text) and opens game setup as a bottom sheet. A short court-colour and lime floodlight glow fades in at the top of every page. Tiles have a minimum height of 132px, and wide tiles span both columns.

A floating tab bar with five tabs (Events appears only in a club) sits fixed at the bottom. It's at most 420px wide and inset 12px above the safe area. The page reserves about 112px plus the safe area at the bottom so content clears it. The page scrolls inside `<body>`, not the window.

The scoring screen is a fixed full-viewport grid: a top bar, then team A's panel, then the net row with the score call, then team B's panel. In landscape at 640px and wider, the panels sit side by side with the net between them. Sheets rise from the bottom, at most 560px wide.

## Elevation & Depth

Daylight is softly lifted. Cards, tiles, rows and totals share one low ambient shadow, and the recessed surface-2 fill handles the second level instead of more shadows. The night court is lit, not lifted. Its depth comes from gradients, inner highlights, glow, and dimming the side that isn't serving.

### Shadow Vocabulary
- **Ambient card** (`0 1px 2px rgb(14 23 38 / .06), 0 8px 24px -12px rgb(14 23 38 / .18)`; dark: `0 1px 0 rgb(255 255 255 / .03) inset, 0 10px 30px -14px rgb(0 0 0 / .7)`): every daylight card, tile and row.
- **Floating chrome** (`0 12px 34px -12px rgb(0 0 0 / .35)`) with an 18px backdrop blur: the tab bar, and the toast with a heavier version of the shadow.
- **Court panel glow** (`0 24px 48px -28px <team color>, inset 0 1px 0 rgb(255 255 255 / .2)`): the colored glow under each team panel.
- **Score call glass** (`inset 0 0 0 1px rgb(255 255 255 / .12), 0 14px 34px -12px rgb(0 0 0 / .9)`) with a 14px blur: the capsule on the net.

### Named Rules
**The One Shadow Rule.** Daylight surfaces use only the ambient card shadow. If you need another level, recess it with surface-2 rather than adding a deeper shadow.

## Shapes

The shapes are soft rounded slabs that get rounder as they get bigger and more important. Tags are 6px, inputs 12px, segments 14px, buttons 16px, list rows 18px, cards and tiles 22px, the tab bar 26px, sheets 28px on the top corners only, and court panels 30px. Chips, badges, pills and the toast are full pills. Avatars are circles. Team markers are small rounded squares, 3px on 10px squares in setup and 2px on 8px ticks in the game list. A 5px left stripe in the team color edges each team block in setup. The ball is a radial-gradient circle with a highlight.

## Components

### Buttons
- **Shape:** soft slab (16px), padding 16px 20px, weight 700, 16px text.
- **Variants:** Ink (the default strong action), Ball (the single most important "go" action), Accent (`.btn-accent`, follows the active court palette), Soft (secondary, on surface-2), Danger, and Line-danger (transparent with a 40% danger border).
- **Press:** scales to 0.985 on press. There are no hover color shifts, because this is a touch-first app.
- **Focus:** a 2px focus-color outline, offset 2px, applied globally.
- **Link:** a text button in `--accent-text`, weight 600. It turns danger red when armed for a delete.

### Chips
- **Style:** a full pill on surface with a 1px line border, 14px weight 500. An optional squeezed rating numeral sits inside in muted.
- **Selected:** an ink fill with background-colored text. Editing mode uses a dashed border and a red ✕.

### Segmented control
A recessed surface-2 track (14px radius, 4px padding). The selected segment lifts to surface with ink text and a hairline shadow. Unselected segments are muted, weight 600.

### Cards / Containers
- **Corner Style:** 22px for cards, tiles and empty states. 18px for game rows and totals. 16px for leaderboard rows.
- **Background:** surface on the daylight ground, with surface-2 cells inside (forecast, month stats).
- **Shadow Strategy:** the ambient card shadow only.
- **Internal Padding:** 16–18px.
- **Tile variants:** the Live tile is ink with a pulsing ball dot and a ball "go" pill. The New game tile uses the active court gradient (`--court` to `--court-2`) with `--on-court` text, and the Log tile uses the ball-lime gradient (`--ball-hi` to `--ball-lo`) with `--ball-ink` text.

### Inputs / Fields
- **Style:** a 12px radius on surface with a 1px line border (team inputs sit borderless on surface-2), padding 12px 14px, 16px text.
- **Focus:** inside a team block, the border turns the team color with a 3px ring at 22% team color. Elsewhere it uses the global focus outline.

### Navigation
A floating glass pill tab bar: surface at 82% opacity with a blur, a 1px line border and a 26px radius. It holds up to five icon-and-label tabs (Play, Leaders, Events, Record, Rules; Events comes and goes) with 22px icons and 11px labels at weight 600. The active tab is an ink pill with background-colored text. Inactive tabs are muted.

### Court Panel (signature)
The team's big tap target. It's a 30px-radius panel with a team gradient, a soft white glow orb and the court panel shadow. It holds the avatars, names, a serve pill, the giant score and a mini serving-box diagram. The non-serving panel dims under a 30% night veil. A tap ripples white, and the score bumps up with a springy entrance (`cubic-bezier(.2, .9, .3, 1.25)`, 0.36s). Team B's panel mirrors team A's vertically.

### Score Call (signature)
A dark glass capsule on the net tape. It holds three 60px cells for the call: server score, receiver score and server number. The first cell is ball yellow. It stacks vertically in landscape.

### Bottom Sheet
A surface sheet rising from the bottom with 28px top corners, a grip bar, 22px top padding and safe-area padding. It sits over a 55% night backdrop with a 4px blur and rises with `cubic-bezier(.2, .8, .2, 1)` in 0.32s.

### Event screen
A full-screen daylight page over the tabs (z-index below the court, above the tab bar; the page behind is `inert` while it is open), opened from the Events tile on Play. It uses only existing parts: a round back button, a 26px headline, white cards with the ambient shadow, the game-row card for every match (blue line for team one, green for team two, squeezed score numerals, a Court tag), segmented controls and chips for setup, and recessed surface-2 fieldsets for hand-picked pairings. Ball yellow keeps its meanings: live (the Live badge) and first place (the leader's rank, the champion's ball). "Score live" is an ink button, so several matches on screen never put two yellow actions side by side.

### Brackets page
Opened from the Brackets button on the event screen, and also the public page at `/b/<token>`. The bracket is one canvas of fixed logical size: a 240 by 112px match card per match, a column per round with a 17px display-weight round title, and 2.5px ink lines for decided paths and dashed muted lines for paths still open. A card has a status strip (Final, Up next with the court, Waiting, Bye), two team rows (a 5px blue or green stripe for team one or two, the pair's names clamped to two lines, a squeezed score numeral) and a feed strip (the round the winner goes to, and the loser's drop in double elimination). The winner is bold with a check mark and a hidden "winner" word, never colour alone; the loser's row is muted. An up-next card gets a 2.5px ink outline (not yellow: it is not a leader), the selected card a double ring. Byes are recessed surface-2 cards. The champion is the ink slab with the ball, the same as the event screen's. Cards are 112px tall and every round is a labelled group, so tap targets stay well over 44px and nothing is canvas-only.

The canvas scrolls and snaps round by round on a phone. Where it fits at 93% of its design size or more it is scaled to fit instead (up to 1.35x in the app, 1.6x on the public page), so text is never below 13px; TV mode fits both width and height and may grow to 3x. Round robin and pool tables use the same squeezed numerals. A match tapped in the app opens as a sticky bottom card holding the event screen's own match row and score entry.

### Rewards
Rewards (Dinks, shop, levels and the like) are a calm extra, never the point of the app. They follow these rules without exception:
- **Off by default, per club.** A club has no rewards until an organizer switches the economy on for it. Off means no reward UI, no reward copy and no reward calls for that club's players.
- **Dinks are play money.** They have no cash value and no purchase path: nothing is sold for real money, and nothing converts Dinks into money, goods or prizes.
- **The shop sells looks at fixed prices.** Dinks can be spent on cosmetic items (a ring around a picture, a colour for paddle thumbnails) at a price shown before the tap and set on the server. An item never changes a rating, a score, a rank, a pairing or any rule, and a fixed-price item is bought once.
- **Odds are always shown.** Any random reward (such as the optional per-club mystery box, off by default behind its own organizer switch) states its cost, daily opening limit, duplicate refund and every rarity's odds in plain words and numbers from the server draw table before the player takes part, draws only on the server, and uses no pity timers, countdowns, animation, sound or confetti.
- **Calm motion.** No flashing and no storm effects (confetti, particle bursts, full-screen takeovers). A reward shows as a quiet card, count-up or check mark, and under `prefers-reduced-motion` it appears with no animation at all.
- **Sound is off until the player turns it on**, per device. A victory sound from the shop is made on the phone itself (no audio files) and plays only after a tap on its play button, or at a win when Win celebration and Celebration sound are on in Settings; never while rewards are hidden.
- **One tap hides it all.** Every player has a single switch that hides all reward UI on their device, and the app works the same without it.
- **Transparent, never pushy.** The player can read their own Dinks history in plain words (Dinks activity), and can pick one shop item as a saving goal that shows only what is missing and an estimate from their own recent earnings, kept on the device. No streak pressure, countdowns or nudges.
- **Rewards never touch the game or app themes.** They never change a rating, a score, a rank, a pairing or a result, they never decide who plays, and court themes are always free for every player (never sold in the shop, season pass or mystery box).

## Do's and Don'ts

### Do:
- **Do** set every score, rating, rank and total in Bricolage Grotesque at 800 weight, 75% width, with tabular figures.
- **Do** keep ball yellow for the server, the live state and first place only.
- **Do** carry team blue and team green consistently from setup to court to history.
- **Do** keep daylight surfaces calm: white cards, one ambient shadow and surface-2 recesses.
- **Do** keep tap targets at 44px or larger and inputs at 16px.
- **Do** honor `prefers-reduced-motion`. The app already strips every animation and transition under it.
- **Do** define every new color across light, dark, outdoor and palette contexts through the `:root` tokens, keeping Team 1/2 and ball yellow locked.

### Don't:
- **Don't** let it look like a corporate fitness app: no gradients on daylight surfaces, no stock athletes, no hype copy. Gradients belong only to the court panels.
- **Don't** let a reward flash, storm or sell: no slot-machine flashing, confetti storms, loot-box theatrics, real-money prices or hidden odds. The Rewards rules above are the whole contract.
- **Don't** set text below 13px for reading or below 11px for labels, and don't pack dense small type that needs squinting outdoors.
- **Don't** add a second accent color, or use ball yellow as a background wash.
- **Don't** add hover-only affordances. Every state must work on touch.
