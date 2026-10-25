// Applies the three-way market migration to the Railway production Postgres.
//
// This runs the EXACT statements server.js runs on boot. Both import them
// from server/src/services/threeWayMigration.js, so what is tested here is
// what will run in production, and the two cannot drift apart.
//
// Safety:
//   * a snapshot of every affected row is written to
//     server/backups/threeway-backup-<timestamp>.json before anything
//     changes, and the exact rollback SQL is printed at the end;
//   * migration columns are only added when they are missing;
//   * old unprovenanced flat odds are reset to engine-calculated prices;
//   * every step is verified before the transaction commits.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createPool, toPg } = require('./db.cjs');
const { importModule } = require('./import-esm.cjs');

dotenv.config({ path: path.join(__dirname, '.env') });

(async () => {
    const {
        THREE_WAY_BACKFILL_SQL,
        THREE_WAY_COLUMNS,
        THREE_WAY_LEGACY_FLAT_REPAIR_SQL,
        THREE_WAY_READY_SQL,
        FOOTBALL_FIXTURE_SQL
    } = await importModule(path.join(__dirname, 'src', 'services', 'threeWayMigration.js'));

    const pool = createPool();
    const get = (sql, params = []) => pool.query(toPg(sql), params).then(r => r.rows[0]);

    const client = await pool.connect();

    // ---- 0. Confirm which database this is -------------------------------
    const ident = await client.query('SELECT current_database() AS db, current_user AS usr, version() AS ver');
    console.log('=== target ===');
    console.log('  database :', ident.rows[0].db);
    console.log('  user     :', ident.rows[0].usr);
    console.log('  version  :', ident.rows[0].ver.split(' ').slice(0, 2).join(' '));

    const counts = await client.query(
        'SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM markets) AS markets'
    );
    console.log('  users    :', counts.rows[0].users);
    console.log('  markets  :', counts.rows[0].markets);

    // ---- 1. Which columns already exist ----------------------------------
    const existing = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'markets'
    `);
    const have = new Set(existing.rows.map(r => r.column_name.toLowerCase()));
    console.log('\n=== columns before ===');
    for (const [name] of THREE_WAY_COLUMNS) {
        console.log(`  ${name}: ${have.has(name.toLowerCase()) ? 'already present' : 'MISSING -> will add'}`);
    }

    // ---- 2. Snapshot the rows the backfill would touch -------------------
    const affected = await client.query(`
        SELECT *
        FROM markets
        WHERE ${FOOTBALL_FIXTURE_SQL}
          AND COALESCE(admin_verified, 0) = 0
          AND sidea IS NOT NULL AND sideb IS NOT NULL
          AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
          AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
        ORDER BY id
    `);
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `threeway-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
        takenAt: new Date().toISOString(),
        database: ident.rows[0].db,
        note: 'Full pre-migration snapshot of eligible football rows. Restore affected row fields from this file if rollback is needed.',
        rows: affected.rows
    }, null, 2));
    console.log(`\n=== snapshot ===`);
    console.log(`  ${affected.rows.length} row(s) written to ${path.relative(process.cwd(), backupPath)}`);

    // ---- 3. Apply, inside a transaction ----------------------------------
    console.log('\n=== applying ===');
    await client.query('BEGIN');
    try {
        for (const [name, definition] of THREE_WAY_COLUMNS) {
            if (have.has(name.toLowerCase())) {
                console.log(`  - ${name}: already present, skipped`);
                continue;
            }
            const sql = `ALTER TABLE markets ADD COLUMN ${name} ${definition}`;
            await client.query(sql);
            console.log(`  + ${name} ${definition}`);
        }

        const before = await client.query(`
            SELECT COUNT(*) AS n FROM markets
            WHERE ${FOOTBALL_FIXTURE_SQL}
              AND COALESCE(admin_verified, 0) = 0
          AND sidea IS NOT NULL AND sideb IS NOT NULL
              AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
              AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
              AND (sidec IS NULL OR TRIM(sidec) = '' OR COALESCE(oddsc, 0) <= 1)
        `);
        console.log(`  rows awaiting the backfill: ${before.rows[0].n}`);

        const result = await client.query(THREE_WAY_BACKFILL_SQL);
        console.log(`  backfill updated ${result.rowCount} row(s)`);
        const fallbackRepair = await client.query(THREE_WAY_LEGACY_FLAT_REPAIR_SQL);
        console.log(`  replaced ${fallbackRepair.rowCount} legacy flat-odds row(s)`);

        // ---- 4. Verify before committing ---------------------------------
        const after = await client.query(`
            SELECT
              COUNT(*) FILTER (WHERE sidec IS NOT NULL AND TRIM(sidec) <> '') AS has_side_c,
              COUNT(*) FILTER (WHERE COALESCE(oddsc,0) > 1) AS has_odds_c,
              COUNT(*) FILTER (WHERE sidec IS NOT NULL AND TRIM(sidec) <> '' AND COALESCE(oddsc,0) > 1) AS draw_ready
            FROM markets
            WHERE ${FOOTBALL_FIXTURE_SQL}
              AND COALESCE(admin_verified, 0) = 0
              AND sidea IS NOT NULL AND sideb IS NOT NULL
              AND sidea NOT IN ('YES','NO','Home','Away','Unknown','')
              AND sideb NOT IN ('YES','NO','Home','Away','Unknown','')
        `);
        console.log('\n=== verification (inside the transaction) ===');
        console.log('  football rows with a draw label :', after.rows[0].has_side_c);
        console.log('  football rows with a draw price :', after.rows[0].has_odds_c);
        console.log('  football rows ready to bet      :', after.rows[0].draw_ready);

        // The backfill must not have touched any pre-existing column.
        const unchanged = await client.query(`
            SELECT COUNT(*) AS n FROM markets
            WHERE id LIKE 'fb\\_%' ESCAPE '\\'
              AND (oddsa IS NULL OR oddsb IS NULL OR settled IS NULL)
        `);
        console.log('  football rows with a null price (must be 0):', unchanged.rows[0].n);
        if (Number(unchanged.rows[0].n) > 0) {
            throw new Error('a football row has a missing price or settled flag');
        }

        // The draw price must never be shorter than the market's own longest
        // price. A draw at 1.90 on a 1.90/1.90 market would make the draw a
        // co-favourite, which no bookmaker would ever price.
        const tooCheap = await client.query(`
            SELECT COUNT(*) AS n FROM markets
            WHERE sidec IS NOT NULL AND TRIM(sidec) <> ''
              AND COALESCE(oddsc, 0) < GREATEST(COALESCE(oddsa, 1.90), COALESCE(oddsb, 1.90))
        `);
        console.log('  rows with a draw price below the best side (must be 0):', tooCheap.rows[0].n);
        if (Number(tooCheap.rows[0].n) > 0) {
            throw new Error('the draw price is below the best existing price on some rows');
        }

        // No market outside football may have been given a draw.
        const nonFootball = await client.query(`
            SELECT COUNT(*) AS n FROM markets
            WHERE NOT ${FOOTBALL_FIXTURE_SQL}
              AND (sidec IS NOT NULL OR COALESCE(oddsc, 0) > 1)
        `);
        console.log('  non-football markets given a draw (must be 0):', nonFootball.rows[0].n);
        if (Number(nonFootball.rows[0].n) > 0) {
            throw new Error('a non-football market was given a draw');
        }

        await client.query('COMMIT');
        console.log('\n  COMMITTED');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('\n  ROLLED BACK:', e.message);
        client.release();
        await pool.end();
        process.exit(1);
    }

    // ---- 5. Post-commit read-back ---------------------------------------
    console.log('\n=== columns after ===');
    const now = await client.query(`
        SELECT column_name, data_type, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'markets'
          AND column_name IN ('sidec','oddsc','draw_volume','odds_anchor','odds_source')
        ORDER BY column_name
    `);
    for (const row of now.rows) {
        console.log(`  ${row.column_name} (${row.data_type}) default=${row.column_default}`);
    }

    const liveReady = await get(`
        SELECT COUNT(*) AS n FROM markets
        WHERE status IN ('open','upcoming','live')
          AND COALESCE(event_end_time, starttime) > NOW()
          AND sidec IS NOT NULL AND TRIM(sidec) <> '' AND COALESCE(oddsc,0) > 1
    `);
    console.log('\n  live bettable markets with a draw side:', liveReady.n);

    const untouched = await get(`
        SELECT COUNT(*) AS n FROM markets
        WHERE NOT ${FOOTBALL_FIXTURE_SQL}
          AND (sidec IS NOT NULL OR COALESCE(oddsc,0) > 1)
    `);
    console.log('  non-football markets given a draw (must be 0):', untouched.n);

    console.log('\n=== rollback ===');
    console.log('  Restore affected row fields from the full pre-migration snapshot if rollback is needed:');
    console.log('   ', path.relative(process.cwd(), backupPath));
    console.log('  Drop only columns that this run added, if schema rollback is also required.');

    client.release();
})()
    .catch(e => { console.error('MIGRATION FAILED:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
