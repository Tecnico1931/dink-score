// The result card image for a shared result (the Open Graph / Twitter preview): a 1200x630 PNG drawn with a small built-in
// 5x7 pixel font and node:zlib, so there is no image library and no font file. Upper case Latin letters, digits and a few
// marks only: accents are dropped and anything else shows as "?". Pure, no database.
import { deflateSync } from 'node:zlib';

const G = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.###.', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.', 2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '.###.|#...#|....#|..##.|....#|#...#|.###.', 4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '.###.|#....|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...', 8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|....#|.###.',
  '-': '.....|.....|.....|#####|.....|.....|.....', '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#', '.': '.....|.....|.....|.....|.....|.....|..#..',
  ',': '.....|.....|.....|.....|..#..|..#..|.#...', ':': '.....|..#..|.....|.....|.....|..#..|.....', "'": '..#..|..#..|.....|.....|.....|.....|.....',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..', '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  ' ': '.....|.....|.....|.....|.....|.....|.....'
};
const GLYPH = Object.fromEntries(Object.entries(G).map(([k, v]) => [k, v.split('|')]));
const MAP = { '–': '-', '—': '-', '·': '-', '’': "'", '‘': "'" };
// Upper case, accents stripped, anything without a glyph becomes "?".
export const cardText = s => Array.from(String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()).map(c => (MAP[c] || c)).map(c => (GLYPH[c] ? c : '?')).join('').replace(/\s+/g, ' ').trim();

const W = 1200, H = 630;
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const COL = { bg: hex('#0F241E'), panel: hex('#17352C'), win: hex('#1F4A3D'), ink: hex('#EEF2F7'), muted: hex('#8FB3A5'), ball: hex('#DDF247'), blue: hex('#3D5BFF'), green: hex('#12A578') };

function canvas() {
  const px = Buffer.alloc(W * H * 3);
  const rect = (x, y, w, h, c) => {
    for (let j = Math.max(0, y); j < Math.min(H, y + h); j++) for (let i = Math.max(0, x); i < Math.min(W, x + w); i++) { const o = (j * W + i) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
  };
  const width = (t, s) => (t.length ? t.length * 6 * s - s : 0);
  const text = (t, x, y, s, c) => { // top-left origin
    let cx = x;
    for (const ch of t) { GLYPH[ch].forEach((row, r) => { for (let q = 0; q < 5; q++) if (row[q] === '#') rect(cx + q * s, y + r * s, s, s, c); }); cx += 6 * s; }
  };
  // The largest scale (at most `max`) at which `t` fits in `w`; shortened with ".." when even the smallest does not.
  const fit = (t, w, max, min = 3) => {
    for (let s = max; s >= min; s--) if (width(t, s) <= w) return { t, s };
    let u = t; while (u.length > 3 && width(u + '..', min) > w) u = u.slice(0, -1);
    return { t: u.trimEnd() + '..', s: min };
  };
  return { px, rect, text, width, fit };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function png(px) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// One finished game: { kicker, teams: [{name, score, win}, {..}] }
export function gameCard({ kicker, teams }) {
  const c = canvas();
  c.rect(0, 0, W, H, COL.bg);
  c.rect(60, 60, 28, 28, COL.ball);
  c.text(c.fit(cardText(kicker), 1000, 5, 3).t, 110, 62, 5, COL.ball);
  teams.forEach((t, i) => {
    const y = 140 + i * 215, accent = i ? COL.green : COL.blue;
    c.rect(60, y, 1080, 190, t.win ? COL.win : COL.panel);
    c.rect(60, y, 20, 190, accent);
    const name = c.fit(cardText(t.name), 690, 8, 3);
    c.text(name.t, 112, y + 95 - Math.round(3.5 * name.s), name.s, t.win ? COL.ink : COL.muted);
    const sc = String(Math.max(0, Math.trunc(t.score))), s = 20;
    c.text(sc, 1110 - c.width(sc, s), y + 95 - Math.round(3.5 * s), s, t.win ? COL.ball : COL.ink);
  });
  c.text('DINK SCORE', 60, 580, 5, COL.muted);
  return png(c.px);
}

// A session: { kicker, headline, lines: [text] }
export function sessionCard({ kicker, headline, lines }) {
  const c = canvas();
  c.rect(0, 0, W, H, COL.bg);
  c.rect(60, 60, 28, 28, COL.ball);
  c.text(c.fit(cardText(kicker), 1000, 5, 3).t, 110, 62, 5, COL.ball);
  const head = c.fit(cardText(headline), 1080, 18, 6);
  c.text(head.t, 60, 140, head.s, COL.ink);
  lines.slice(0, 4).forEach((l, i) => { const f = c.fit(cardText(l), 1080, 5, 3); c.text(f.t, 60, 330 + i * 56, f.s, COL.muted); });
  c.text('DINK SCORE', 60, 580, 5, COL.muted);
  return png(c.px);
}
