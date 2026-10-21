// A rate-limit aware client for the API-Football endpoints.
//
// The free plan allows 10 requests a minute and 100 a day. The match-details
// screen needs several of them (fixture, statistics, lineups, events,
// predictions), so a handful of visitors would otherwise exhaust the day's
// budget and leave everyone else with an empty match centre.
//
// This module keeps a shared budget for the whole process:
//
//   * the minute budget refills continuously, so a burst of ten requests is
//     allowed and the eleventh waits for the next window,
//   * the daily budget is a hard cap for the day,
//   * responses are cached, and the cache is served without touching the
//     budget at all.
//
// The headers the API sends back (x-ratelimit-requests-limit and
// x-ratelimit-requests-remaining) are used to correct the budget when they
// disagree with the local count.

const MINUTE_BUDGET = 10;
const DAY_BUDGET = 100;

class FootballApiBudget {
    constructor() {
        this.minuteUsed = 0;
        this.minuteStartedAt = Date.now();
        this.dayUsed = 0;
        this.dayStartedAt = Date.now();
        this.minuteLimit = MINUTE_BUDGET;
        this.dayLimit = DAY_BUDGET;
    }

    // Rolls the minute window over when it has elapsed.
    #rollMinute() {
        const now = Date.now();
        if (now - this.minuteStartedAt >= 60_000) {
            this.minuteUsed = 0;
            this.minuteStartedAt = now;
        }
    }

    // Rolls the day window over at local midnight.
    #rollDay() {
        const now = Date.now();
        const day = 86_400_000;
        if (now - this.dayStartedAt >= day) {
            this.dayUsed = 0;
            this.dayStartedAt = now;
        }
    }

    /**
     * Corrects the local counters from the API's own headers when they are
     * present, so a restart or a missed request does not leave the budget
     * out of step with the provider.
     */
    syncFromHeaders(headers = {}) {
        const minuteLimit = Number(headers['x-ratelimit-limit']);
        const dayLimit = Number(headers['x-ratelimit-requests-limit']);
        const minuteRemaining = Number(headers['x-ratelimit-remaining']);
        const dayRemaining = Number(headers['x-ratelimit-requests-remaining']);

        if (Number.isFinite(minuteLimit) && minuteLimit > 0) this.minuteLimit = minuteLimit;
        if (Number.isFinite(dayLimit) && dayLimit > 0) this.dayLimit = dayLimit;
        if (Number.isFinite(minuteRemaining) && minuteRemaining >= 0) {
            this.minuteUsed = Math.max(this.minuteUsed, this.minuteLimit - minuteRemaining);
        }
        if (Number.isFinite(dayRemaining) && dayRemaining >= 0) {
            this.dayUsed = Math.max(this.dayUsed, this.dayLimit - dayRemaining);
        }
    }

    remaining() {
        this.#rollMinute();
        this.#rollDay();
        return {
            minute: Math.max(0, this.minuteLimit - this.minuteUsed),
            day: Math.max(0, this.dayLimit - this.dayUsed)
        };
    }

    /**
     * Waits until a request can be made. Returns false when the day's budget
     * is spent, which the caller reports to the user rather than hammering
     * the API.
     */
    async waitForTurn({ signal } = {}) {
        for (;;) {
            const { minute, day } = this.remaining();
            if (day <= 0) return false;
            if (minute > 0) {
                this.minuteUsed += 1;
                this.dayUsed += 1;
                return true;
            }
            // The minute window has to refill first. Sleep until it does.
            const waitMs = Math.max(500, 60_000 - (Date.now() - this.minuteStartedAt) + 250);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            if (signal?.aborted) return false;
        }
    }
}

const budget = new FootballApiBudget();

export { budget, FootballApiBudget };

/**
 * Performs one budgeted API-Football request.
 *
 * @param {string} apiKey
 * @param {string} url
 * @param {object} options
 * @param {object} [options.params] Query parameters
 * @param {number} [options.timeout] Milliseconds
 * @returns {Promise<{data: unknown, error: string|null, budgetExhausted: boolean}>}
 */
export async function footballRequest(apiKey, url, { params, timeout = 12000 } = {}) {
    if (!apiKey) return { data: null, error: 'Sports API key is not configured.', budgetExhausted: false };

    const allowed = await budget.waitForTurn();
    if (!allowed) {
        return {
            data: null,
            error: 'The daily sports data budget is spent. Live match details resume tomorrow.',
            budgetExhausted: true
        };
    }

    const query = params ? `?${new URLSearchParams(params).toString()}` : '';
    try {
        const response = await fetch(`${url}${query}`, {
            headers: { 'x-apisports-key': apiKey },
            signal: AbortSignal.timeout(timeout)
        });
        budget.syncFromHeaders(response.headers);

        if (!response.ok) {
            const detail = await response.text();
            return {
                data: null,
                error: `Sports API request failed (${response.status}): ${detail.slice(0, 200)}`,
                budgetExhausted: response.status === 429
            };
        }

        const payload = await response.json();
        if (payload?.errors && Object.keys(payload.errors).length) {
            return { data: null, error: 'Sports data is unavailable from the provider.', budgetExhausted: false };
        }
        return { data: payload?.response ?? [], error: null, budgetExhausted: false };
    } catch (error) {
        return {
            data: null,
            error: error.name === 'TimeoutError' ? 'Sports data request timed out.' : (error.message || 'Sports data request failed.'),
            budgetExhausted: false
        };
    }
}

/**
 * A cache for fixture data whose contents do not change once they are known.
 *
 * The starting XI is fixed when the lineups are published, and the match
 * statistics are final once the whistle blows, so both are worth keeping for
 * much longer than a live score.
 */
export class FixtureDataCache {
    constructor({ maxEntries = 200, lineupsTtlMs = 6 * 60 * 60 * 1000, statsTtlMs = 6 * 60 * 60 * 1000 } = {}) {
        this.entries = new Map();
        this.maxEntries = maxEntries;
        this.lineupsTtlMs = lineupsTtlMs;
        this.statsTtlMs = statsTtlMs;
    }

    #prune() {
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
    }

    get(fixtureId, kind) {
        const entry = this.entries.get(`${fixtureId}:${kind}`);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.entries.delete(`${fixtureId}:${kind}`);
            return null;
        }
        return entry.data;
    }

    set(fixtureId, kind, data) {
        this.entries.set(`${fixtureId}:${kind}`, {
            data,
            expiresAt: Date.now() + (kind === 'lineups' ? this.lineupsTtlMs : this.statsTtlMs)
        });
        this.#prune();
    }
}
