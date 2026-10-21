// Read-only follow-up inspection of the Railway production Postgres.
//
// SELECT only.
//
// Checks the things the first pass could not answer because Postgres folds
// unquoted aliases to lower case:
//   * the real odds on the football rows (the first pass printed "undefined")
//   * whether any live bettable football market has a NULL price, which
//     would make the price unavailable to a bettor
//   * which sports rows the backfill would touch, split by fixture vs not
const path = require('path');
const dotenv = require('dotenv');
const { createPool, toPg } = require('./db.cjs');

dotenv.config({ path: path.join(__dirname, '.env') });

const pool = createPool();
const all = (sql, params = []) => pool.query(toPg(sql), params).then(r => r.rows);
const get = (sql, params = []) => pool.query(toPg(sql), params).then(r => r.rows[0]);

(async () => {
    console.log('=== A. odds on football rows (correct alias casing) ===');
    const odds = await all(`
        SELECT id, title, status, sidea, sideb,
               oddsa, oddsb, home_volume, away_volume,
               COALESCE(event_end_time, starttime) AS ends_at
        FROM markets
        WHERE id LIKE 'fb\\_%' ESCAPE '\\'
        ORDER BY starttime DESC NULLS LAST
        LIMIT 8
    `);
    for (const row of odds) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 38)} | ${row.status}`);
        console.log(`      sides=${row.sidea} v ${row.sideb} | oddsa=${row.oddsa} oddsb=${row.oddsb} | vol=${row.home_volume}/${row.away_volume} | ends=${row.ends_at}`);
    }

    console.log('\n=== B. football rows with a NULL or invalid price ===');
    const badOdds = await get(`
        SELECT COUNT(*) FILTER (WHERE oddsa IS NULL) AS null_oddsa,
               COUNT(*) FILTER (WHERE oddsb IS NULL) AS null_oddsb,
               COUNT(*) FILTER (WHERE COALESCE(oddsa,0) <= 1) AS bad_oddsa,
               COUNT(*) FILTER (WHERE COALESCE(oddsb,0) <= 1) AS bad_oddsb,
               COUNT(*) AS total
        FROM markets WHERE id LIKE 'fb\\_%' ESCAPE '\\'
    `);
    console.log('  ', JSON.stringify(badOdds));

    console.log('\n=== C. live bettable football markets with no usable price ===');
    const liveBad = await all(`
        SELECT id, title, status, sidea, sideb, oddsa, oddsb
        FROM markets
        WHERE id LIKE 'fb\\_%' ESCAPE '\\'
          AND status IN ('open','upcoming','live')
          AND COALESCE(event_end_time, starttime) > NOW()
          AND (COALESCE(oddsa,0) <= 1 OR COALESCE(oddsb,0) <= 1)
        LIMIT 10
    `);
    console.log(`  ${liveBad.length} row(s) with a missing price:`);
    for (const row of liveBad) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 40)} | ${row.status} | oddsa=${row.oddsa} oddsb=${row.oddsb}`);
    }

    console.log('\n=== D. which rows the backfill would touch, by kind ===');
    const kinds = await get(`
        SELECT COUNT(*) AS candidates,
               COUNT(*) FILTER (WHERE id LIKE 'fb\\_%' ESCAPE '\\') AS fb_prefix,
               COUNT(*) FILTER (WHERE LOWER(COALESCE(sport,'')) = 'football') AS sport_football,
               COUNT(*) FILTER (WHERE status IN ('open','upcoming','live')) AS live,
               COUNT(*) FILTER (WHERE COALESCE(settled,0) = 1) AS settled,
               COUNT(*) FILTER (WHERE status = 'closed') AS closed
        FROM markets
        WHERE (id LIKE 'fb\\_%' ESCAPE '\\' OR LOWER(COALESCE(sport,'')) = 'football')
          AND COALESCE(admin_verified,0) = 0
          AND sidea IS NOT NULL AND sideb IS NOT NULL
          AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
          AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
    `);
    console.log('  ', JSON.stringify(kinds));

    console.log('\n=== E. sp_ (non-football sports) rows: would they get a draw? ===');
    const sp = await get(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE COALESCE(sport,'') IN ('Hockey','Cricket','Tennis')) AS draw_capable,
               COUNT(*) FILTER (WHERE COALESCE(sport,'') NOT IN ('Hockey','Cricket','Tennis') AND COALESCE(sport,'') <> '') AS not_draw_capable
        FROM markets WHERE id LIKE 'sp\\_%' ESCAPE '\\'
    `);
    console.log('  ', JSON.stringify(sp));
    const spSports = await all(`
        SELECT COALESCE(sport,'(none)') AS sport, COUNT(*) AS n
        FROM markets WHERE id LIKE 'sp\\_%' ESCAPE '\\' GROUP BY 1 ORDER BY n DESC
    `);
    for (const row of spSports) console.log(`    ${row.sport}: ${row.n}`);

    console.log('\n=== F. football rows whose sport is football but id is not fb_ ===');
    const oddOnes = await all(`
        SELECT id, title, sport, sidea, sideb, status
        FROM markets
        WHERE LOWER(COALESCE(sport,'')) = 'football' AND id NOT LIKE 'fb\\_%' ESCAPE '\\'
        LIMIT 8
    `);
    if (!oddOnes.length) console.log('  (none)');
    for (const row of oddOnes) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 40)} | ${row.status} | ${row.sidea} v ${row.sideb}`);
    }

    console.log('\n=== G. non-football sports rows that look like fixtures (would a draw be wrong?) ===');
    const fixtureish = await all(`
        SELECT id, title, sport, sidea, sideb, status
        FROM markets
        WHERE id LIKE 'sp\\_%' ESCAPE '\\'
          AND COALESCE(sport,'') NOT IN ('Hockey','Cricket','Tennis')
          AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
          AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
        LIMIT 6
    `);
    if (!fixtureish.length) console.log('  (none)');
    for (const row of fixtureish) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 40)} | sport=${row.sport} | ${row.sidea} v ${row.sideb}`);
    }
})()
    .catch(e => { console.error('INSPECT FAILED:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
