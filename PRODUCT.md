# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Installable PWA (manifest + service worker), used almost entirely on phones. Mobile web, not a native design language.

## Users

A single friend group that plays pickleball together. Whoever is holding a phone keeps score courtside, during and between games, then the group checks results, ratings and standings afterwards.

## Product Purpose

Dink Score keeps pickleball score correctly on court and turns the group's games into a shared, ongoing rivalry off court. Success on court: nobody loses track of the score, the server (1 or 2), which side to serve from, or when to change ends. Success off court: the group keeps coming back to see the leaderboard, ratings and honors move.

## Positioning

A scorekeeper and a club record in one, built for one real group rather than a league or a marketplace. Clubs are shared across everyone's phones with a 6-character code and no accounts. It has its own rating system (Dink Rating, 2.00–8.00) with score forecasts, plus a light game layer (achievements, challenges, levels, seasons, club honors) that exists to make a friend group's rivalry fun.

## Operating Context

- Live scoring during a game: side-out or rally scoring, singles or doubles, to 11, 15 or 21; server and serving-side tracking; change-ends prompts.
- Logging results from other courts, including mid-game.
- Picking saved players by tap; joining a club by code; optional organizer PIN for organizer actions (members list, releasing names).
- Running events (organizer-led, scored by anyone in the club): round robin with rotating partners, pool play then a knockout, single or double elimination, on one or several courts at once, with rotation by fair spread, random draw or the organizer's own picks.
- Reviewing afterwards: Recent games, Record, Leaderboard, Rating over time, Club honors, Past champions.
- First-visit tour and an in-app Rules section explaining scoring, serving, the kitchen, and how Dink Rating works.

## Capabilities and Constraints

- Source is a single file, `dink-score.html` (page body, no `<head>`), wrapped by `build.cjs` into `index.html`/`public/`. Also publishable as a Claude artifact, where club features are hidden.
- Backend: Vercel Functions in `api/` on Neon Postgres. Deployed at dink-score.vercel.app from `main`.
- Offline support via `sw.js` (never caches `/api/`).
- Clubs: anyone with the code can read and add games; deleted games restorable for 30 days.
- The page scrolls inside `<body>` so the bottom tab bar stays fixed.
- Undecided: the user did not mark accounts-free, single-file, offline, or outdoor-readability as binding constraints. They are current facts of the product, not confirmed rules; ask before changing any of them.

## Brand Commitments

- Name: **Dink Score**. Rating is **Dink Rating**.
- Existing icons in `icons/` (SVG + PNG, maskable).
- Voice in shipped copy: plain, friendly, short ("New to Dink Score?", "Leave this game?", "Who are you?").
- Built for friends: no heavy anti-cheat or adversarial friction.

## Evidence on Hand

- Real club data exists in the production database. It must never be modified or deleted during work or testing.
- No testimonials, user counts, press, or other clubs. Do not fabricate any.

## Product Principles

1. Scoring is sacred: on court, the current score, server and serve side must be unmistakable and hard to get wrong. Nothing else may slow down or obscure it.
2. Rivalry is the reason to return: rating, leaderboard and honors deserve real care, not an afterthought.
3. Made for a group of friends: trust over enforcement, warmth over formality, no setup tax.
4. One shared record: every phone in the club should see the same games, players and standings.

## Accessibility & Inclusion

No product-specific standard confirmed. Usage is outdoors on phones, often mid-game, so legibility and large tap targets matter in practice.
