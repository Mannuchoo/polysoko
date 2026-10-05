const path = require('path');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
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

const sqlitePath = process.env.SQLITE_SOURCE || path.join(__dirname, 'terminal.db');
// Accept DATABASE_PUBLIC_URL as a fallback (Railway Postgres plugin sometimes
// only exposes the public proxy URL) and tolerate surrounding quotes.
const databaseUrl = cleanUrl(process.env.DATABASE_URL) || cleanUrl(process.env.DATABASE_PUBLIC_URL);

if (!databaseUrl || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
  console.error('DATABASE_URL must be set to a postgres:// or postgresql:// URL.');
  process.exit(1);
}

const sqlite = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
const pg = new Pool({
  connectionString: databaseUrl,
  ssl: (process.env.NODE_ENV === 'production' || process.env.PGSSLMODE === 'require')
    ? { rejectUnauthorized: false }
    : undefined,
});

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => sqlite.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

function ident(name) {
  const value = String(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Unsafe SQL identifier: ' + value);
  return value;
}

function translateCreateTable(sql) {
  return sql
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    // SQLite INTEGER is a 64-bit signed integer, so translate the remaining INTEGER
    // columns to BIGINT to avoid range errors (e.g. millisecond timestamps).
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/\bBLOB\b/gi, 'BYTEA')
    .replace(/DEFAULT\s+\(?datetime\([^)]*\)\)?/gi, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/DEFAULT\s+\(?CURRENT_TIMESTAMP\)?/gi, 'DEFAULT CURRENT_TIMESTAMP')
    // SQLite allows double-quoted string defaults (e.g. DEFAULT"active" or DEFAULT "active").
    // Postgres treats "active" as an identifier, not a string literal, so convert any
    // double-quoted default into a single-quoted literal and guarantee a space after DEFAULT.
    .replace(/DEFAULT\s*"((?:[^"]|"")*)"/gi, (match, value) => {
      const literal = value.replace(/""/g, '"').replace(/'/g, "''");
      return `DEFAULT '${literal}'`;
    })
    // Replace or strip invalid DEFAULT column references / expressions
    .replace(/DEFAULT\s+\(?([a-zA-Z_][a-zA-Z0-9_]*)\)?/gi, (match, word) => {
      const upper = word.toUpperCase();
      const allowedKeywords = ['CURRENT_TIMESTAMP', 'NULL', 'TRUE', 'FALSE', 'NOW'];
      if (allowedKeywords.includes(upper) || !isNaN(word)) {
        return match;
      }
      if (upper.includes('DATE') || upper.includes('TIME') || upper.includes('AT')) {
        return 'DEFAULT CURRENT_TIMESTAMP';
      }
      return ''; // Strip non-constant default clause
    });
}

function isTemporalType(type) {
  return /DATE|TIME/i.test(String(type || ''));
}

// SQLite is dynamically typed, so a column declared DATETIME can hold arbitrary text
// (for example a status string such as 'closed'). Postgres is strict, so a value in a
// temporal column that is not a valid timestamp is stored as NULL instead of aborting
// the whole migration.
function normalizeTemporalValue(value) {
  if (value == null || value instanceof Date || typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || !Number.isNaN(Date.parse(text))) return text;
  return null;
}

async function main() {
  const tables = await sqliteAll(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  console.log(`Migrating ${tables.length} tables from ${sqlitePath}`);

  for (const table of tables) {
    if (!table.sql) continue;
    await pg.query(`DROP TABLE IF EXISTS ${ident(table.name)} CASCADE`);
    const translatedSql = translateCreateTable(table.sql);
    try {
      await pg.query(translatedSql);
      console.log(`Ensured table ${table.name}`);
    } catch (err) {
      console.error(`Failed SQL for table ${table.name}:\n${translatedSql}`);
      throw err;
    }
  }

  for (const table of tables) {
    const columns = await sqliteAll(`PRAGMA table_info(${table.name})`);
    const columnNames = columns.map(col => col.name);
    if (!columnNames.length) continue;

    const rows = await sqliteAll(`SELECT * FROM ${ident(table.name)}`);
    if (!rows.length) {
      console.log(`Skipped ${table.name}: 0 rows`);
      continue;
    }

    const quotedColumns = columnNames.map(ident).join(', ');
    const placeholders = columnNames.map((_, index) => `$${index + 1}`).join(', ');
    const insertSql = `INSERT INTO ${ident(table.name)} (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    const temporalColumns = new Set(columns.filter(col => isTemporalType(col.type)).map(col => col.name));
    const valuesFor = (row) => columnNames.map((name) => (
      temporalColumns.has(name) ? normalizeTemporalValue(row[name]) : row[name]
    ));

    for (const row of rows) {
      await pg.query(insertSql, valuesFor(row));
    }

    if (columnNames.includes('id')) {
      await pg.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${ident(table.name)}), 1), (SELECT MAX(id) FROM ${ident(table.name)}) IS NOT NULL)`,
        [table.name]
      ).catch(() => {});
    }

    console.log(`Copied ${rows.length} rows into ${table.name}`);
  }
}

main()
  .then(async () => {
    await pg.end();
    sqlite.close();
    console.log('Postgres migration complete.');
  })
  .catch(async (err) => {
    console.error('Postgres migration failed:', err.message);
    await pg.end().catch(() => {});
    sqlite.close();
    process.exit(1);
  });