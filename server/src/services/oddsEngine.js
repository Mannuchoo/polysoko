// Pricing engine shared by every market.
//
// Two market shapes share the same maths:
//
//   * a binary market prices two outcomes (YES/NO),
//   * a three-way sports market prices three (HOME/DRAW/AWAY).
//
// The pool's money tilts a prior. A binary market starts from even money; a
// sports market starts from the bookmaker's 1X2 price, so a real market price
// is not thrown away every time a bet lands. The prior is kept in the
// `odds_anchor` column and written by the sports sync, which is the only
// place that talks to the bookmaker.
//
// The house edge lives in the payout, not in the probability. A fair 50/50
// market is quoted at 1.90 rather than 2.00, which means the platform pays
// out 95% of the fair payout and the quoted prices imply a little more than
// 100% in total. That is the overround, and it is the platform's edge.
//
// The previous formula multiplied the price by 1.05, which pushed the
// implied probabilities BELOW 100% and handed the edge to the bettors.

const DEFAULT_PAYOUT_FACTOR = 0.95;
// sKES of "anchor" money that holds a price steady. Without it the first
// sKES staked would swing the price all the way to 1.00.
const DEFAULT_LIQUIDITY = 100;
// The lowest price a bettor can be quoted. A price at or below 1.00 would be
// a guaranteed loss for the bettors, which is never a real market.
const MIN_PRICE = 1.01;

/**
 * Turn a set of decimal odds into implied probabilities that sum to 1.
 * Returns null when the prices are unusable.
 */
export function impliedProbabilities(prices) {
    const entries = Object.entries(prices || {})
        .map(([key, odds]) => [key, Number(odds)])
        .filter(([, odds]) => Number.isFinite(odds) && odds > 1);
    if (!entries.length) return null;

    const total = entries.reduce((sum, [, odds]) => sum + 1 / odds, 0);
    if (!(total > 0)) return null;

    const probabilities = {};
    for (const [key, odds] of entries) probabilities[key] = (1 / odds) / total;
    return probabilities;
}

/**
 * Turn probabilities into decimal odds, applying the platform's payout
 * factor. The probabilities are the fair ones; the price is what a winner
 * actually receives, so it is the fair price times the payout factor.
 */
export function pricesFromProbabilities(probabilities, payoutFactor = DEFAULT_PAYOUT_FACTOR) {
    const prices = {};
    for (const [key, probability] of Object.entries(probabilities || {})) {
        const value = Number(probability);
        if (!Number.isFinite(value) || value <= 0) continue;
        const price = payoutFactor / value;
        prices[key] = Number(Math.max(MIN_PRICE, price).toFixed(2));
    }
    return prices;
}

/**
 * Blend a prior with the money in the pool.
 *
 * The prior is weighted by the liquidity constant and the pool by the total
 * staked, so the two always add back up to one. The result is a probability
 * per outcome.
 */
export function blendWithPool({ prior, volumes, liquidity = DEFAULT_LIQUIDITY }) {
    const priorProbabilities = impliedProbabilities(prior);
    if (!priorProbabilities) return null;

    const keys = Object.keys(priorProbabilities);
    const stake = {};
    let totalStake = 0;
    for (const key of keys) {
        const volume = Math.max(0, Number(volumes?.[key] || 0));
        stake[key] = volume;
        totalStake += volume;
    }

    const anchor = Math.max(0, Number(liquidity) || 0);
    const blended = {};
    for (const key of keys) {
        blended[key] = (priorProbabilities[key] * anchor + stake[key]) / (anchor + totalStake);
    }
    return blended;
}

/**
 * Price a market from its prior and the money in the pool.
 *
 * @param {object} options
 * @param {object} options.prior Decimal odds per outcome key
 * @param {object} options.volumes Stake per outcome key
 * @param {number} [options.payoutFactor] Share of the fair payout that is paid
 * @param {number} [options.liquidity] sKES of anchor money
 * @returns {object|null} Decimal odds per outcome key
 */
export function priceMarket({ prior, volumes, payoutFactor = DEFAULT_PAYOUT_FACTOR, liquidity = DEFAULT_LIQUIDITY }) {
    const blended = blendWithPool({ prior, volumes, liquidity });
    if (!blended) return null;
    return pricesFromProbabilities(blended, payoutFactor);
}

/**
 * The overround a set of prices implies: the total implied probability. A
 * value above 1 means the platform holds an edge.
 */
export function overround(prices) {
    let total = 0;
    for (const odds of Object.values(prices || {})) {
        const numeric = Number(odds);
        if (Number.isFinite(numeric) && numeric > 0) total += 1 / numeric;
    }
    return total;
}

export { DEFAULT_PAYOUT_FACTOR, DEFAULT_LIQUIDITY, MIN_PRICE };
