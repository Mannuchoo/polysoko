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
if (!connectionString) throw new Error('No PostgreSQL connection variable is configured.');

const timestamp = String(process.argv.find(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) || '').trim();
if (!timestamp) throw new Error('Pass an exact UTC timestamp, for example 2026-10-25T00:10:40.333Z.');
const deleteMode = process.argv.includes('--delete');

function shouldUseSsl(url) {
  if (process.env.NODE_ENV === 'production' || String(process.env.PGSSLMODE || '').toLowerCase() === 'require') return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(host) && !host.endsWith('.local');
  } catch { return false; }
}

const pool = new pg.Pool({ connectionString, ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT m.id, m.title, m.category, m.status,
        (SELECT COUNT(*)::int FROM bets b WHERE b.market_id = m.id AND b.status = 'active') AS active_bets
      FROM markets m
      WHERE POSITION($1 IN COALESCE(m.title, '')) > 0
      ORDER BY m.category, m.id
      FOR UPDATE OF m
    `, [timestamp]);
    const deletableIds = rows.filter(row => Number(row.active_bets) === 0).map(row => row.id);
    const protectedCount = rows.length - deletableIds.length;
    console.log(`${deleteMode ? 'Matched' : 'Preview'}: ${rows.length} market(s) containing ${timestamp}.`);
    for (const row of rows) {
      console.log(`${Number(row.active_bets) ? 'KEEP (active bets)' : deleteMode ? 'DELETE' : 'WOULD DELETE'}\t${row.id}\t${row.category}\t${row.status}\tactive bets=${row.active_bets}\t${row.title}`);
    }
    if (deleteMode && deletableIds.length) {
      const deleted = await client.query(`
        DELETE FROM markets m
        WHERE m.id = ANY($1::text[])
          AND POSITION($2 IN COALESCE(m.title, '')) > 0
          AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.market_id = m.id AND b.status = 'active')
        RETURNING m.id
      `, [deletableIds, timestamp]);
      console.log(`Deleted ${deleted.rowCount}; retained ${protectedCount} with active bets.`);
    } else {
      console.log(deleteMode ? 'No eligible market rows to delete.' : 'Dry run only. Add --delete to remove eligible rows.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
