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
export const isAvailable = (item, ts) => !isSeasonal(item) || seasonFor(ts).id === item.season;

// The plain refusal when a buy is outside the window; says when it is back. Pure.
export function closedMessage(item) {
  const s = SEASONS.find(x => x.id === item.season);
  return `${item.name} is only in the shop during ${s.name}, from 1 ${MONTHS[s.firstMonth]}. It comes back every year.`;
}
