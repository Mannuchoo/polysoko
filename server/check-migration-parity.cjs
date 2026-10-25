// Read-only check: is the app's own column-adding machinery working in
// production?
//
// Every column the app adds through addColumnSafely() should be present. If
// they are, the machinery works and the missing three-way odds columns are
// simply the new code that has not been deployed yet. If they are not, the
// migration path itself is broken and needs fixing first.
//
// SELECT only.
const path = require('path');
const dotenv = require('dotenv');
const { createPool, toPg } = require('./db.cjs');

dotenv.config({ path: path.join(__dirname, '.env') });
const pool = createPool();

// The columns server.js adds through addColumnSafely(), with the table they
// belong to. These were added in earlier releases, so a production database
// that has them proves the ALTER TABLE path works.
const ADDED_OVER_TIME = [
    ['users', 'crypto_balance'],
    ['markets', 'category'],
    ['markets', 'league'],
    ['markets', 'country'],
    ['markets', 'startTime'],
    ['markets', 'result'],
    ['markets', 'settled'],
    ['markets', 'media_url'],
    ['markets', 'media_type'],
    ['markets', 'image_url'],
    ['markets', 'video_url'],
    ['markets', 'content'],
    ['markets', 'admin_verified'],
    ['markets', 'ai_headline_generated'],
    ['markets', 'headline_version'],
    ['markets', 'settled_at'],
    ['markets', 'url'],
    ['markets', 'is_boosted'],
    ['markets', 'event_start_time'],
    ['markets', 'event_end_time'],
    ['markets', 'creator'],
    ['markets', 'ai_generated'],
    ['transactions', 'odds'],
    ['transactions', 'settled_amount'],
    ['transactions', 'potential_payout'],
    ['transactions', 'bet_id'],
    ['transactions', 'mpesa_receipt'],
    ['transactions', 'internal_id'],
    ['transactions', 'is_boosted'],
    ['bets', 'is_boosted'],
    ['bets', 'transaction_id'],
    ['bets', 'reference'],
    ['users', 'verification_token'],
    ['users', 'is_upgraded'],
    ['users', 'upgrade_expiry'],
    ['users', 'is_suspended'],
    ['users', 'avatar_mime'],
    ['users', 'avatar_data'],
    ['password_resets', 'otp'],
    ['password_resets', 'expires']
];

(async () => {
    console.log('=== columns added by addColumnSafely() in earlier releases ===');
    let missing = 0;
    for (const [table, column] of ADDED_OVER_TIME) {
        const r = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column.toLowerCase()]
        );
        const present = Number(r.rows[0].n) > 0;
        if (!present) missing++;
        console.log(`  ${present ? 'ok  ' : 'MISS'} ${table}.${column}`);
    }
    console.log(`\n  ${ADDED_OVER_TIME.length - missing}/${ADDED_OVER_TIME.length} present, ${missing} missing`);
    console.log(missing === 0
        ? '  => the ALTER TABLE path works in production. The three-way odds columns are absent because the new code has not been deployed yet.'
        : '  => the ALTER TABLE path is NOT working. Fix that before deploying.');

    console.log('\n=== the three-way and odds-provenance columns (new code, not yet deployed) ===');
    for (const column of ['sideC', 'oddsC', 'draw_volume', 'odds_anchor', 'odds_source']) {
        const r = await pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'markets' AND column_name = $1`,
            [column.toLowerCase()]
        );
        console.log(`  ${Number(r.rows[0].n) > 0 ? 'ok  ' : 'MISS'} markets.${column}`);
    }
})()
    .catch(e => { console.error('CHECK FAILED:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
