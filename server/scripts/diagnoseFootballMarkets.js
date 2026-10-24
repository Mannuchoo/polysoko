import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env'), quiet: true });
const envValue = (...keys) => keys.map(key => String(process.env[key] || '').trim()).find(Boolean) || '';
const connectionString = envValue('DATABASE_URL', 'DATABASE_PUBLIC_URL', 'DATABASE_PRIVATE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'POSTGRES_URL_NON_POOLING', 'PGURL');
const apiFootballKey = envValue('API_FOOTBALL_KEY', 'API_SPORTS_KEY', 'FOOTBALL_API_KEY');
if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error('No PostgreSQL connection variable is configured.');

function shouldUseSsl(url) {
  if (process.env.NODE_ENV === 'production' || String(process.env.PGSSLMODE || '').toLowerCase() === 'require') return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(host) && !host.endsWith('.local');
  } catch { return false; }
}

const pool = new pg.Pool({ connectionString, ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined });
try {
  const summary = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('open','upcoming','live'))::int AS allowed_status,
      COUNT(*) FILTER (WHERE COALESCE(event_end_time,startTime) > NOW())::int AS future_deadline,
      COUNT(*) FILTER (WHERE status IN ('open','upcoming','live') AND COALESCE(event_end_time,startTime) > NOW()
        AND sideA IS NOT NULL AND sideB IS NOT NULL AND sideA NOT IN ('Home','Away','Unknown','') AND sideB NOT IN ('Home','Away','Unknown',''))::int AS public_visible
    FROM markets WHERE left(id, 3) = 'fb_'
  `);
  const latest = await pool.query(`
    SELECT id, title, category, sport, status, startTime, event_end_time
    FROM markets WHERE left(id, 3) = 'fb_'
    ORDER BY startTime DESC NULLS LAST LIMIT 8
  `);
  console.log(JSON.stringify({
    localApiFootballKeyConfigured: Boolean(apiFootballKey),
    sportsMonksKeyConfigured: Boolean(String(process.env.SPORTS_API_KEY || '').trim()),
    database: summary.rows[0],
    latestFootballMarkets: latest.rows
  }, null, 2));
} finally {
  await pool.end();
}
