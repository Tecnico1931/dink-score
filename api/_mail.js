// Sign-in email through Resend (https://resend.com), by a plain fetch: no dependency. Off unless RESEND_API_KEY and MAIL_FROM are
// both set; nothing here ever logs or returns the key. Tests replace global fetch, so no test sends a real mail.
const ENDPOINT = 'https://api.resend.com/emails';

export const mailEnabled = (env = process.env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

// One spelling per address: trimmed, NFC, lower case. Returns '' for anything that isn't a plain address.
const EMAIL = /^[^\s@<>(),;:"\\[\]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export function cleanEmail(raw) {
  const e = String(raw == null ? '' : raw).normalize('NFC').trim().toLowerCase();
  return e.length <= 254 && e.split('@')[0].length <= 64 && EMAIL.test(e) ? e : '';
}

export async function sendLoginMail(to, link, env = process.env) {
  const text = `Open this link to sign in to Dink Score:\n\n${link}\n\nIt works once and expires in 15 minutes. If you didn't ask for it, ignore this email: nothing happens unless the link is opened.`;
  const html = `<p>Tap to sign in to Dink Score:</p><p><a href="${link}">Sign in</a></p><p>The link works once and expires in 15 minutes. If you didn't ask for it, ignore this email: nothing happens unless the link is opened.</p>`;
  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: 'Your Dink Score sign-in link', text, html }),
      signal: AbortSignal.timeout(8000)
    });
  } catch { throw new Error('mail: network'); }
  if (!r.ok) throw new Error('mail: ' + r.status); // status only: the body can echo the request
}
