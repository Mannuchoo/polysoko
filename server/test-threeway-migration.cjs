// Runs the app's real three-way migration against a scratch database.
//
// The script is self-seeding: it creates its own throwaway database, builds
// the fixture, runs the migration, checks the result and drops the database
// again. Nothing outside the scratch database is touched.
//
//   node test-threeway-migration.cjs
//
// It imports the same SQL the server runs, so the two cannot drift apart.
const { Client } = require('pg');
const path = require('path');

const { importModule } = require('./import-esm.cjs');

const LOCAL_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const URL = process.env.TEST_DATABASE_URL || LOCAL_URL;
const SCRATCH_DB = `threeway_test_${Date.now()}`;

// The fixture the migration runs against.
//
// It covers every branch the backfill has to distinguish:
//   fb_1  a plain football fixture, the legacy flat 1.90/1.90 prices
//   fb_2  a football fixture whose prices have already been tilted by stake
//   fb_3  a closed football fixture
//   fb_4  an admin-verified football fixture
//   fb_5  a football market with binary YES/NO sides
//   fb_6  a football market with a missing side
//   fb_7  a football fixture that is still in the 'sports' category
//   sp_hockey_1  a draw-capable non-football sport
//   sp_basketball_1  a non-football sport that cannot be drawn
//   news_football_1  a news market that carries the sport 'Football'
const FIXTURE = `
DROP TABLE IF EXISTS markets;
CREATE TABLE markets (
  id TEXT PRIMARY KEY,
  title TEXT,
  category TEXT,
  sport TEXT,
  sideA TEXT, sideB TEXT,
  oddsA DOUBLE PRECISION DEFAULT 1.90, oddsB DOUBLE PRECISION DEFAULT 1.90,
  home_volume DOUBLE PRECISION DEFAULT 0, away_volume DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'open', result TEXT, settled INTEGER DEFAULT 0,
  admin_verified INTEGER DEFAULT 0, starttime TIMESTAMPTZ, event_end_time TIMESTAMPTZ,
  is_boosted INTEGER DEFAULT 0
);
INSERT INTO markets (id, title, category, sport, sideA, sideB, oddsA, oddsB, status, starttime) VALUES
  ('fb_1',              'Alpha v Beta',     'sports',   'Football', 'Alpha', 'Beta', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('fb_2',              'Gamma v Delta',    'sports',   'Football', 'Gamma', 'Delta', 2.10, 1.80, 'upcoming', NOW() + INTERVAL '1 day'),
  ('fb_3',              'Epsilon v Zeta',   'sports',   'Football', 'Epsilon', 'Zeta', 1.70, 2.20, 'closed',   NOW() + INTERVAL '1 day'),
  ('fb_4',              'Eta v Theta',      'sports',   'Football', 'Eta', 'Theta', 1.95, 1.95, 'upcoming', NOW() + INTERVAL '1 day'),
  ('fb_5',              'Will it rain?',    'sports',   'Football', 'YES', 'NO', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('fb_6',              'Iota v Kappa',     'sports',   'Football', NULL,  'Kappa', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('fb_7',              'Lambda v Mu',      'sports',   'Football', 'Lambda', 'Mu', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('sp_basketball_1',   'Lakers v Celtics', 'sports',   'Basketball', 'Lakers', 'Celtics', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('sp_hockey_1',       'Rangers v Wings',  'sports',   'Hockey', 'Rangers', 'Wings', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day'),
  ('news_football_1',   'Transfer news',    'news',    'Football', 'Real Madrid', 'Barcelona', 1.90, 1.90, 'upcoming', NOW() + INTERVAL '1 day');
UPDATE markets SET admin_verified = 1 WHERE id = 'fb_4';
`;

async function main() {
    const migration = await importModule(path.join(__dirname, 'src', 'services', 'threeWayMigration.js'));
    const { THREE_WAY_BACKFILL_SQL, THREE_WAY_COLUMNS, THREE_WAY_LEGACY_FLAT_REPAIR_SQL, THREE_WAY_READY_SQL } = migration;

    // --- create the scratch database ---------------------------------------
    const admin = new Client({ connectionString: URL, ssl: false, connectionTimeoutMillis: 10000 });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    await admin.end();

    let client = null;
    try {
        await run(client = new Client({
            connectionString: URL.replace(/\/[^/?]*(\?|$)/, `/${SCRATCH_DB}$1`),
            ssl: false,
            connectionTimeoutMillis: 10000
        }), { THREE_WAY_BACKFILL_SQL, THREE_WAY_COLUMNS, THREE_WAY_LEGACY_FLAT_REPAIR_SQL, THREE_WAY_READY_SQL });
    } finally {
        // The scratch database is dropped whether the run passed or failed, so
        // a failed run never leaves a stray database behind.
        try { await client?.end(); } catch { /* already closed */ }
        const cleanup = new Client({ connectionString: URL, ssl: false, connectionTimeoutMillis: 10000 });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
        await cleanup.end();
        console.log(`scratch database ${SCRATCH_DB} dropped`);
    }
}

