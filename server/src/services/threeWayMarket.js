// Three-way (Home / Draw / Away) support for sports markets.
//
// Sports fixtures settle on three outcomes, so they need a third side to bet
// on. A draw is no longer a void event that refunds every stake: a bet on
// Draw wins when the match is drawn, and the Home/Away bets on that match
// lose. Non-sports markets keep the binary YES/NO model and never get a
// third side.
//
// The canonical side keys are HOME, DRAW and AWAY. The labels shown to users
// come from the market row (sideA = home team, sideC = 'Draw', sideB = away
// team), so a market created before this change keeps working: it simply has
// no draw side until the next sync fills one in.

// The three side keys, in the order they are shown to users.
export const THREE_WAY_SIDES = ['HOME', 'DRAW', 'AWAY'];

// Maps a side key to the markets column that stores its stake volume.
const VOLUME_COLUMN = {
    HOME: 'home_volume',
    DRAW: 'draw_volume',
    AWAY: 'away_volume'
};

// Maps a side key to the markets column that stores its price.
const ODDS_COLUMN = {
    HOME: 'oddsA',
    DRAW: 'oddsC',
    AWAY: 'oddsB'
};

// Maps a side key to the markets column that stores its display label.
const LABEL_COLUMN = {
    HOME: 'sideA',
    DRAW: 'sideC',
    AWAY: 'sideB'
};

export const volumeColumnForSide = side => VOLUME_COLUMN[side] || null;
export const oddsColumnForSide = side => ODDS_COLUMN[side] || null;
export const labelColumnForSide = side => LABEL_COLUMN[side] || null;

// The label used when a market has no explicit draw label.
export const DEFAULT_DRAW_LABEL = 'Draw';

export const isDrawSide = value => String(value || '').trim().toUpperCase() === 'DRAW';

/**
 * A market can take a draw bet when it has a draw label and a draw price.
 * Sports markets created before the three-way change have neither, so they
 * keep behaving like two-way markets until the next sync populates them.
 */
export function supportsDraw(market) {
    if (!market) return false;
    const label = String(market.sideC || '').trim();
    const odds = Number(market.oddsC || 0);
    return Boolean(label) && Number.isFinite(odds) && odds > 1;
}

/**
 * Resolve a client-supplied side to one of the three canonical side keys.
 *
 * Accepts the canonical keys (HOME/DRAW/AWAY), the legacy binary aliases
 * (YES/NO), and the market's own labels (e.g. "Arsenal" or "Chelsea") so a
 * bet can be placed by tapping a team name. Returns null when the value
 * cannot be matched to a side of the given market.
 */
export function resolveSideKey(rawSide, market = {}) {
    const value = String(rawSide || '').trim();
    if (!value) return null;
    const upper = value.toUpperCase();

    if (upper === 'DRAW') return 'DRAW';
    if (upper === 'HOME' || upper === 'YES') return 'HOME';
    if (upper === 'AWAY' || upper === 'NO') return 'AWAY';

    // Fall back to matching the market's own labels. Comparison is
    // case-insensitive because the frontend sends the label it displayed.
    const sideA = String(market.sideA || '').trim().toLowerCase();
    const sideB = String(market.sideB || '').trim().toLowerCase();
    const sideC = String(market.sideC || '').trim().toLowerCase();
    const needle = value.toLowerCase();
    if (sideA && needle === sideA) return 'HOME';
    if (sideC && needle === sideC) return 'DRAW';
    if (sideB && needle === sideB) return 'AWAY';
    return null;
}

/**
 * The label to show for a side key on a given market.
 */
export function sideLabel(sideKey, market = {}) {
    if (sideKey === 'DRAW') return String(market.sideC || '').trim() || DEFAULT_DRAW_LABEL;
    if (sideKey === 'HOME') return String(market.sideA || '').trim() || 'Home';
    if (sideKey === 'AWAY') return String(market.sideB || '').trim() || 'Away';
    return '';
}

/**
 * The price for a side key on a given market.
 */
export function sideOdds(sideKey, market = {}) {
    if (sideKey === 'DRAW') return Number(market.oddsC || 0);
    if (sideKey === 'HOME') return Number(market.oddsA || 0);
    if (sideKey === 'AWAY') return Number(market.oddsB || 0);
    return 0;
}

/**
 * The stake volume backing a side key on a given market.
 */
export function sideVolume(sideKey, market = {}) {
    if (sideKey === 'DRAW') return Number(market.draw_volume || 0);
    if (sideKey === 'HOME') return Number(market.home_volume || 0);
    if (sideKey === 'AWAY') return Number(market.away_volume || 0);
    return 0;
}

/**
 * The outcome keys a market exposes to users, in display order. Binary
 * markets report HOME/AWAY only; a market with a draw price reports all three.
 */
export function marketSideKeys(market = {}) {
    const keys = ['HOME'];
    if (supportsDraw(market)) keys.push('DRAW');
    keys.push('AWAY');
    return keys;
}

