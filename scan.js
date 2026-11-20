// Linking an Apple Watch: reading the code the watch shows. Loaded on demand when the phone taps "Link a watch" (see src/app/watch-link.js),
// so the page itself does not grow. The pure parts (what a scanned or typed code means) are tested in test/watchlink.test.js.
// The camera is read in this page only: no picture is stored or sent anywhere. QR decoding uses the browser's BarcodeDetector where it
// exists and otherwise jsQR 1.4.0 (jsqr.js next to this file: Apache-2.0, see jsqr.LICENSE.txt, byte for byte the published dist/jsQR.js).

// What the watch shows: https://<site>/#watch=<32 hex>, plus 6 typed characters (base32, the same letters as api/_watchrules.js shortCode).
// A link is only taken from this site's own address, so a code that sends the phone somewhere else is ignored.
const HEX32 = /^[0-9a-f]{32}$/;
const SHORT = /^[A-Z2-7]{6}$/;

// The id inside a watch link, or '' when the text is not a link to this site's own watch fragment.
export function pairFromUrl(text, origin) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return ''; }
  if (u.origin !== origin || u.pathname !== '/' || u.search !== '') return '';
  const m = /^#watch=([0-9A-Fa-f]{32})$/.exec(u.hash);
  return m ? m[1].toLowerCase() : '';
}

// What watch-claim takes as `pair`: the 32 hex of a scanned link (or pasted id), or the 6 typed characters. '' when it is neither.
export function cleanPair(text, origin) {
  const raw = String(text || '').trim();
  const fromUrl = pairFromUrl(raw, origin);
  if (fromUrl) return fromUrl;
  if (HEX32.test(raw.toLowerCase())) return raw.toLowerCase();
  const short = raw.toUpperCase().replace(/[\s-]/g, '');
  return SHORT.test(short) ? short : '';
}

// The 4 numbers on the watch: digits only, exactly 4.
export const cleanConfirm = text => { const d = String(text || '').replace(/\D/g, ''); return d.length === 4 ? d : ''; };

export function cameraMessage(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'The camera is blocked for Dink Score. Allow it in your phone settings, or type the code from the watch below.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Type the code from the watch below.';
  return 'The camera could not start. Type the code from the watch below.';
}

export const cameraSupported = () => !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// One frame (an ImageData-like {data, width, height}) through jsQR; the text of the code, or ''.
export function readQr(jsQR, frame) {
  const r = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  return r && typeof r.data === 'string' ? r.data : '';
}

let jsqrLoad = null; // one attempt at a time: a frame loop must not add a script tag every 150 ms
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return jsqrLoad || (jsqrLoad = new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = new URL('jsqr.js', import.meta.url).href;
    s.onload = () => (window.jsQR ? ok(window.jsQR) : no(new Error('The code reader did not load.')));
    s.onerror = () => { jsqrLoad = null; s.remove(); no(new Error('The code reader did not load.')); };
    document.head.appendChild(s);
  }));
}

// Starts the camera on a <video playsinline muted> and looks for a QR code about every 150 ms. `onText(text)` returns true when it took the
// text (the scan then stops); anything else keeps looking. The phone redraws its sheet from time to time, so `attach(video)` points the
// same camera at the new <video>. Resolves to {stop, attach}; rejects with the camera's own error (see cameraMessage).
export async function startScan(video, onText) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  let current = video, timer = null, stopped = false;
  const attach = el => { current = el; if (el && el.srcObject !== stream) { el.srcObject = stream; const p = el.play(); if (p && p.catch) p.catch(() => {}); } };
  const stop = () => {
    stopped = true; clearTimeout(timer);
    for (const t of stream.getTracks()) t.stop();
    if (current) current.srcObject = null;
  };
  try {
    attach(video);
    let detector = null;
    if (typeof BarcodeDetector === 'function') { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
    let jsQR = null;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const look = async () => {
      if (stopped) return;
      try {
        if (current && current.readyState >= 2 && current.videoWidth) {
          let text = '';
          // detect() can also never answer (seen in headless Chrome), so it only gets 400 ms before jsQR takes the frame.
          if (detector) { try { const found = await Promise.race([detector.detect(current), new Promise((_, no) => setTimeout(no, 400))]); text = found.length ? String(found[0].rawValue || '') : ''; } catch { /* no working engine behind it */ } }
          // The native detector is the quick path, but some browsers ship one that never finds anything: jsQR looks at every frame it misses.
          if (!text) {
            jsQR = jsQR || await loadJsQR();
            const k = Math.min(1, 640 / current.videoWidth);
            canvas.width = Math.round(current.videoWidth * k); canvas.height = Math.round(current.videoHeight * k);
            ctx.drawImage(current, 0, 0, canvas.width, canvas.height);
            text = readQr(jsQR, ctx.getImageData(0, 0, canvas.width, canvas.height));
          }
          if (text && !stopped && onText(text)) { stop(); return; }
        }
      } catch { /* a bad frame: try the next one */ }
      if (!stopped) timer = setTimeout(look, 150);
    };
    timer = setTimeout(look, 150);
  } catch (e) { stop(); throw e; }
  return { stop, attach };
}
