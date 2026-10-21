// Read-only inspection of the Railway production Postgres.
//
// SELECT only. Nothing in this script writes, updates or deletes anything.
//
// It answers three questions:
//   1. Which columns does the markets table actually have?
//   2. How many sports markets are there, and how many have team names?
//   3. How many football rows would the backfill touch, and what do the
//      settled sports markets say in their recorded result?
//
// Note: PostgreSQL folds unquoted identifiers to lower case, so the columns
// are `sidea`/`sideb`/`oddsa`/`oddsb` on the server, not `sideA`/`sideB`.
const path = require('path');
const dotenv = require('dotenv');
const { createPool, toPg } = require('./db.cjs');

dotenv.config({ path: path.join(__dirname, '.env') });

const pool = createPool();

const all = (sql, params = []) => pool.query(toPg(sql), params).then(r => r.rows);
const get = (sql, params = []) => pool.query(toPg(sql), params).then(r => r.rows[0]);

(async () => {
    console.log('=== 1. markets table columns ===');
    const columns = await all(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'markets'
        ORDER BY ordinal_position
    `);
    for (const col of columns) console.log(`  ${col.column_name} (${col.data_type})`);

    const wanted = ['sidec', 'oddsc', 'draw_volume', 'odds_anchor'];
    const present = new Set(columns.map(c => c.column_name));
    console.log('\n  three-way columns:');
    for (const name of wanted) {
        console.log(`    ${name}: ${present.has(name) ? 'PRESENT' : 'MISSING'}`);
    }

    console.log('\n=== 2. market counts by category ===');
    const byCategory = await all(`
        SELECT COALESCE(category,'(none)') AS category, COUNT(*) AS n
        FROM markets GROUP BY 1 ORDER BY n DESC
    `);
    for (const row of byCategory) console.log(`  ${row.category}: ${row.n}`);

    console.log('\n=== 3. sports markets (the three-way population) ===');
    const sports = await get(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE COALESCE(admin_verified,0) = 0) AS not_admin_verified,
               COUNT(*) FILTER (WHERE sidea IS NOT NULL AND sideb IS NOT NULL) AS has_both_sides,
               COUNT(*) FILTER (WHERE sidea NOT IN ('YES','NO','Home','Away','Unknown','')
                                 AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')) AS team_named
        FROM markets
        WHERE LOWER(COALESCE(category,'')) IN ('sports','football','soccer')
           OR LOWER(COALESCE(sport,'')) <> ''
           OR id LIKE 'fb\\_%' ESCAPE '\\'
           OR id LIKE 'sp\\_%' ESCAPE '\\'
           OR country = 'Football'
    `);
    console.log('  ', JSON.stringify(sports));

    console.log('\n=== 4. football rows (the backfill target) ===');
    const fb = await get(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE COALESCE(admin_verified,0) = 0) AS not_admin_verified,
               COUNT(*) FILTER (WHERE sidea NOT IN ('YES','NO','Home','Away','Unknown','')
                                 AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')) AS team_named,
               COUNT(*) FILTER (WHERE sidea NOT IN ('YES','NO','Home','Away','Unknown','')
                                 AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
                                 AND COALESCE(admin_verified,0) = 0) AS backfill_candidates,
               COUNT(*) FILTER (WHERE COALESCE(settled,0) = 1) AS settled,
               COUNT(*) FILTER (WHERE status IN ('open','upcoming','live')) AS live_now
        FROM markets
        WHERE id LIKE 'fb\\_%' ESCAPE '\\' OR LOWER(COALESCE(sport,'')) = 'football'
    `);
    console.log('  ', JSON.stringify(fb));

    console.log('\n=== 5. the backfill filter, row by row ===');
    const backfill = await all(`
        SELECT id, title, status, sidea, sideb, result, settled, admin_verified,
               COALESCE(oddsa,0) AS oddsA, COALESCE(oddsb,0) AS oddsB
        FROM markets
        WHERE (id LIKE 'fb\\_%' ESCAPE '\\' OR LOWER(COALESCE(sport,'')) = 'football')
          AND COALESCE(admin_verified,0) = 0
          AND sidea IS NOT NULL AND sideb IS NOT NULL
          AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
          AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
        ORDER BY starttime DESC NULLS LAST
        LIMIT 10
    `);
    console.log(`  backfill would touch ${backfill.length === 10 ? '10+' : backfill.length} row(s):`);
    for (const row of backfill) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 40)} | ${row.status} | ${row.sidea} v ${row.sideb} | odds ${row.oddsA}/${row.oddsB} | settled=${row.settled} result=${row.result}`);
    }

    console.log('\n=== 6. sample football rows NOT matching the backfill filter ===');
    const excluded = await all(`
        SELECT id, title, status, sidea, sideb, admin_verified
        FROM markets
        WHERE (id LIKE 'fb\\_%' ESCAPE '\\' OR LOWER(COALESCE(sport,'')) = 'football')
          AND NOT (COALESCE(admin_verified,0) = 0
                   AND sidea IS NOT NULL AND sideb IS NOT NULL
                   AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
                   AND sideb NOT IN ('YES','NO','Home','Away','Unknown',''))
        ORDER BY starttime DESC NULLS LAST
        LIMIT 6
    `);
    if (!excluded.length) console.log('  (none excluded)');
    for (const row of excluded) {
        console.log(`  ${row.id} | ${String(row.title).slice(0, 40)} | ${row.status} | A=${row.sidea} B=${row.sideb} | admin_verified=${row.admin_verified}`);
    }

    console.log('\n=== 7. recorded results on settled sports markets ===');
    const results = await all(`
        SELECT COALESCE(result,'(none)') AS result, COUNT(*) AS n
        FROM markets
        WHERE (LOWER(COALESCE(category,'')) IN ('sports','football','soccer')
           OR LOWER(COALESCE(sport,'')) <> '' OR id LIKE 'fb\\_%' ESCAPE '\\'
           OR id LIKE 'sp\\_%' ESCAPE '\\' OR country = 'Football')
          AND COALESCE(settled,0) = 1
        GROUP BY 1 ORDER BY n DESC
    `);
    if (!results.length) console.log('  (no settled sports markets)');
    for (const row of results) console.log(`  ${row.result}: ${row.n}`);

    console.log('\n=== 8. recorded results on settled NON-sports markets ===');
    const otherResults = await all(`
        SELECT COALESCE(result,'(none)') AS result, COUNT(*) AS n
        FROM markets
        WHERE NOT (LOWER(COALESCE(category,'')) IN ('sports','football','soccer')
           OR LOWER(COALESCE(sport,'')) <> '' OR id LIKE 'fb\\_%' ESCAPE '\\'
           OR id LIKE 'sp\\_%' ESCAPE '\\' OR country = 'Football')
          AND COALESCE(settled,0) = 1
        GROUP BY 1 ORDER BY n DESC
    `);
    if (!otherResults.length) console.log('  (no settled non-sports markets)');
    for (const row of otherResults) console.log(`  ${row.result}: ${row.n}`);

    console.log('\n=== 9. bets: what is recorded as the pick ===');
    const picks = await all(`
        SELECT COALESCE(picked,'(none)') AS picked, status, COUNT(*) AS n
        FROM bets GROUP BY 1,2 ORDER BY n DESC LIMIT 20
    `);
    if (!picks.length) console.log('  (no bets)');
    for (const row of picks) console.log(`  picked=${row.picked} status=${row.status} n=${row.n}`);

    console.log('\n=== 10. open markets that are bettable right now ===');
    const live = await get(`
        SELECT COUNT(*) AS n FROM markets
        WHERE status IN ('open','upcoming','live')
          AND COALESCE(event_end_time, starttime) > NOW()
          AND sidea IS NOT NULL AND sideb IS NOT NULL
    `);
    console.log('  ', JSON.stringify(live));
})()
    .catch(e => { console.error('INSPECT FAILED:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
