import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env'), quiet: true });

const connectionString = [
  'DATABASE_URL', 'DATABASE_PUBLIC_URL', 'DATABASE_PRIVATE_URL', 'POSTGRES_URL',
  'POSTGRESQL_URL', 'POSTGRES_URL_NON_POOLING', 'PGURL'
].map(key => String(process.env[key] || '').trim()).find(value => /^postgres(?:ql)?:\/\//i.test(value));

if (!connectionString) {
  console.error('No PostgreSQL connection variable is configured.');
  process.exit(1);
}

function shouldUseSsl(url) {
  if (process.env.NODE_ENV === 'production' || String(process.env.PGSSLMODE || '').toLowerCase() === 'require') return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(host) && !host.endsWith('.local');
  } catch { return false; }
}

const pool = new pg.Pool({
  connectionString,
  ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined
});
const deleteMode = process.argv.includes('--delete');
const malformedUtcDeadline = '[[:space:]]by[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|\\+00:00)[[:space:]]*\\??$';

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT m.id, m.title, m.category, m.status,
        (SELECT COUNT(*)::int FROM bets b WHERE b.market_id = m.id AND b.status = 'active') AS active_bets
      FROM markets m
      WHERE LOWER(COALESCE(m.category, '')) IN ('weather', 'movies', 'movie')
        AND m.title ~* $1
      ORDER BY LOWER(m.category), m.id
      FOR UPDATE OF m
    `, [malformedUtcDeadline]);

    const deletable = rows.filter(row => Number(row.active_bets) === 0);
    const protectedMarkets = rows.filter(row => Number(row.active_bets) > 0);
    console.log(`${deleteMode ? 'Matched' : 'Preview'}: ${rows.length} malformed weather/movie market(s).`);
    for (const row of rows) {
      console.log(`${Number(row.active_bets) ? 'KEEP (active bets)' : (deleteMode ? 'DELETE' : 'WOULD DELETE')}\t${row.id}\t${row.category}\t${row.status}\tactive bets=${row.active_bets}\t${row.title}`);
    }

    if (deleteMode && deletable.length) {
      const ids = deletable.map(row => row.id);
      const deleted = await client.query(`
        DELETE FROM markets m
        WHERE m.id = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.market_id = m.id AND b.status = 'active')
        RETURNING m.id
      `, [ids]);
      console.log(`Deleted ${deleted.rowCount} malformed market(s); retained ${protectedMarkets.length} with active bets.`);
    } else {
      console.log(deleteMode ? 'No eligible market rows to delete.' : 'Dry run only. Pass --delete to remove eligible rows.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`Weather/movie market cleanup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
