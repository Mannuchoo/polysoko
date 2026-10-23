import { footballRequest } from './footballApiClient.js';

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const SPORTMONKS_BASE = 'https://api.sportmonks.com/v3/football';
const cache = new Map();
const normalizeTeam = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cacheRead(key) {
    const row = cache.get(key);
    if (!row || row.expiresAt <= Date.now()) { cache.delete(key); return null; }
    return row.data;
}

function cacheWrite(key, data, ttl) {
    cache.set(key, { data, expiresAt: Date.now() + ttl });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return data;
}

function normalizeApiFootball(rows, source, live = false) {
    return (Array.isArray(rows) ? rows : []).flatMap(row => (row.bookmakers || []).flatMap(bookmaker => (bookmaker.bets || []).map(bet => ({
        source,
        bookmaker: bookmaker.name || 'Bookmaker',
        market: bet.name || 'Market',
        live,
        outcomes: (bet.values || []).map(value => ({ label: String(value.value || ''), price: Number(value.odd), suspended: Boolean(value.suspended) })).filter(value => Number.isFinite(value.price) && value.price > 1)
    })).filter(market => market.outcomes.length)));
}

function normalizeSportMonks(rows, source, live = false) {
    const groups = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const marketName = row.market?.name || row.market_description || 'Market';
        const bookmakerName = row.bookmaker?.name || `Bookmaker ${row.bookmaker_id || ''}`.trim();
        const key = `${bookmakerName}\u0000${marketName}`;
        if (!groups.has(key)) groups.set(key, { source, bookmaker: bookmakerName, market: marketName, live, outcomes: [] });
        const price = Number(row.value || row.dp3);
        if (Number.isFinite(price) && price > 1) {
            const rawLabel = String(row.label || row.name || '');
            const line = row.total ?? row.handicap;
            const label = line != null && !String(rawLabel).match(/\d/) ? `${rawLabel} ${line}` : rawLabel;
            groups.get(key).outcomes.push({ label, price, suspended: Boolean(row.suspended || row.stopped) });
        }
    }
    return [...groups.values()].filter(market => market.outcomes.length);
}

async function fetchSportMonksOdds(token, match, live) {
    if (!token || !match?.homeTeam || !match?.awayTeam || !match?.startTime) return [];
    const home = normalizeTeam(match.homeTeam), away = normalizeTeam(match.awayTeam);
    const search = encodeURIComponent(`${match.homeTeam} vs ${match.awayTeam}`);
    const searchUrl = new URL(`${SPORTMONKS_BASE}/fixtures/search/${search}`);
    searchUrl.searchParams.set('api_token', token);
    searchUrl.searchParams.set('include', 'participants');
    searchUrl.searchParams.set('per_page', '50');
    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(9000) });
    if (!searchResponse.ok) throw new Error(`SportMonks fixture search failed (${searchResponse.status})`);
    const payload = await searchResponse.json();
    const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
    const target = new Date(match.startTime).getTime();
    const fixture = rows.filter(row => {
        const participants = row.participants || [];
        const names = participants.map(item => normalizeTeam(item.name));
        const hasTeams = names.some(name => name === home || name.includes(home) || home.includes(name)) && names.some(name => name === away || name.includes(away) || away.includes(name));
        const time = Number(row.starting_at_timestamp) ? Number(row.starting_at_timestamp) * 1000 : Date.parse(`${row.starting_at || ''}Z`);
        return hasTeams && Number.isFinite(time) && Math.abs(time - target) <= 36 * 60 * 60 * 1000;
    }).sort((a, b) => {
        const time = row => Number(row.starting_at_timestamp) ? Number(row.starting_at_timestamp) * 1000 : Date.parse(`${row.starting_at || ''}Z`);
        return Math.abs(time(a) - target) - Math.abs(time(b) - target);
    })[0];
    if (!fixture?.id) return [];
    const mode = live ? 'inplay' : 'pre-match';
    const oddsUrl = new URL(`${SPORTMONKS_BASE}/odds/${mode}/fixtures/${fixture.id}`);
    oddsUrl.searchParams.set('api_token', token);
    oddsUrl.searchParams.set('include', 'market;bookmaker');
    const oddsResponse = await fetch(oddsUrl, { signal: AbortSignal.timeout(12000) });
    if (!oddsResponse.ok) throw new Error(`SportMonks odds request failed (${oddsResponse.status})`);
    const oddsPayload = await oddsResponse.json();
    return normalizeSportMonks(oddsPayload?.data, 'SportMonks', live);
}

/** Pull every bookmaker market available from configured football odds feeds. */
export async function fetchAllFootballOdds(fixtureId, match = {}) {
    const id = String(fixtureId || '').replace(/^fb_/, '');
    if (!/^\d+$/.test(id)) return { markets: [], sources: [], errors: {} };
    const live = String(match.status || '').toLowerCase() === 'live';
    const key = `${id}:${live ? 'live' : 'pre'}`;
    const cached = cacheRead(key);
    if (cached) return cached;

    const apiFootballKey = process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
    const sportMonksToken = process.env.SPORTMONKS_TOKEN || process.env.SPORTS_API_KEY;
    const jobs = [];
    if (apiFootballKey) {
        jobs.push((async () => {
            const url = `${API_FOOTBALL_BASE}/odds${live ? '/live' : ''}`;
            const result = await footballRequest(apiFootballKey, url, { params: { fixture: id } });
            if (result.error) throw new Error(result.error);
            return normalizeApiFootball(result.data, 'API-Football', live);
        })().then(data => ({ source: 'API-Football', data })).catch(error => ({ source: 'API-Football', error: error.message, data: [] })));
    }
    if (sportMonksToken) {
        jobs.push(fetchSportMonksOdds(sportMonksToken, match, live).then(data => ({ source: 'SportMonks', data })).catch(error => ({ source: 'SportMonks', error: error.message, data: [] })));
    }

    const results = await Promise.all(jobs);
    const markets = results.flatMap(result => result.data);
    const errors = Object.fromEntries(results.filter(result => result.error).map(result => [result.source, result.error]));
    return cacheWrite(key, { markets, sources: results.map(result => result.source), errors }, live ? 25000 : 5 * 60 * 1000);
}
