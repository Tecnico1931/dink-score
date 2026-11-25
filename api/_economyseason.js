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

// The season at `ts` and its window: { id, name, startsOn, endsOn (the last day, inclusive), startMs, endMs (exclusive, UTC midnight after the last day),
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
    id: season.id, name: season.name, startsOn: iso(startMs), endsOn: iso(endMs - 86400000), startMs, endMs,
    dates: `1 ${MONTHS[season.firstMonth]} to ${endLabel} (UTC)`,
    returns: `${season.name} returns every ${MONTHS[season.firstMonth]}. Anything you already have stays yours.`
  };
}

// Is this item on sale at `ts`? Permanent items (no season) always are.
export const isAvailable = (item, ts) => isEventItem(item) ? eventOpen(item, ts) : !isSeasonal(item) || seasonFor(ts).id === item.season;

// The plain refusal when a buy is outside the window; says when it is back. Pure.
export function closedMessage(item) {
  if (isEventItem(item)) return eventClosedMessage(item);
  const s = SEASONS.find(x => x.id === item.season);
  return `${item.name} is only in the shop during ${s.name}, from 1 ${MONTHS[s.firstMonth]}. It comes back every year.`;
}

// ---------- Events (WI-12): a dated shelf of limited-time items, on top of the four calendar seasons ----------
// An event runs between two UTC month-days (inclusive), the same every year, so it comes back and nothing is permanently missed. Same rules as
// a season: only BUYING is limited to the window; an owned item stays owned, wearable and visible to the club afterwards; never in the box or the
// pass; one fixed price (an organizer may set the club's own in Manage shop, _economyprices.js). The shop says when it ends as a date, never a
// countdown. `items` may use any slot in SLOT_META (_economyshop.js); list only slots the phone can already draw. Items carry `event: <id>`.
export const EVENTS = Object.freeze([
  Object.freeze({
    id: 'christmas', name: 'Christmas', from: [10, 24], to: [11, 25], until: 'the end of Christmas Day',
    items: Object.freeze([
      Object.freeze({ id: 'frame-candy', slot: 'frame', name: 'Candy cane ring', price: 150, rarity: 'rare' }),
      Object.freeze({ id: 'frame-twinkle', slot: 'frame', name: 'Twinkle lights ring', price: 300, rarity: 'rare' })
    ].map(i => Object.freeze({ ...i, event: 'christmas' })))
  })
]);
export const EVENT_ITEMS = Object.freeze(EVENTS.flatMap(e => e.items));
export const eventById = id => EVENTS.find(e => e.id === id) || null;
export const isEventItem = item => !!(item && item.event);

// The event on at `ts` (UTC), or null: { id, name, startsOn, endsOn (last day, inclusive), startMs, endMs (exclusive), dates, note }. Pure.
export function eventFor(ts) {
  const ms = msOf(ts), year = new Date(ms).getUTCFullYear();
  for (const e of EVENTS) {
    const startMs = Date.UTC(year, e.from[0], e.from[1]), endMs = Date.UTC(year, e.to[0], e.to[1] + 1);
    if (ms < startMs || ms >= endMs) continue;
    return {
      id: e.id, name: e.name, startsOn: iso(startMs), endsOn: iso(endMs - 86400000), startMs, endMs,
      dates: `${e.from[1]} ${MONTHS[e.from[0]]} to ${e.to[1]} ${MONTHS[e.to[0]]} (UTC)`,
      note: `Here until ${e.until} (${e.to[1]} ${MONTHS[e.to[0]]}, UTC), and anything you buy is yours to keep.`
    };
  }
  return null;
}

export const eventOpen = (item, ts) => { const e = eventFor(ts); return !!e && e.id === item.event; };
export function eventClosedMessage(item) {
  const e = eventById(item.event);
  return `${item.name} is only in the shop during ${e.name}, from ${e.from[1]} ${MONTHS[e.from[0]]} to ${e.to[1]} ${MONTHS[e.to[0]]}. It comes back every year, and anything you already have stays yours.`;
}
