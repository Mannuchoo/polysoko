// Football odds for three-way (Home / Draw / Away) sports markets.
//
// API-Football exposes bookmaker prices through its /odds endpoint. The
// "Match Winner" market is the one we want: it is the standard 1X2 market
// with a Home, a Draw and an Away price.
//
// Two constraints shape this module:
//
//   * The free tier allows only 10 requests per minute and 100 per day, so
//     the odds for a whole day are fetched in ONE request and cached.
//   * Only the fixtures a bookmaker actually prices come back (roughly ten
//     per day on the free tier). The rest use the internal market pricing
//     engine and are not presented as bookmaker quotes.
//
// A preferred bookmaker is used when it is present, because a single
// consistent book makes the three prices comparable. The fallback is the
// first bookmaker that quotes a complete 1X2 market.

import { footballRequest } from './footballApiClient.js';

const ODDS_BASE = 'https://v3.football.api-sports.io/odds';

// Bookmakers in order of preference. Pinnacle and Bet365 are the sharpest
// books available on the free tier; the rest are fallbacks.
const PREFERRED_BOOKMAKERS = ['Pinnacle', 'Bet365', 'Betfair', '1xBet', 'Dafabet', 'Marathonbet', 'BetVictor', 'William Hill', 'SBO', 'Betano'];

// Caches the odds for a date so repeated syncs within the same day do not
// spend the request budget.
const oddsCache = new Map();

const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
};

/**
 * Pull the Home/Draw/Away prices out of one bookmaker's bet list.
 * Returns null unless the market has all three prices.
 */
function readMatchWinner(bet) {
    if (!bet || !/match winner/i.test(String(bet.name || ''))) return null;
    const values = Array.isArray(bet.values) ? bet.values : [];
    let home = null;
    let draw = null;
    let away = null;
    for (const entry of values) {
        const odd = toNumber(entry?.odd);
        if (!odd) continue;
        const label = String(entry?.value || '').trim().toLowerCase();
        if (label === 'home' && home === null) home = odd;
        else if (label === 'draw' && draw === null) draw = odd;
        else if (label === 'away' && away === null) away = odd;
    }
    if (!home || !draw || !away) return null;
    return { home, draw, away };
}

/**
 * Choose the prices to use for a fixture from its list of bookmakers.
 */
function pickBookmakerPrices(bookmakers) {
    if (!Array.isArray(bookmakers) || !bookmakers.length) return null;

    const quotes = [];
    for (const bookmaker of bookmakers) {
        const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
        const matchWinner = bets.find(bet => readMatchWinner(bet));
        const prices = readMatchWinner(matchWinner);
        if (prices) quotes.push({ name: String(bookmaker?.name || ''), prices });
    }
    if (!quotes.length) return null;

    // Prefer a known book so the three prices always come from one source.
    for (const preferred of PREFERRED_BOOKMAKERS) {
        const match = quotes.find(quote => quote.name.toLowerCase() === preferred.toLowerCase());
        if (match) return { ...match.prices, bookmaker: match.name };
    }
    return { ...quotes[0].prices, bookmaker: quotes[0].name };
}

/**
 * Fetch the 1X2 prices for every fixture on a date.
 *
 * @param {string} apiKey API-Football key
 * @param {string} date YYYY-MM-DD
 * @param {object} options
 * @param {boolean} options.force Ignore the cache and refetch
 * @returns {Promise<Map<string, {home:number,draw:number,away:number,bookmaker:string}>>}
 */
export async function fetchFootballOdds(apiKey, date, { force = false } = {}) {
    if (!apiKey || !date) return new Map();

    if (!force && oddsCache.has(date)) {
        return oddsCache.get(date);
    }

    const result = new Map();
    // The odds request shares the process-wide budget with the match-details
    // calls, so it never spends more than the provider allows.
    const outcome = await footballRequest(apiKey, ODDS_BASE, {
        params: { date },
        timeout: 15000
    });

    if (outcome.error) {
        console.warn(`[football] Odds request failed for ${date}: ${outcome.error}`);
        oddsCache.set(date, result);
        return result;
    }

    const rows = Array.isArray(outcome.data) ? outcome.data : [];
    for (const row of rows) {
        const fixtureId = row?.fixture?.id;
        if (!fixtureId) continue;
        const prices = pickBookmakerPrices(row?.bookmakers);
        if (prices) result.set(String(fixtureId), prices);
    }
    console.log(`[football] Odds for ${date}: ${result.size}/${rows.length} fixtures priced with a 1X2 market.`);

    oddsCache.set(date, result);
    return result;
}

/**
 * Return a complete provider quote or null. Unquoted fixtures are priced by
 * the platform odds engine and must not be presented as bookmaker odds.
 */
export function oddsForFixture(prices) {
    if (!prices?.bookmaker) return null;
    const home = toNumber(prices.home);
    const draw = toNumber(prices.draw);
    const away = toNumber(prices.away);
    if (!home || !draw || !away) return null;
    return { home, draw, away, bookmaker: prices.bookmaker };
}

export { PREFERRED_BOOKMAKERS };
