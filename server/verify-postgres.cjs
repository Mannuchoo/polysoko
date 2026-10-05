const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

function cleanUrl(value) {
  if (value == null) return '';
  let raw = String(value).trim();
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      raw = raw.slice(1, -1).trim();
    }
  }
  return raw;
}

const databaseUrl = cleanUrl(process.env.DATABASE_URL) || cleanUrl(process.env.DATABASE_PUBLIC_URL);
if (!databaseUrl || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  console.error('DATABASE_URL must be set to a postgres:// or postgresql:// URL.');
  process.exit(1);
}

const { Pool } = require('pg');
const pg = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  for (const sql of [
    'SELECT COUNT(*) AS c FROM users',
    'SELECT phone, status, role FROM users ORDER BY id LIMIT 10',
    'SELECT COUNT(*) AS c FROM markets',
    'SELECT COUNT(*) AS c FROM transactions',
    'SELECT COUNT(*) AS c FROM bets',
  ]) {
    const r = await pg.query(sql);
    console.log(sql + ' => ' + JSON.stringify(r.rows));
  }
  await pg.end();
})().catch(async (e) => {
  console.error('VERIFY-FAILED: ' + (e.message || e));
  await pg.end().catch(() => {});
  process.exit(1);
});
