// Prints a fresh VAPID key pair for push notifications (api/_push.js). Run it yourself and paste the values into Vercel; nothing is written to disk.
//   node tools/vapid-keys.mjs
import { createECDH } from 'node:crypto';
const e = createECDH('prime256v1');
e.generateKeys();
console.log('VAPID_PUBLIC_KEY=' + e.getPublicKey().toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + Buffer.concat([Buffer.alloc(32), e.getPrivateKey()]).subarray(-32).toString('base64url')); // always 32 bytes
console.log('VAPID_SUBJECT=mailto:you@example.com   # replace with a real contact address (or an https:// URL)');
