// Fetches pre-match prices from API-Sports odds endpoints. Quotes are cached
// briefly because these providers refresh odds much less often than fixtures.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const oddsCache = new Map();

const toOdd = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 1 ? n : null;
};

function records(payload) {
    const response = payload?.response ?? payload?.data?.response ?? payload?.data ?? payload?.odds;
    return Array.isArray(response) ? response : response && typeof response === 'object' ? [response] : [];
}

function outcomesFromBookmakers(bookmakers, supportsDraw) {
    if (!Array.isArray(bookmakers)) return null;
    for (const book of bookmakers) {
        const bets = Array.isArray(book?.bets) ? book.bets : [];
        for (const bet of bets) {
            let home = null;
            let away = null;
            let draw = null;
            for (const item of Array.isArray(bet?.values) ? bet.values : []) {
                const label = String(item?.value ?? item?.name ?? '').trim().toLowerCase();
                const odd = toOdd(item?.odd ?? item?.odds ?? item?.value?.odd);
                if (!odd) continue;
                if (/^(home|1|team 1)$/.test(label)) home ??= odd;
                else if (/^(away|2|team 2)$/.test(label)) away ??= odd;
                else if (/^(draw|x|tie)$/.test(label)) draw ??= odd;
            }
            if (home && away && (!supportsDraw || draw)) {
                return { home, away, ...(supportsDraw ? { draw } : {}), bookmaker: String(book?.name || book?.id || 'API-Sports') };
            }
        }
    }
    return null;
}

function extractQuote(row, supportsDraw) {
    const bookmakers = row?.bookmakers ?? row?.odds?.bookmakers ?? row?.odds;
    const quote = outcomesFromBookmakers(bookmakers, supportsDraw);
    if (!quote) return null;
    const id = row?.game?.id ?? row?.fixture?.id ?? row?.match?.id ?? row?.fight?.id ?? row?.id;
    return { ...quote, providerId: id == null ? null : String(id) };
}

/**
 * Fetch odds by event id with bounded concurrency and an in-process TTL cache.
 * API-Sports coverage varies by sport, league and plan; absent quotes are
 * intentionally omitted so callers can retain a prior provider quote or use
 * the platform fallback.
 */
export async function fetchSportsProviderOdds(sport, games, apiKey, axios) {
    if (!apiKey || !Array.isArray(games) || !games.length) return new Map();
    const now = Date.now();
    const results = new Map();
    const pending = [];
    for (const game of games) {
        const id = String(game?.providerId ?? '');
        if (!id) continue;
        const key = `${sport.key}:${id}`;
        const cached = oddsCache.get(key);
        if (cached && cached.expiresAt > now) {
            if (cached.quote) results.set(id, cached.quote);
        } else {
            pending.push({ id, key });
        }
    }
    for (let i = 0; i < pending.length; i += 4) {
        const batch = pending.slice(i, i + 4);
        const quotes = await Promise.all(batch.map(async ({ id, key }) => {
            try {
                const res = await axios.get(`${sport.host}/odds`, {
                    params: { [sport.oddsParam || 'game']: id },
                    headers: { 'x-apisports-key': apiKey },
                    timeout: 12000
                });
                const quote = records(res.data)
                    .map(row => extractQuote(row, Boolean(sport.draw)))
                    .find(row => !row.providerId || row.providerId === id) || null;
                oddsCache.set(key, { quote, expiresAt: now + CACHE_TTL_MS });
                if (quote) results.set(id, quote);
                return quote;
            } catch (error) {
                // A failed request is short-cached to prevent a rapid retry
                // storm, but can be retried after five minutes.
                oddsCache.set(key, { quote: null, expiresAt: now + 5 * 60 * 1000 });
                return null;
            }
        }));
    }
    return results;
}