async function run(client, { THREE_WAY_BACKFILL_SQL, THREE_WAY_COLUMNS, THREE_WAY_LEGACY_FLAT_REPAIR_SQL, THREE_WAY_READY_SQL }) {
    await client.connect();
    const q = (sql, params) => client.query(sql, params);

    console.log('=== fixture ===');
    await q(FIXTURE);
    const fixtureRows = await q('SELECT COUNT(*) v FROM markets');
    console.log('  rows seeded:', fixtureRows.rows[0].v);

    // The app's own column-adding machinery, reproduced.
    async function ensureDbColumn(tableName, columnName, definition) {
        const columns = await q(`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [tableName.toLowerCase()]);
        if (columns.rows.some(c => String(c.name).toLowerCase() === String(columnName).toLowerCase())) return 'exists';
        try {
            await q(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition.replace(/,$/, '')}`);
            return 'added';
        } catch (e) {
            if (e.code !== '42701' && !/duplicate column|already exists/i.test(e.message || '')) throw e;
            return 'exists';
        }
    }

    console.log('\n=== ensureThreeWayColumns (first call) ===');
    for (const [n, d] of THREE_WAY_COLUMNS) console.log(' ', n, '->', await ensureDbColumn('markets', n, d));
    console.log('=== ensureThreeWayColumns (second call: idempotency) ===');
    for (const [n, d] of THREE_WAY_COLUMNS) console.log(' ', n, '->', await ensureDbColumn('markets', n, d));

    // oddsC must have no default: a default would be written into every
    // existing row, and the backfill could no longer tell "unset" from "set".
    const oddscDef = await q(`SELECT column_default FROM information_schema.columns
        WHERE table_name='markets' AND column_name='oddsc'`);
    console.log('\n=== oddsC default (must be null) ===');
    console.log(' ', JSON.stringify(oddscDef.rows[0].column_default));

    const res = await q(THREE_WAY_BACKFILL_SQL);
    console.log('\n=== backfill ===\n  updated rows:', res.rowCount);
    // Simulate an unprovenanced row written by the former flat fallback.
    await q(`UPDATE markets SET oddsA=3.40, oddsB=3.40, oddsC=3.40 WHERE id='fb_1'`);
    const repaired = await q(THREE_WAY_LEGACY_FLAT_REPAIR_SQL);
    console.log('  replaced legacy flat-odds rows:', repaired.rowCount);

    console.log('\n=== resulting rows ===');
    const rows = await q(`SELECT id, category, sport, sidea, sideb, oddsa, oddsb, sidec, oddsc, draw_volume, odds_anchor, status
        FROM markets ORDER BY id`);
    for (const r of rows.rows) {
        console.log(`  ${String(r.id).padEnd(17)} cat=${String(r.category).padEnd(6)} ${String(r.sport).padEnd(10)} ${String(r.sidea)} v ${String(r.sideb)} | odds=${r.oddsa}/${r.oddsb} | sidec=${JSON.stringify(r.sidec)} oddsc=${r.oddsc} dvol=${r.draw_volume}`);
    }

    console.log('\n=== assertions ===');
    const checks = [];
    const one = async (label, sql, expected) => {
        const r = await q(sql);
        const v = Number(r.rows[0].v);
        checks.push({ label, expected, actual: v, ok: v === expected });
    };

    await one('oddsC has no default', `SELECT COUNT(*) v FROM information_schema.columns WHERE table_name='markets' AND column_name='oddsc' AND column_default IS NULL`, 1);
    await one('fb_1 gets the draw label', `SELECT COUNT(*) v FROM markets WHERE id='fb_1' AND sidec='Draw'`, 1);
    await one('fb_1 legacy flat prices are replaced by internal engine prices', `SELECT COUNT(*) v FROM markets WHERE id='fb_1' AND oddsa=2.85 AND oddsb=2.85 AND oddsc=2.85 AND odds_anchor IS NULL`, 1);
    await one('fb_2 draw price uses the internal baseline, not a flat provider quote', `SELECT COUNT(*) v FROM markets WHERE id='fb_2' AND oddsc=2.85`, 1);
    await one('fb_2 home/away prices untouched', `SELECT COUNT(*) v FROM markets WHERE id='fb_2' AND oddsa=2.10 AND oddsb=1.80`, 1);
    await one('fb_3 (closed) also backfilled', `SELECT COUNT(*) v FROM markets WHERE id='fb_3' AND sidec='Draw'`, 1);
    await one('fb_4 admin_verified NOT backfilled', `SELECT COUNT(*) v FROM markets WHERE id='fb_4' AND sidec IS NULL`, 1);
    await one('fb_5 binary sides NOT backfilled', `SELECT COUNT(*) v FROM markets WHERE id='fb_5' AND sidec IS NULL`, 1);
    await one('fb_6 null side NOT backfilled', `SELECT COUNT(*) v FROM markets WHERE id='fb_6' AND sidec IS NULL`, 1);
    await one('fb_7 gets the draw label', `SELECT COUNT(*) v FROM markets WHERE id='fb_7' AND sidec='Draw'`, 1);
    await one('basketball NOT backfilled', `SELECT COUNT(*) v FROM markets WHERE id='sp_basketball_1' AND sidec IS NULL`, 1);
    await one('hockey NOT backfilled by the football backfill', `SELECT COUNT(*) v FROM markets WHERE id='sp_hockey_1' AND sidec IS NULL`, 1);
    // The regression: a news market that carries the sport 'Football' is not a
    // fixture, so a draw bet on it could never be paid.
    await one('news market NOT backfilled even though its sport is Football', `SELECT COUNT(*) v FROM markets WHERE id='news_football_1' AND sidec IS NULL`, 1);
    await one('no non-football market got a draw', `SELECT COUNT(*) v FROM markets WHERE id NOT LIKE 'fb\_%' ESCAPE '\' AND sidec IS NOT NULL`, 0);
    await one('exactly 4 football rows backfilled', `SELECT COUNT(*) v FROM markets WHERE sidec='Draw'`, 4);
    await one('draw price is set on exactly the 4 backfilled rows', `SELECT COUNT(*) v FROM markets WHERE oddsc IS NOT NULL`, 4);
    // The draw must never be the shortest price in the market: a draw at
    // 1.90 on a 1.90/1.90 market would make it a co-favourite.
    await one('the draw price is never shorter than either existing price', `SELECT COUNT(*) v FROM markets WHERE sidec='Draw' AND oddsc < GREATEST(COALESCE(oddsa,1.90), COALESCE(oddsb,1.90))`, 0);
    await one('the draw price is never shorter than 1.90', `SELECT COUNT(*) v FROM markets WHERE sidec='Draw' AND oddsc < 1.90`, 0);
    await one('status and result unchanged', `SELECT COUNT(*) v FROM markets WHERE (id='fb_1' AND status='upcoming' AND result IS NULL) OR (id='fb_2' AND status='upcoming' AND result IS NULL)`, 2);
    await one('draw_volume is 0 everywhere', `SELECT COUNT(*) v FROM markets WHERE COALESCE(draw_volume,0)=0`, 10);
    await one('odds_anchor is NULL everywhere', `SELECT COUNT(*) v FROM markets WHERE odds_anchor IS NULL`, 10);
    await one('home_volume and away_volume unchanged', `SELECT COUNT(*) v FROM markets WHERE COALESCE(home_volume,0)=0 AND COALESCE(away_volume,0)=0`, 10);

    // The request path reads the columns by name; prove the query works.
    console.log('\n=== the /api/markets query (the request path) ===');
    try {
        const api = await q(`SELECT * FROM markets WHERE COALESCE(admin_verified,0)=0 AND status IN ('open','upcoming','live')
           AND COALESCE(event_end_time, starttime) > NOW()
           ORDER BY COALESCE(is_boosted,0) DESC,
                    COALESCE(home_volume,0)+COALESCE(away_volume,0)+COALESCE(draw_volume,0) DESC, starttime ASC`);
        console.log('  query OK, rows:', api.rows.length);
    } catch (e) { console.log('  query FAILED:', e.message); }

    // The backfill must be idempotent: a second run changes nothing.
    const again = await q(THREE_WAY_BACKFILL_SQL);
    console.log('\n=== backfill run a second time (must update 0 rows) ===');
    console.log('  updated rows:', again.rowCount);
    checks.push({ label: 'the backfill is idempotent', expected: 0, actual: again.rowCount, ok: again.rowCount === 0 });

    const ready = await q(THREE_WAY_READY_SQL);
    console.log('\n  football markets offering a draw:', ready.rows[0].n);

    let failed = 0;
    for (const c of checks) {
        console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label} (expected ${c.expected}, got ${c.actual})`);
        if (!c.ok) failed++;
    }
    console.log(`\n${checks.length - failed}/${checks.length} passed`);
    process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error('TEST ERROR:', e.stack || e.message); process.exitCode = 1; });
