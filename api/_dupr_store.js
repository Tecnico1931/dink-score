// DUPR tables. Created only when DUPR is switched on (see enabled() in _dupr.js), so a deployment without DUPR keys
// never touches its database for this. Additive and safe to repeat, like ensureSchema() in _db.js.
import { db } from './_db.js';

let ready = null;
export function ensureDuprSchema() {
  if (!ready) {
    const q = db();
    ready = (async () => {
      // Who a saved player is on DUPR. Set only by the SSO link flow, never typed in. No tokens or passwords are stored.
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS dupr_id text`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS dupr_linked_at timestamptz`;
      await q`ALTER TABLE roster ADD COLUMN IF NOT EXISTS dupr_snapshot jsonb`; // {at, rating:{doubles,singles}, provisional, basic, needsRelink}
      await q`CREATE UNIQUE INDEX IF NOT EXISTS roster_dupr_id ON roster (club, dupr_id) WHERE dupr_id IS NOT NULL`;
      // What was sent to DUPR for each event match. Written as 'pending' before DUPR is called, so a lost reply can be retried
      // with the same identifier. Never touches `games`.
      await q`CREATE TABLE IF NOT EXISTS dupr_matches (
        club text NOT NULL REFERENCES clubs(code) ON DELETE CASCADE,
        game_id text NOT NULL,
        revision int NOT NULL DEFAULT 1,
        identifier text NOT NULL UNIQUE,
        match_code text,
        hashed_code text,
        status text NOT NULL DEFAULT 'pending',
        error text,
        payload_hash text,
        payload jsonb,
        attempts int NOT NULL DEFAULT 0,
        lease_at timestamptz,
        sent_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (club, game_id)
      )`;
      await q`CREATE TABLE IF NOT EXISTS dupr_state (k text PRIMARY KEY, v jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now())`;
    })().catch(err => { ready = null; throw err; });
  }
  return ready;
}

// Lower-case player name -> DUPR id, for the club's linked players.
export async function linkMap(sql, club) {
  const rows = await sql`SELECT name_key, dupr_id FROM roster WHERE club = ${club} AND dupr_id IS NOT NULL`;
  return new Map(rows.map(r => [r.name_key, r.dupr_id]));
}

// Sending is paused club-wide-and-beyond after DUPR answers 403 or 417 (the key lacks permission, or the account expired).
// It lifts itself after an hour so a fix on DUPR's side takes effect without a redeploy; the next send simply tries again.
const PAUSE_MS = 60 * 60 * 1000;
export async function getPause(sql) {
  const [row] = await sql`SELECT v, at FROM dupr_state WHERE k = 'pause' AND at > now() - interval '60 minutes'`;
  return row ? { reason: row.v.reason, status: row.v.status || null, at: new Date(row.at).getTime(), until: new Date(row.at).getTime() + PAUSE_MS } : null;
}
export async function setPause(sql, reason, status) {
  await sql`INSERT INTO dupr_state (k, v, at) VALUES ('pause', ${JSON.stringify({ reason: String(reason).slice(0, 200), status: status || null })}::jsonb, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, at = now()`;
}
