# Operations

## CI (`.github/workflows/ci.yml`)
Runs on every PR and push to `main`: `npm test`, the PGlite API checks (`tools/api-check.mjs`, pglite installed in CI), `tools/dupr-check.mjs` (mock only), a `node build.cjs` drift check (fails if generated files differ from what is committed), and, on PRs, `tools/check-version.mjs` (fails when shipped files changed but `sw.js` `VERSION` did not). Locally: `node tools/check-version.mjs origin/main`.

## Error reporting (off by default)
Set `ERROR_REPORT_URL` (an `https://` endpoint that accepts a JSON POST: a Sentry-style relay, a Slack/Discord-compatible webhook proxy, your own collector) in the Vercel project environment. Nothing else to configure; no vendor key is in the repo. Unset = nothing is sent.
- Server: any unhandled 500 in `handler()` posts `{kind:'server', message, stack, at}`.
- Browser: `window` `error` and `unhandledrejection` post to `/api/report`, which forwards `{kind:'client', message, stack, source, line, col, page, at}`. Query strings (which can hold a club code) are stripped; at most 5 reports per page load, 10 per minute per address, 30 per minute per server instance.
- The endpoint is never contacted from the browser, so the CSP is unchanged.

## Nightly database backup (`.github/workflows/backup.yml`)
Runs 03:17 UTC with `pg_dump --format=custom` and keeps the dump as a workflow artifact for 14 days (private to repo collaborators). **It does nothing until the captain adds the repository secret `DATABASE_URL`** (a read-only Neon role is enough; prefer the direct, non-pooled connection string). Without the secret the job prints a notice and succeeds. For longer retention, copy artifacts to storage you own, or raise `retention-days`. Add the secret: Settings -> Secrets and variables -> Actions -> New repository secret. Run once by hand with "Run workflow" to confirm.

## Restore drill (do this once after the first backup, then each quarter)
Never restore over production while testing.
1. Download the artifact from the Actions run and unzip it.
2. Make a scratch database: a new Neon branch/project, or local `createdb dink_restore`.
3. `pg_restore --no-owner --no-privileges --dbname "$SCRATCH_URL" dink-score-YYYY-MM-DD.dump`
4. Check: `psql "$SCRATCH_URL" -c "select count(*) from clubs"` and the same for `games`; counts should match production within the last day's activity.
5. Optional: run the app against it (`DATABASE_URL=$SCRATCH_URL`) with `tools/serve.cjs` and open a known club.
6. Real disaster: create a new Neon database, restore into it, point the Vercel `DATABASE_URL` at it, redeploy. Schema additions are idempotent (`api/_db.js`), so a restore from an older dump self-heals on first request. Record the drill date and result below.

Drill log: _none yet_.

## Uptime (`.github/workflows/uptime.yml`)
Every 30 minutes (GitHub's minimum is ~5; scheduled runs can be delayed) it GETs `/` and `/api/dupr` on `https://dinkscore.vercel.app` (override with repository variable `SITE_URL`). Read-only. A failure marks the run red and GitHub emails the people who enabled Actions notifications. `/api/dupr` without a club code answers 200 (feature off) or 400 (on); only a 5xx or no answer counts as down. For paging or a status page, point a hosted monitor (e.g. UptimeRobot free tier) at the same two URLs.
