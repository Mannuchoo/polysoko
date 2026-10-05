const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

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

function resolveDatabaseUrl() {
  return cleanUrl(process.env.DATABASE_URL) || cleanUrl(process.env.DATABASE_PUBLIC_URL);
}

// Shared Postgres helper for the server utility scripts. The project is
// Postgres-only: there is no SQLite fallback anywhere (a container-local
// .db file is wiped on every Railway redeploy, which used to silently
// revert passwords and delete accounts).
function createPool() {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    console.error('DATABASE_URL (or DATABASE_PUBLIC_URL) must be set to a postgres:// URL.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err.message));
  return pool;
}

// The old sqlite scripts used `?` placeholders; translate them to $1, $2, ...
function toPg(sql) {
  let index = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i++; }
        else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '?') { out += '$' + (++index); continue; }
    out += ch;
  }
  return out;
}

module.exports = { createPool, toPg, resolveDatabaseUrl };
