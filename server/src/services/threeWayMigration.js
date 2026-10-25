// The three-way (Home / Draw / Away) market migration, in one place.
//
// The app runs this on boot and the standalone migration script runs it by
// hand against production. Both have to apply exactly the same statements,
// so the SQL lives here instead of being copied into each of them.
//
// Four details in this file are deliberate and easy to undo by accident:
//
//   * `oddsC` is added WITHOUT a default. ADD COLUMN writes the default into
//     every row that already exists, so a default of 1.90 would make every
//     market look like it already had a draw price and the backfill could no
//     longer tell "unset" from "set".
//   * the columns are added before the backfill runs. The boot migration
//     block dispatches its statements concurrently (db.serialize() is a no-op
//     on PostgreSQL), so a backfill dispatched from there reaches Postgres
//     before the ALTER TABLE that creates the columns it writes to.
//   * the backfill runs AFTER the sports-metadata repair, because that repair
//     is what classifies a row as a football fixture. Running the backfill
//     first would miss the rows the repair is about to reclassify.
//   * unquoted fixtures start from the odds engine's calculated three-way
//     price. Legacy flat 3.40 fallbacks are replaced once by a repair query.

import { DEFAULT_INTERNAL_THREE_WAY_ODDS } from './oddsEngine.js';

// The columns the migration adds, with the type they are created with.
//
// DOUBLE PRECISION is spelled out rather than REAL because the app's SQL
// translator rewrites REAL into DOUBLE PRECISION anyway. Naming the final
// type means the manual migration script and the boot migration create the
// same column, instead of one of them making a REAL and the other a DOUBLE
// PRECISION.
export const THREE_WAY_COLUMNS = [
    ['sideC', 'TEXT'],
    ['oddsC', 'DOUBLE PRECISION'],
    ['draw_volume', 'DOUBLE PRECISION DEFAULT 0'],
    ['odds_anchor', 'TEXT'],
    ['odds_source', 'TEXT']
];

// The markets that can settle on a draw.
//
// A football fixture is either a synced API-Football row (the id starts with
// fb_) or a row the sports-metadata repair has classified as one (its sport
// is Football and it sits in one of the sports categories).
//
// The category check is what keeps a draw off a market that is not a match.
// A news market that happens to carry the sport 'Football' settles on an
// article, not on a scoreline, so a draw bet on it could never be paid.
export const FOOTBALL_FIXTURE_SQL = `(id LIKE 'fb\\_%' ESCAPE '\\' OR (LOWER(COALESCE(category,'')) IN ('sports','football','soccer') AND LOWER(COALESCE(sport,'')) = 'football'))`;

// The backfill adds the draw side to eligible legacy football markets.
//
// The two existing prices were quoted for a two-outcome market and have no
// meaningful draw equivalent. The draw starts from the pricing engine's
// equal-probability three-way quote, then is kept no shorter than either
// existing side price in case a legacy pool has already shifted those prices.
export const THREE_WAY_BACKFILL_SQL = `UPDATE markets
         SET sideC = 'Draw',
             oddsC = CASE
               WHEN COALESCE(oddsC, 0) > 1 THEN oddsC
               ELSE GREATEST(${DEFAULT_INTERNAL_THREE_WAY_ODDS.DRAW}, COALESCE(oddsA, 1.90), COALESCE(oddsB, 1.90))
             END
         WHERE ${FOOTBALL_FIXTURE_SQL}
           AND COALESCE(admin_verified, 0) = 0
           AND sideA IS NOT NULL AND sideB IS NOT NULL
           AND sideA NOT IN ('YES', 'NO', 'Home', 'Away', 'Unknown', '')
           AND sideB NOT IN ('YES', 'NO', 'Home', 'Away', 'Unknown', '')
           AND (sideC IS NULL OR TRIM(sideC) = '' OR COALESCE(oddsC, 0) <= 1)`;

// Previous releases inserted the same flat price on all three sides when no
// bookmaker quote existed. Replace only that recognizable, unprovenanced
// pattern with the internal engine's initial three-way quote.
export const THREE_WAY_LEGACY_FLAT_REPAIR_SQL = `UPDATE markets
         SET oddsA = ${DEFAULT_INTERNAL_THREE_WAY_ODDS.HOME},
             oddsB = ${DEFAULT_INTERNAL_THREE_WAY_ODDS.AWAY},
             oddsC = ${DEFAULT_INTERNAL_THREE_WAY_ODDS.DRAW},
             odds_anchor = NULL
         WHERE ${FOOTBALL_FIXTURE_SQL}
           AND COALESCE(admin_verified, 0) = 0
           AND COALESCE(odds_source, '') = ''
           AND COALESCE(oddsA, 0) = 3.40
           AND COALESCE(oddsB, 0) = 3.40
           AND COALESCE(oddsC, 0) = 3.40`;

// How many markets now offer a draw.
export const THREE_WAY_READY_SQL = `SELECT COUNT(*) AS n FROM markets
         WHERE ${FOOTBALL_FIXTURE_SQL}
           AND sideC IS NOT NULL AND TRIM(sideC) <> '' AND COALESCE(oddsC, 0) > 1`;
