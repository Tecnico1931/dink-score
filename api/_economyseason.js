// Rewards, seasonal cosmetics (#107; rules in DESIGN.md "Rewards", guard in test/economyguard.test.js).
// Pure: a fixed list of seasonal rings and paddle colours, each sold at one fixed price only while its season is on. Zero randomness, zero
// DB access, and the clock is always passed in (never read here). Nothing here reads or changes a score, a rating, a rank or a pairing.
//
// The season is the CALENDAR season in UTC, by month, the same every year, so every item comes back each year and nothing is permanently missed:
//   spring 1 Mar to 31 May, summer 1 Jun to 31 Aug, autumn 1 Sep to 30 Nov, winter 1 Dec to the last day of Feb (it crosses new year).
// Only BUYING is limited to the window. An owned seasonal item stays owned, wearable and visible to the club after the window closes
// (the shop looks items up in the whole list, see itemById in _economyshop.js). A seasonal item is never in the mystery box or the pass.

export const SEASONS = Object.freeze([
  Object.freeze({ id: 'spring', name: 'Spring Court', months: [2, 3, 4], firstMonth: 2, lastMonth: 4 }),
  Object.freeze({ id: 'summer', name: 'Summer Heat', months: [5, 6, 7], firstMonth: 5, lastMonth: 7 }),
  Object.freeze({ id: 'autumn', name: 'Autumn Clay', months: [8, 9, 10], firstMonth: 8, lastMonth: 10 }),
  Object.freeze({ id: 'winter', name: 'Winter Frost', months: [11, 0, 1], firstMonth: 11, lastMonth: 1 })
]);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// id (letters only after the slot, so the phone's look name stays a plain word), slot, name, price in Dinks, season id. Fixed prices.
export const SEASONAL = Object.freeze([
  Object.freeze({ id: 'frame-spring', slot: 'frame', name: 'Spring Court ring', price: 8, season: 'spring' }),
  Object.freeze({ id: 'frame-heat', slot: 'frame', name: 'Summer Heat ring', price: 8, season: 'summer' }),
  Object.freeze({ id: 'paddle-heat', slot: 'paddle', name: 'Summer Heat paddle', price: 8, season: 'summer' }),
  Object.freeze({ id: 'frame-clay', slot: 'frame', name: 'Autumn Clay ring', price: 8, season: 'autumn' }),
  Object.freeze({ id: 'frame-frost', slot: 'frame', name: 'Winter Frost ring', price: 8, season: 'winter' }),
  Object.freeze({ id: 'paddle-frost', slot: 'paddle', name: 'Winter Frost paddle', price: 8, season: 'winter' })
]);

export const seasonalById = id => SEASONAL.find(i => i.id === id) || null;
export const isSeasonal = item => !!(item && item.season);

function msOf(ts) {
  const ms = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(ms)) throw new Error('seasonFor requires a finite timestamp.');
  return ms;
}

