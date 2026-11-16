// Moving to a new phone, without accounts.
// POST /api/transfer {action: 'create', id, blob}            -> stores an encrypted bundle of this phone's club tokens for 10 minutes
// POST /api/transfer {action: 'claim', id}                   -> hands the bundle to the new phone once, then deletes it
// POST /api/transfer {action: 'recovery-create', code, ownerToken} -> new printable creator recovery code (replaces any earlier one)
// POST /api/transfer {action: 'recovery-redeem', code, recovery}   -> trades a recovery code for a fresh creator token (single use)
// Nothing here can read a phone's tokens: the bundle is encrypted on the phone with a key derived from the transfer code.
import { db, handler, send, readBody, fail, cleanCode, clientIp, newOwnerToken, hashToken, tokenMatches } from './_db.js';
import { TRANSFER_TTL_MIN, RECOVERY_TTL_DAYS, newRecoveryCode, cleanRecoveryCode, hashRecovery, recoveryMatches, cleanTransferId, idHash, cleanBlob } from './_transfer.js';

const MAX_MADE = 10;       // transfer codes one network address may create per hour
const MAX_WRONG = 10;      // wrong transfer or recovery codes per network address per 15 minutes
const MAX_WRONG_CLUB = 20; // wrong recovery codes per club per 15 minutes, from every address together

// Records an attempt, then counts; a right answer removes its own mark so only misses add up. See requirePin in _db.js.
async function attempt(sql, key, limit, minutes, message) {
  const [{ id }] = await sql`INSERT INTO lookup_fails (ip) VALUES (${key}) RETURNING id`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM lookup_fails WHERE ip = ${key} AND at > now() - make_interval(mins => ${minutes})`;
  if (n > limit) { await sql`DELETE FROM lookup_fails WHERE id = ${id}`; throw fail(429, message); }
  return id;
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw fail(405, 'Use POST.');
  const sql = db();
  const body = await readBody(req);
  const ip = clientIp(req);

  if (body.action === 'create') {
    const id = cleanTransferId(body.id), blob = cleanBlob(body.blob);
    if (!id || !blob) throw fail(400, 'That transfer was not valid.');
    await attempt(sql, 'xfer-new:' + ip, MAX_MADE, 60, 'Too many transfer codes from this connection. Try again in an hour.');
    await sql`DELETE FROM transfers WHERE expires_at < now()`;
    await sql`DELETE FROM lookup_fails WHERE at < now() - interval '1 day'`;
    await sql`INSERT INTO transfers (id_hash, blob, expires_at) VALUES (${idHash(id)}, ${blob}, now() + make_interval(mins => ${TRANSFER_TTL_MIN})) ON CONFLICT DO NOTHING`;
    return send(res, 200, { ok: true, expiresInMinutes: TRANSFER_TTL_MIN });
  }

  if (body.action === 'claim') {
    const id = cleanTransferId(body.id);
    if (!id) throw fail(400, 'That code is not valid.');
    const mark = await attempt(sql, 'xfer:' + ip, MAX_WRONG, 15, 'Too many wrong codes. Wait 15 minutes and try again.');
    // One statement both checks and deletes, so a code can only ever be used once.
    const rows = await sql`DELETE FROM transfers WHERE id_hash = ${idHash(id)} AND expires_at > now() RETURNING blob`;
    if (!rows.length) throw fail(404, 'That code is wrong, already used, or has expired. Make a new one on the old phone.');
    await sql`DELETE FROM lookup_fails WHERE id = ${mark}`;
    return send(res, 200, { ok: true, blob: rows[0].blob });
  }

  if (body.action === 'recovery-create') {
    const code = cleanCode(body.code);
    const [club] = await sql`SELECT code, owner_hash FROM clubs WHERE code = ${code}`;
    if (!club || !tokenMatches(club.owner_hash, body.ownerToken)) throw fail(403, 'Only the phone that created this club can make its recovery code.');
    const recovery = newRecoveryCode();
    const [row] = await sql`UPDATE clubs SET recovery_hash = ${hashRecovery(recovery.replace(/-/g, ''))}, recovery_expires = now() + make_interval(days => ${RECOVERY_TTL_DAYS}) WHERE code = ${code} RETURNING recovery_expires`;
    return send(res, 200, { ok: true, recovery, expires: row.recovery_expires });
  }

  if (body.action === 'recovery-redeem') {
    const code = cleanCode(body.code), recovery = cleanRecoveryCode(body.recovery);
    const byIp = await attempt(sql, 'recov:' + ip, MAX_WRONG, 15, 'Too many wrong recovery codes. Wait 15 minutes and try again.');
    const byClub = await attempt(sql, 'recovclub:' + code, MAX_WRONG_CLUB, 15, 'Too many wrong recovery codes were tried for this club. Wait 15 minutes and try again.');
    const [club] = await sql`SELECT code, name, pin_hash, recovery_hash FROM clubs WHERE code = ${code} AND recovery_expires > now()`;
    if (!recovery || !club || !recoveryMatches(club.recovery_hash, recovery)) throw fail(403, 'That recovery code is wrong, already used, or has expired.');
    const ownerToken = newOwnerToken();
    // Atomic and single use: only the request that still sees this exact code wins.
    const won = await sql`UPDATE clubs SET owner_hash = ${hashToken(ownerToken)}, recovery_hash = NULL, recovery_expires = NULL WHERE code = ${code} AND recovery_hash = ${club.recovery_hash} RETURNING code`;
    if (!won.length) throw fail(403, 'That recovery code is wrong, already used, or has expired.');
    await sql`DELETE FROM lookup_fails WHERE id IN (${byIp}, ${byClub})`;
    return send(res, 200, { ok: true, ownerToken, club: { code, name: club.name, hasPin: !!club.pin_hash } });
  }

  throw fail(400, 'Unknown action.');
});
