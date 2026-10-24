import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { inspectMarketQuestionTitle } from '../src/services/marketGenerator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env'), quiet: true });

const connectionString = [
  'DATABASE_URL', 'DATABASE_PUBLIC_URL', 'DATABASE_PRIVATE_URL', 'POSTGRES_URL',
  'POSTGRESQL_URL', 'POSTGRES_URL_NON_POOLING', 'PGURL'
].map(key => String(process.env[key] || '').trim()).find(value => /^postgres(?:ql)?:\/\//i.test(value));
if (!connectionString) throw new Error('No PostgreSQL connection variable is configured.');

function shouldUseSsl(url) {
  if (process.env.NODE_ENV === 'production' || String(process.env.PGSSLMODE || '').toLowerCase() === 'require') return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(host) && !host.endsWith('.local');
  } catch { return false; }
}

const pool = new pg.Pool({ connectionString, ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
const deleteMode = process.argv.includes('--delete');

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT m.id, m.title, m.category, m.status,
        (SELECT COUNT(*)::int FROM bets b WHERE b.market_id = m.id AND b.status = 'active') AS active_bets
      FROM markets m
      WHERE m.title ILIKE '%Elon Musk%'
        AND m.title ~* '\\mrestore[[:space:]]+in[[:space:]]+Ukraine\\M'
      FOR UPDATE OF m
    `);
    const invalid = rows.filter(row => !inspectMarketQuestionTitle(row.title).valid);
    const deletableIds = invalid.filter(row => Number(row.active_bets) === 0).map(row => row.id);
    console.log(`${deleteMode ? 'Matched' : 'Preview'}: ${invalid.length} incomplete Elon Musk market title(s).`);
    for (const row of invalid) {
      const check = inspectMarketQuestionTitle(row.title);
      console.log(`${Number(row.active_bets) ? 'KEEP (active bets)' : deleteMode ? 'DELETE' : 'WOULD DELETE'}\t${row.id}\t${row.category}\t${row.status}\t${check.reason}\t${row.title}`);
    }

    if (deleteMode && deletableIds.length) {
      const deleted = await client.query(`
        DELETE FROM markets m
        WHERE m.id = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.market_id = m.id AND b.status = 'active')
        RETURNING m.id
      `, [deletableIds]);
      console.log(`Deleted ${deleted.rowCount} malformed market(s); active-bet markets were retained.`);
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
} finally {
  await pool.end();
}