const day2 = n => String(n).padStart(2, '0');
const iso = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${day2(d.getUTCMonth() + 1)}-${day2(d.getUTCDate())}`; };
const lastDayOf = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// The season at `ts` and its window: { id, key (id + the year it began, e.g. 'winter-2026': the key an event schedule is tied to), name, startsOn, endsOn (the last day, inclusive), startMs, endMs (exclusive, UTC midnight after the last day),
// dates (plain words), returns (plain words) }. Pure; the same instant always gives the same answer, whatever the viewer's time zone or DST.
export function seasonFor(ts) {
  const ms = msOf(ts), d = new Date(ms), month = d.getUTCMonth();
  const season = SEASONS.find(s => s.months.includes(month));
  // Winter in January/February began in the previous December.
  const startYear = season.id === 'winter' && month < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const endYear = season.id === 'winter' ? startYear + 1 : startYear;
  const startMs = Date.UTC(startYear, season.firstMonth, 1);
  const lastDay = lastDayOf(endYear, season.lastMonth);
  const endMs = Date.UTC(endYear, season.lastMonth, lastDay + 1);
  const endLabel = season.id === 'winter' ? 'the last day of February' : `${lastDay} ${MONTHS[season.lastMonth]}`;
  return {
    id: season.id, key: `${season.id}-${startYear}`, name: season.name, startsOn: iso(startMs), endsOn: iso(endMs - 86400000), startMs, endMs,
    dates: `1 ${MONTHS[season.firstMonth]} to ${endLabel} (UTC)`,
    returns: `${season.name} returns every ${MONTHS[season.firstMonth]}. Anything you already have stays yours.`
  };
}

// Is this item on sale at `ts`? Permanent items (no season) always are.
export const isAvailable = (item, ts) => isEventItem(item) ? eventOpen(item, ts) : !isSeasonal(item) || seasonFor(ts).id === item.season;

// The plain refusal when a buy is outside the window; says when it is back. Pure.
export function closedMessage(item, ts) {
  if (isEventItem(item)) return eventClosedMessage(item, ts);
  const s = SEASONS.find(x => x.id === item.season);
  return `${item.name} is only in the shop during ${s.name}, from 1 ${MONTHS[s.firstMonth]}. It comes back every year.`;
}

// ---------- Events (WI-12): a dated shelf of limited-time items, on top of the four calendar seasons ----------
// An event is a fixed shelf of items; WHEN it is on comes only from SCHEDULE below. A schedule row is one window (UTC dates, both inclusive) tied to
// one SEASON KEY (seasonFor(ts).key, e.g. 'winter-2026': the season id plus the year it began). An event may have several windows in one season
// (it repeats), but a window is live only while its own season is on and must lie inside it, so when the next season starts nothing carries over:
// an event runs again only once a new row for that new season key is added here. There is no auto-rollover. Same rules as a season otherwise: only
// BUYING is limited to the window; an owned item stays owned, wearable and visible to the club afterwards; never in the box or the pass; one fixed
// price (an organizer may set the club's own in Manage shop, _economyprices.js). The shop says when it ends as a date, never a countdown.
// `items` may use any slot in SLOT_META (_economyshop.js); list only slots the phone can already draw. Items carry `event: <id>`.
// A window that runs into the next day's window of the same event (Christmas 24-30 Nov in autumn, 1-25 Dec in winter) is shown as one run.
export const EVENTS = Object.freeze([
  Object.freeze({
    id: 'christmas', name: 'Christmas',
    items: Object.freeze([
      Object.freeze({ id: 'title-santa', slot: 'title', name: 'Santa\'s Little Dinker', price: 150, rarity: 'rare' }),
      Object.freeze({ id: 'title-jingle', slot: 'title', name: 'Jingle Baller', price: 180, rarity: 'rare' }),
      Object.freeze({ id: 'frame-candy', slot: 'frame', name: 'Candy cane ring', price: 150, rarity: 'rare' }),
      Object.freeze({ id: 'frame-twinkle', slot: 'frame', name: 'Twinkle lights ring', price: 300, rarity: 'rare' }),
      Object.freeze({ id: 'style-candy', slot: 'style', name: 'Candy cane', price: 270, rarity: 'rare' }),
      Object.freeze({ id: 'style-tinsel', slot: 'style', name: 'Tinsel', price: 330, rarity: 'rare' }),
      Object.freeze({ id: 'theme-snow', slot: 'theme', name: 'Snowy court', price: 360, rarity: 'rare' }),
      Object.freeze({ id: 'celebrate-snowfall', slot: 'celebrate', name: 'Snowfall', price: 300, rarity: 'rare' }),
      Object.freeze({ id: 'sound-bells', slot: 'sound', name: 'Sleigh bells', price: 240, rarity: 'rare' }),
      Object.freeze({ id: 'celebrate-gifts', slot: 'celebrate', name: 'Present drop', price: 1200, rarity: 'legendary' })
    ].map(i => Object.freeze({ ...i, event: 'christmas' })))
  })
]);

// season key, event id, first and last day (UTC, inclusive). Add the next season's rows here to run an event again; nothing is copied forward.
export const SCHEDULE = Object.freeze([
  { season: 'autumn-2026', event: 'christmas', from: '2026-11-24', to: '2026-11-30' },
  { season: 'winter-2026', event: 'christmas', from: '2026-12-01', to: '2026-12-25' }
].map(r => Object.freeze(r)));

export const EVENT_ITEMS = Object.freeze(EVENTS.flatMap(e => e.items));
export const eventById = id => EVENTS.find(e => e.id === id) || null;
export const isEventItem = item => !!(item && item.event);

const DAY = 86400000;
const dayMs = s => Date.parse(`${s}T00:00:00Z`);
const dayWords = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

// What is wrong with a schedule (empty = fine): unknown event, bad or reversed dates, a window outside its season key, two windows overlapping.
export function scheduleProblems(schedule = SCHEDULE) {
  const out = [], ok = [];
  for (const r of schedule) {
    const a = /^\d{4}-\d\d-\d\d$/.test(r.from) ? dayMs(r.from) : NaN, b = /^\d{4}-\d\d-\d\d$/.test(r.to) ? dayMs(r.to) : NaN, tag = `${r.event} ${r.season} ${r.from}..${r.to}`;
    if (!eventById(r.event)) out.push(`unknown event: ${tag}`);
    if (!Number.isFinite(a) || !Number.isFinite(b) || iso(a) !== r.from || iso(b) !== r.to) { out.push(`bad date: ${tag}`); continue; }
    if (b < a) { out.push(`ends before it starts: ${tag}`); continue; }
    if (seasonFor(a).key !== r.season || seasonFor(b).key !== r.season) out.push(`not inside ${r.season}: ${tag}`);
    for (const o of ok) if (a < o.b + DAY && o.a < b + DAY) out.push(`overlaps ${o.tag}: ${tag}`);
    ok.push({ a, b, tag });
  }
  return out;
}

// The event on at `ts` (UTC), or null: { id, name, season (key), startsOn, endsOn (last day, inclusive), startMs, endMs (exclusive), dates, note }. Pure.
// A row counts only while its own season key is the current one, so an event scheduled for last season is off, never carried over.
export function eventFor(ts, schedule = SCHEDULE) {
  const ms = msOf(ts), key = seasonFor(ms).key;
  const w = schedule.find(r => r.season === key && eventById(r.event) && ms >= dayMs(r.from) && ms < dayMs(r.to) + DAY);
  if (!w) return null;
  let a = dayMs(w.from), b = dayMs(w.to) + DAY;
  for (let moved = true; moved;) {
    moved = false;
    for (const r of schedule) {
      const s = dayMs(r.from), e = dayMs(r.to) + DAY;
      if (r.event !== w.event || !(e > s)) continue;
      if (e === a) { a = s; moved = true; } else if (s === b) { b = e; moved = true; }
    }
  }
  const e = eventById(w.event);
  return {
    id: e.id, name: e.name, season: key, startsOn: iso(a), endsOn: iso(b - DAY), startMs: a, endMs: b,
    dates: `${dayWords(a)} to ${dayWords(b - DAY)} (UTC)`,
    note: `Here until the end of ${dayWords(b - DAY)} (UTC), and anything you buy is yours to keep.`
  };
}

export const eventOpen = (item, ts, schedule = SCHEDULE) => { const e = eventFor(ts, schedule); return !!e && e.id === item.event; };

// The plain refusal outside a window. It names the next window of this season when there is one, and otherwise says it is not scheduled (never
// "it comes back every year": a new season has to schedule it again). Owned items stay owned either way.
export function eventClosedMessage(item, ts, schedule = SCHEDULE) {
  const e = eventById(item.event), keep = 'anything you already have stays yours.';
  const ms = ts == null ? NaN : msOf(ts), key = Number.isFinite(ms) ? seasonFor(ms).key : null;
  const next = key && schedule.filter(r => r.event === e.id && r.season === key && dayMs(r.from) > ms).sort((x, y) => dayMs(x.from) - dayMs(y.from))[0];
  if (next) return `${item.name} is only in the shop during ${e.name}. It is next on from ${dayWords(dayMs(next.from))} to ${dayWords(dayMs(next.to))} (UTC), and ${keep}`;
  return `${item.name} is only in the shop during ${e.name}, and ${e.name} is not on right now. ${keep[0].toUpperCase() + keep.slice(1)}`;
}