/**
 * Decide whether a bet on `betSide` wins when the market settles on
 * `winningSide`.
 *
 * `winningSide` is the settlement result: HOME, AWAY or DRAW. When the
 * market supports a draw, a DRAW result pays the draw bets and loses every
 * other bet. A market without a draw side keeps the old behaviour where a
 * draw is handled by the caller (it refunds the market instead of settling
 * it), so this function is never called with a DRAW winner for those.
 */
export function isWinningSide(betSide, winningSide, market = {}) {
    const bet = resolveSideKey(betSide, market);
    const winner = String(winningSide || '').trim().toUpperCase();
    if (!bet || !winner) return false;
    if (winner === 'DRAW') return bet === 'DRAW';
    if (winner === 'HOME') return bet === 'HOME';
    if (winner === 'AWAY') return bet === 'AWAY';
    return false;
}

/**
 * Decide whether a bet wins on a market that has no third outcome.
 *
 * A binary market settles on the label its own sides carry (YES/NO on a news
 * market, LIKELY/UNLIKELY on a politics one), so the bet and the winner are
 * compared against those labels rather than against the HOME/AWAY keys.
 *
 * 'HOME'/'YES' are the two names for the first outcome and 'AWAY'/'NO' the
 * two names for the second, so a bet recorded under one name still wins when
 * the market settles on the other. Without that, a politics bet placed as
 * 'YES' would never be paid when the market settles on 'LIKELY'.
 */
export function isWinningBinarySide(betSide, winningSide, market = {}) {
    const bet = String(betSide || '').trim().toUpperCase();
    const winner = String(winningSide || '').trim().toUpperCase();
    if (!bet || !winner) return false;

    const sideA = String(market.sideA || 'YES').trim().toUpperCase();
    const sideB = String(market.sideB || 'NO').trim().toUpperCase();

    if (bet === winner) return true;

    const winnerIsA = winner === sideA || winner === 'HOME' || winner === 'YES';
    const winnerIsB = winner === sideB || winner === 'AWAY' || winner === 'NO';
    const betIsA = bet === sideA || bet === 'HOME' || bet === 'YES';
    const betIsB = bet === sideB || bet === 'AWAY' || bet === 'NO';

    return (winnerIsA && betIsA) || (winnerIsB && betIsB);
}

/**
 * Work out which outcome a settlement result names on a given market.
 *
 * A three-way sports market settles on HOME, DRAW or AWAY, and the admin may
 * name the winner the way the market does (a team name). A binary market
 * settles on the label its own sides carry, so the result is translated into
 * that label and the recorded result stays meaningful.
 *
 * A 'DRAW' result is returned as it is on every market: on a market that
 * offers a draw it pays the draw bets, and on one that does not it refunds
 * the stakes instead.
 *
 * Returns null when the result names no outcome of the market.
 */
export function settlementOutcome(rawResult, market = {}) {
    const value = String(rawResult || '').trim();
    if (!value) return null;
    const upper = value.toUpperCase();
    if (upper === 'CANCEL' || upper === 'CANCELLED') return upper;

    // A three-way sports market settles on one of the canonical keys, so the
    // result is resolved against the market's own outcomes: the admin may
    // name the winner the way the market labels it (a team name).
    if (supportsDraw(market)) {
        return resolveSideKey(value, market);
    }

    const sideA = String(market.sideA || 'YES').trim();
    const sideB = String(market.sideB || 'NO').trim();

    // An exact label match is unambiguous and always wins.
    if (sideA && upper === sideA.toUpperCase()) return sideA;
    if (sideB && upper === sideB.toUpperCase()) return sideB;

    if (upper === 'DRAW') return 'DRAW';
    // The canonical aliases apply: 'YES'/'HOME' is the first outcome of the
    // market and 'NO'/'AWAY' the second.
    if (upper === 'YES' || upper === 'HOME') return sideA || 'YES';
    if (upper === 'NO' || upper === 'AWAY') return sideB || 'NO';
    return null;
}

/**
 * Decide whether a settlement result is a draw that cannot be paid.
 *
 * A three-way sports market pays its draw bets, so a draw there is a real
 * outcome. A market with no draw side has nothing to pay, so the stakes are
 * refunded instead. A market that happens to carry 'Draw' as one of its own
 * labels is a three-way market, so it pays rather than refunds.
 */
export function isVoidingDraw(rawResult, market = {}) {
    if (String(rawResult || '').trim().toUpperCase() !== 'DRAW') return false;
    return !supportsDraw(market);
}

/**
 * Normalize a settlement result into HOME, AWAY or DRAW.
 */
export function normalizeOutcome(value) {
    const upper = String(value || '').trim().toUpperCase();
    if (upper === 'HOME' || upper === 'AWAY' || upper === 'DRAW') return upper;
    return upper;
}
