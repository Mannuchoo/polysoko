import express from 'express';
import path from 'path'; // Moved up
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; // For __dirname fix
import { dirname, join } from 'path';

// --- CRITICAL: Define __dirname for ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- NOW load the config before anything else ---
dotenv.config({ path: path.join(__dirname, '.env') });

// --- NOW import the rest of your libraries ---
import axios from 'axios';
import cors from 'cors';
import http from 'http';
import { Server } from "socket.io";
import sqlite3 from 'sqlite3';
import pg from 'pg';
import { AsyncLocalStorage, AsyncResource } from 'async_hooks';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import AfricasTalking from 'africastalking';
import fs from 'fs';
import helmet from 'helmet';
import { exec } from 'child_process';
import { getSokoBalance, sendSoko, getAdminWalletAddress, isValidAddress } from './blockchain.js';

const app = express();
const server = http.createServer(app);
const DEFAULT_PUBLIC_SITE_URL = 'https://polysoko.online';
const DEFAULT_PUBLIC_API_BASE = 'https://api.polysoko.online';

function cleanPublicUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

// Legacy/stale hosts that must never be used to build links sent to users.
// `server351.web-hosting.com` was the previous shared host: verification emails and
// the M-Pesa callback still pointed there, so users followed links into the void and
// Safaricom never reached the live API. Anything matching these patterns is ignored in
// favour of the canonical domains below.
const STALE_HOST_PATTERN = /server351\.web-hosting\.com/i;
const isStaleUrl = (value) => STALE_HOST_PATTERN.test(String(value || ''));
const resolveCanonicalUrl = (value, fallback) => {
    const cleaned = cleanPublicUrl(value);
    return (!cleaned || isStaleUrl(cleaned)) ? fallback : cleaned;
};

// Canonical public URLs used for every user-facing link and the M-Pesa callback.
const PUBLIC_SITE_URL = resolveCanonicalUrl(
    process.env.PUBLIC_SITE_URL || process.env.APP_URL,
    DEFAULT_PUBLIC_SITE_URL
);
const PUBLIC_API_BASE = resolveCanonicalUrl(
    process.env.PUBLIC_API_BASE || process.env.API_PUBLIC_URL,
    DEFAULT_PUBLIC_API_BASE
);
// M-Pesa posts its STK callback here, so it must be an absolute URL on the live API.
const STK_CALLBACK_URL = resolveCanonicalUrl(
    process.env.CALLBACK_URL,
    `${DEFAULT_PUBLIC_API_BASE}/api/stkcallback`
);

// Aliases kept for the existing CORS / CSP / asset-URL call sites below.
const configuredPublicSiteUrl = PUBLIC_SITE_URL;
const configuredPublicApiBase = PUBLIC_API_BASE;

// Startup diagnostics: stale host configuration silently sends verification emails and
// M-Pesa callbacks to the wrong server, which is very hard to notice from the outside.
console.log(`📧 Email transport: ${process.env.EMAIL_USER ? `Gmail as ${process.env.EMAIL_USER}` : 'NOT CONFIGURED (emails will not send)'}`);
console.log(`🔗 Public site URL : ${PUBLIC_SITE_URL}`);
console.log(`🔗 Public API base : ${PUBLIC_API_BASE}`);
console.log(`🔁 M-Pesa STK callback: ${STK_CALLBACK_URL}`);
for (const [name, value] of [
    ['APP_URL', process.env.APP_URL],
    ['BASE_URL', process.env.BASE_URL],
    ['PUBLIC_SITE_URL', process.env.PUBLIC_SITE_URL],
    ['PUBLIC_API_BASE', process.env.PUBLIC_API_BASE],
    ['CALLBACK_URL', process.env.CALLBACK_URL]
]) {
    if (isStaleUrl(value)) {
        console.warn(`⚠️  Ignoring stale ${name}=${value}; using ${PUBLIC_SITE_URL} / ${PUBLIC_API_BASE} instead.`);
    }
}
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(cleanPublicUrl)
    .filter(Boolean);

const developmentCorsOrigins = process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:3000'];
const allowedOrigins = [
    'https://mannuchoo.github.io',
    'https://polysoko.online',
    'https://www.polysoko.online',
    'http://localhost:3000',
    'http://localhost:5173',
    configuredPublicSiteUrl,
    configuredPublicApiBase,
    ...configuredCorsOrigins,
    ...developmentCorsOrigins
].filter(Boolean);
const corsOptions = {
    origin(origin, cb) {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
const io = new Server(server, { cors: corsOptions });

// Trust one proxy hop for production load balancers and reverse proxies.
app.set('trust proxy', 1);

const publicPath = path.join(__dirname, '..');
const matchCache = new Map();
const noStoreValue = 'no-store, no-cache, must-revalidate, proxy-revalidate';
function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', noStoreValue);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

const staticOptions = {
    etag: false,
    lastModified: false,
    setHeaders(res) {
        setNoStoreHeaders(res);
    }
};

const PORT = process.env.PORT || 3000;
const ADMIN_TILL = process.env.MPESA_TILL || process.env.BUYGOODS_TILL || '4447028';
const MPESA_ENV = String(process.env.MPESA_ENV || 'sandbox').toLowerCase();
const MPESA_BASE_URL = MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
const MPESA_STK_SHORTCODE = process.env.MPESA_STK_SHORTCODE || (MPESA_ENV === 'sandbox' ? '174379' : process.env.MPESA_SHORTCODE);
const MPESA_STK_PASSKEY = process.env.MPESA_STK_PASSKEY || process.env.MPESA_PASSKEY;
const MPESA_STK_TRANSACTION_TYPE = process.env.MPESA_STK_TRANSACTION_TYPE || (MPESA_ENV === 'production' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline');
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_B2C_SHORTCODE = process.env.MPESA_B2C_SHORTCODE || (MPESA_ENV === 'sandbox' ? '600989' : process.env.MPESA_SHORTCODE);
const MPESA_B2C_INITIATOR = process.env.MPESA_B2C_INITIATOR || process.env.MPESA_INITIATOR;
const MPESA_B2C_SECURITY_CREDENTIAL = process.env.MPESA_B2C_SECURITY_CREDENTIAL || process.env.MPESA_SECURITY_CREDENTIAL;
const MPESA_B2C_COMMAND_ID = process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment';
const API_SPORTS_KEY = process.env.SPORTS_API_KEY || process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const sportsSyncDaysConfig = Number(process.env.SPORTS_SYNC_DAYS || 14);
const SPORTS_SYNC_DAYS = Number.isFinite(sportsSyncDaysConfig)
    ? Math.max(2, Math.min(sportsSyncDaysConfig, 30))
    : 14;
const DEFAULT_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
// AfricasTalking validates its credentials at construction time and throws
// ("Username can't be blank") when AT_USERNAME / AT_API_KEY are absent. That throw
// happened at module scope, so the process died before binding a port and Railway
// reported "Application failed to respond". Build the client defensively: SMS is
// simply unavailable until the credentials are configured.
let at = null;
let sms = null;
try {
    if (process.env.AT_USERNAME && process.env.AT_API_KEY) {
        at = AfricasTalking({
            apiKey: process.env.AT_API_KEY,
            username: process.env.AT_USERNAME
        });
        sms = at.SMS;
    } else {
        console.error('[WARN] AT_USERNAME / AT_API_KEY not set; SMS notifications are disabled.');
    }
} catch (err) {
    console.error('[WARN] Failed to initialise AfricasTalking client; SMS disabled:', err.message);
}

// Safe wrapper so the many `sms.send(...)` call sites keep working (and simply
// become no-ops) when Africa's Talking credentials are not configured. Without this,
// any code path that tried to notify a user would throw a TypeError on `null`.
const sendSms = async (options) => {
    if (!sms) return { skipped: true, reason: 'AfricasTalking not configured' };
    return sms.send(options);
};

app.use(
  helmet({
        contentSecurityPolicy: {
     directives: {
        "upgrade-insecure-requests": null,
                "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.socket.io"], // Allow common CDNs as needed
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                "connect-src": ["'self'", configuredPublicSiteUrl, configuredPublicApiBase, "https://ipapi.co", "https://*.ipapi.co", "https://api.weatherapi.com", "https://nominatim.openstreetmap.org", "ws:", "wss:"],
        "frame-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
        "media-src": ["'self'", "data:", "blob:", "https:"],
        "img-src": ["'self'", "data:", "https:"],
     },
    },
  })
);
app.disable('x-powered-by');
// CORS must be registered before any API route, body parser or request handler so
// that preflight (OPTIONS) requests from the static GitHub Pages frontend are
// answered with the correct Access-Control-* headers before anything else runs.
app.use(cors(corsOptions));
app.use(express.json({ limit: '120kb' }));
app.use(express.urlencoded({ extended: false, limit: '120kb' }));
app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(self)');
    if (req.method === 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) setNoStoreHeaders(res);
    next();
});
// Health probe used by Railway's deployment healthcheck. Registered ahead of the
// global rate limiter so that platform probes never consume the public API quota.
// Reports database reachability, but always returns 200 while the HTTP server is
// listening so a transient DB blip cannot cause a restart loop.
app.get('/api/health', async (req, res) => {
    let database = 'unknown';
    let databaseReachable = false;
    try {
        await dbGet('SELECT 1 AS ok');
        databaseReachable = true;
        database = isPostgresDatabaseUrl ? 'postgresql' : 'sqlite';
    } catch (err) {
        database = `unreachable: ${err.message}`;
    }
    const mailConfigured = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
    // A SQLite file is wiped on every deploy, which silently reverts password
    // changes and deletes accounts. Expose it so monitoring can catch it.
    const databasePersistent = isPostgresDatabaseUrl;
    const warnings = [];
    if (!databasePersistent) {
        warnings.push('Database is SQLite on an ephemeral container filesystem: all data (including password changes) is lost on every deploy. Set DATABASE_URL to a Postgres URL.');
    }
    if (!getJwtSecrets().length) {
        warnings.push('No JWT signing secret is available; logins will fail.');
    }
    res.status(200).json({
        success: true,
        service: 'polysoko-api',
        status: databaseReachable && !warnings.length ? 'healthy' : 'degraded',
        port: Number(PORT) || null,
        database,
        databaseReachable,
        databasePersistent,
        jwtConfigured: getJwtSecrets().length > 0,
        jwtSecretSource,
        mailConfigured,
        publicSiteUrl: PUBLIC_SITE_URL,
        publicApiBase: PUBLIC_API_BASE,
        uptimeSeconds: Math.round(process.uptime()),
        warnings,
        timestamp: new Date().toISOString()
    });
});

function mpesaConfigStatus() {
    const stkReady = !!(MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_STK_SHORTCODE && MPESA_STK_PASSKEY && STK_CALLBACK_URL);
    const b2cReady = !!(MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_B2C_SHORTCODE && MPESA_B2C_INITIATOR && MPESA_B2C_SECURITY_CREDENTIAL && PUBLIC_API_BASE);
    return {
        env: MPESA_ENV,
        baseUrl: MPESA_BASE_URL,
        stkReady,
        b2cReady,
        stkShortcode: MPESA_STK_SHORTCODE || null,
        stkTransactionType: MPESA_STK_TRANSACTION_TYPE,
        b2cShortcode: MPESA_B2C_SHORTCODE || null,
        b2cCommandId: MPESA_B2C_COMMAND_ID,
        callbackUrl: STK_CALLBACK_URL,
        b2cResultUrl: `${PUBLIC_API_BASE}/api/mpesa/result`,
        b2cTimeoutUrl: `${PUBLIC_API_BASE}/api/mpesa/timeout`,
        till: ADMIN_TILL
    };
}

async function getMpesaAccessToken() {
    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
        throw new Error('M-Pesa consumer key and secret are not configured.');
    }

    const tokenRes = await axios.get(
        `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { auth: { username: MPESA_CONSUMER_KEY, password: MPESA_CONSUMER_SECRET } }
    );
    return tokenRes.data.access_token;
}
// Serve a default avatar fallback when the explicit default.png file is missing
app.get('/uploads/avatars/default.png', (req, res) => {
    const fallback = path.join(publicPath, 'logo-mark.png');
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    res.status(404).end();
});

// Serve avatars from the database. Registered BEFORE express.static so a stored
// picture always wins over the (ephemeral) on-disk copy.
app.get('/api/avatar/:phone', async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ success: false, message: 'Invalid phone number' });

    try {
        const row = await dbGet(`SELECT avatar_mime, avatar_data FROM users WHERE phone = ?`, [phone]);
        const data = row?.avatar_data;
        if (!data || !Buffer.isBuffer(data) || data.length === 0) {
            const fallback = path.join(publicPath, 'logo-mark.png');
            if (fs.existsSync(fallback)) return res.sendFile(fallback);
            return res.status(404).json({ success: false, message: 'No profile picture' });
        }

        res.setHeader('Content-Type', row.avatar_mime || 'image/jpeg');
        // Avatars are immutable per phone (a new upload replaces the bytes), so a
        // short private cache avoids re-downloading on every page load while still
        // picking up replacements quickly.
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(data);
    } catch (e) {
        console.error('Avatar serve failed:', e.message);
        return res.status(500).json({ success: false, message: 'Could not load profile picture' });
    }
});

// A missing avatar used to fall through to the HTML error handler, so the
// browser received text/html for an <img> and rendered a broken image. Answer
// with the logo instead so the UI degrades gracefully.
app.get(/^\/uploads\/avatars\/.+\.(png|jpe?g|webp|gif)$/i, (req, res) => {
    const fallback = path.join(publicPath, 'logo-mark.png');
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    res.status(404).end();
});

app.use('/public/server', (req, res) => res.status(404).end());
app.use('/server', (req, res) => res.status(404).end());
app.use(express.static(publicPath, staticOptions));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
}));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Please wait and try again." }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many uploads. Please wait and try again." }
});

function sqlitePathFromDatabaseUrl(value) {
    if (!value) return path.join(__dirname, 'terminal.db');
    const raw = String(value).trim();
    if (!raw) return path.join(__dirname, 'terminal.db');
    if (raw.startsWith('sqlite://')) return raw.replace(/^sqlite:\/\//, '');
    if (raw.startsWith('file:')) return new URL(raw).pathname;
    return raw;
}

const isPostgresDatabaseUrl = /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL || '');

// A SQLite file lives on the container's ephemeral filesystem. Railway wipes it on
// every deploy/scale event, so users, balances, bets AND password changes are all
// reverted to whatever snapshot was committed to git. That silently rolled every
// password back on each deploy, which looked like "my password is now incorrect".
if (!isPostgresDatabaseUrl) {
    console.warn('');
    console.warn('╔══════════════════════════════════════════════════════════════╗');
    console.warn('║  DATABASE NOT PERSISTENT - DATA WILL BE LOST ON EVERY DEPLOY   ║');
    console.warn('╚══════════════════════════════════════════════════════════════╝');
    console.warn('  No postgres DATABASE_URL is configured, so the app is using the');
    console.warn('  SQLite file at server/terminal.db, which lives on the container');
    console.warn('  filesystem. Railway discards it on every redeploy, restoring the');
    console.warn('  copy committed to git.');
    console.warn('  CONSEQUENCE: accounts, balances, bets, avatars and PASSWORD CHANGES');
    console.warn('  are all reverted on every deploy.');
    console.warn('  FIX: set DATABASE_URL to your Postgres URL in the host dashboard,');
    console.warn('       run `npm run migrate:postgres`, and only then untrack the file');
    console.warn('       with `git rm --cached server/terminal.db`.');
    console.warn('');
}

function normalizeDbArgs(params, callback) {
    if (typeof params === 'function') return { params: [], callback: params };
    return { params: params || [], callback };
}

function replacePlaceholders(sql) {
    // Rewrite SQLite `?` placeholders as PostgreSQL `$1, $2, ...` while leaving
    // any question mark inside a quoted string literal untouched (for example
    // `title NOT LIKE '%?'` must not become `'%$1'`).
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

function translatePostgresSql(sql) {
    let translated = String(sql || '').trim();

    if (/^BEGIN TRANSACTION$/i.test(translated)) return { sql: 'BEGIN' };
    if (/^COMMIT$/i.test(translated) || /^ROLLBACK$/i.test(translated)) return { sql: translated.toUpperCase() };

    translated = translated
        .replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+admin_settings\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i,
            'INSERT INTO admin_settings ($1) VALUES ($2) ON CONFLICT (id) DO NOTHING')
        .replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+admin_settings\s*\(id,\s*pin_hash,\s*updated_at\)\s*VALUES\s*\(1,\s*\?,\s*CURRENT_TIMESTAMP\)/i,
            'INSERT INTO admin_settings (id, pin_hash, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = EXCLUDED.updated_at')
        .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
        .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
        // Avatar bytes are stored in the DB; `BLOB` is not a PostgreSQL type.
        .replace(/\bBLOB\b/gi, 'BYTEA')
        .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
        .replace(/datetime\('now',\s*'-7 days'\)/gi, "NOW() - INTERVAL '7 days'")
        .replace(/datetime\('now',\s*'-1 day'\)/gi, "NOW() - INTERVAL '1 day'");

    translated = replacePlaceholders(translated);

    if (/^INSERT\s+INTO\s+/i.test(translated) && !/\bRETURNING\b/i.test(translated)) {
        translated += ' RETURNING id';
    }

    return { sql: translated };
}

function shouldUsePostgresSsl(connectionString) {
    // SSL is mandatory on Railway / managed Postgres: force it for production
    // and for any non-local host, while keeping localhost connections plain.
    if (process.env.NODE_ENV === 'production') return true;
    if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') return true;
    try {
        const host = new URL(connectionString).hostname.toLowerCase();
        return !['localhost', '127.0.0.1', '::1'].includes(host) && !host.endsWith('.local');
    } catch {
        return false;
    }
}

function createPostgresCompatDb(connectionString) {
    const pool = new pg.Pool({
        connectionString,
        ssl: shouldUsePostgresSsl(connectionString) ? { rejectUnauthorized: false } : undefined
    });

    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err.message);
    });

    const tableInfo = async (tableName) => {
        const result = await pool.query(
            `SELECT column_name AS name
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1
             ORDER BY ordinal_position`,
            [String(tableName).toLowerCase()]
        );
        return result.rows;
    };

    // Transactions are scoped per async context instead of sharing one
    // module-level client. With a single shared client, one task's BEGIN pinned
    // the connection for *every* concurrent task, and a single failed statement
    // poisoned it (Postgres abort-on-error) so unrelated queries failed with
    // "current transaction is aborted" until a ROLLBACK happened by luck.
    //
    // NB: the store is seeded in the *synchronous* part of run/get/all (see
    // `beginTx`) and holds the pending connect() promise. Seeding it after an
    // await would attach the store to the wrong async frame, so later statements
    // would silently escape the transaction.
    const txStore = new AsyncLocalStorage();

    const currentTx = () => txStore.getStore() || null;

    const toError = (e) => (e instanceof Error ? e : new Error(String(e?.message || e)));

    // Settle a transaction: clear the context, then run COMMIT/ROLLBACK and
    // always hand the connection back to the pool exactly once.
    // `settled` lives on the shared tx object, so it stays authoritative even if
    // the async-context store has already been cleared from another frame.
    const endTx = async (statement, tx) => {
        const target = tx || currentTx();
        if (!target) return;
        if (target.settled) return; // abortTx() already released it.
        target.settled = true;
        let client;
        try {
            client = await target.pending;
        } catch {
            return; // connect() itself failed; nothing to release.
        }
        try {
            await client.query(statement);
        } catch (err) {
            console.error(`PostgreSQL ${statement} failed:`, err.message);
        } finally {
            client.release();
        }
    };

    // Runs a statement, routing it to this context's transaction when present.
    const exec = async (sql, params = []) => {
        const pragmaMatch = String(sql || '').match(/^\s*PRAGMA\s+table_info\(([^)]+)\)\s*;?\s*$/i);
        if (pragmaMatch) return { rows: await tableInfo(pragmaMatch[1]), rowCount: 0 };
        const translated = translatePostgresSql(sql);
        const text = translated.sql;
        const bare = text.toUpperCase();

        if (bare === 'BEGIN') {
            // `dispatch` already seeded the store synchronously in the caller's
            // frame; just wait for the connection to be ready.
            const tx = currentTx();
            if (!tx) return { rows: [], rowCount: 0 };
            try {
                await tx.pending;
            } catch (err) {
                txStore.enterWith(null);
                throw err;
            }
            return { rows: [], rowCount: 0 };
        }

        if (bare === 'COMMIT' || bare === 'ROLLBACK') {
            await endTx(bare);
            return { rows: [], rowCount: 0 };
        }

        // Note: rollback/abort is owned by `transaction()` (or by an explicit
        // ROLLBACK from the caller). Doing it here as well would race with that
        // path and release the connection twice.
        const tx = currentTx();
        if (tx) return await (await tx.pending).query(text, params);
        return await pool.query(text, params);
    };

    // Seeding AND clearing the transaction store must happen in the caller's
    // synchronous frame. Doing it inside the async `exec` would bind the store
    // to the wrong async context, so later statements would silently escape the
    // transaction (running outside it and leaking the connection).
    const dispatch = (sql, params) => {
        const text = String(sql || '');

        if (/^\s*BEGIN\b/i.test(text)) {
            if (!currentTx()) {
                const pending = pool.connect().then(async (client) => {
                    await client.query('BEGIN');
                    return client;
                });
                // Swallow the rejection here; `exec` awaits `pending` and
                // rethrows, this only avoids an unhandled rejection warning.
                pending.catch(() => {});
                txStore.enterWith({ pending, settled: false });
            }
            return exec(sql, params);
        }

        if (/^\s*(COMMIT|ROLLBACK)\b/i.test(text)) {
            const tx = currentTx();
            txStore.enterWith(null);
            return endTx(text.trim().toUpperCase(), tx)
                .then(() => ({ rows: [], rowCount: 0 }));
        }

        return exec(sql, params);
    };

    // `transaction(fn)` runs `fn` with this context bound to a dedicated connection.
    // AsyncResource.run scopes the binding strictly to `fn` and its own async
    // descendants, so unrelated work running concurrently in the same event-loop
    // context is NOT dragged into the transaction. This is why callers must use
    // this helper rather than bare BEGIN/COMMIT strings.
    const transaction = (fn) => new Promise((resolve, reject) => {
        const resource = new AsyncResource('pg-transaction');
        const pending = pool.connect().then(async (client) => {
            await client.query('BEGIN');
            return client;
        });
        pending.catch(() => {}); // surfaced via `tx` once awaited
        const tx = { pending, settled: false };
        resource.runInAsyncScope(() => {
            (async () => {
                const client = await pending; // throws if connect/BEGIN failed
                let released = false;
                const release = () => {
                    if (released) return;
                    released = true;
                    client.release();
                };
                txStore.enterWith(tx);
                try {
                    const value = await fn();
                    txStore.enterWith(null);
                    tx.settled = true;
                    try {
                        await client.query('COMMIT');
                    } catch (err) {
                        console.error('PostgreSQL COMMIT failed:', err.message);
                    }
                    return value;
                } catch (err) {
                    txStore.enterWith(null);
                    if (!tx.settled) {
                        tx.settled = true;
                        try {
                            await client.query('ROLLBACK');
                        } catch (rollbackErr) {
                            // Connection is unusable; destroy it instead of
                            // returning a poisoned client to the pool.
                            released = true;   // stop `finally` double-releasing
                            client.release(toError(rollbackErr));
                        }
                    }
                    throw err;
                } finally {
                    release();
                }
            })().then(resolve, reject);
        });
    });

    return {
        transaction,
        get(sql, params, callback) {
            const args = normalizeDbArgs(params, callback);
            dispatch(sql, args.params)
                .then(result => args.callback?.(null, result.rows[0]))
                .catch(err => args.callback?.(err));
        },
        all(sql, params, callback) {
            const args = normalizeDbArgs(params, callback);
            dispatch(sql, args.params)
                .then(result => args.callback?.(null, result.rows))
                .catch(err => args.callback?.(err));
        },
        run(sql, params, callback) {
            const args = normalizeDbArgs(params, callback);
            dispatch(sql, args.params)
                .then(result => {
                    const context = {
                        lastID: result.rows?.[0]?.id ?? null,
                        changes: result.rowCount || 0
                    };
                    args.callback?.call(context, null);
                })
                .catch(err => args.callback?.(err));
        },
        serialize(callback) {
            callback?.();
        },
        close(callback) {
            pool.end().then(() => callback?.()).catch(err => callback?.(err));
        }
    };
}

const databasePath = sqlitePathFromDatabaseUrl(process.env.DATABASE_URL);
const db = isPostgresDatabaseUrl
    ? createPostgresCompatDb(process.env.DATABASE_URL)
    : new sqlite3.Database(databasePath);
const uploadPath = path.join(publicPath, 'uploads', 'avatars');
if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// --- AVATAR PERSISTENCE ----------------------------------------------------
// Avatars used to be written to `uploads/avatars` on the container filesystem.
// That is ephemeral on Railway: the file is gone after any redeploy or scale
// event, so the stored `avatar_url` resolved to a 404 and the picture silently
// "disappeared" moments after a successful upload.
//
// The bytes are now stored in the database and served by /api/avatar/:phone, so
// a picture survives restarts, deploys and multiple instances. `avatar_url` is
// written in the `/api/avatar/<phone>` form; `attachAvatarDisplayUrl` still
// turns that into an absolute, cache-busted URL for the client.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
};
const avatarPathFor = (phone) => `/api/avatar/${normalizePhone(phone)}`;

// Magic-byte sniffing. Trusting the client-supplied MIME type and extension is
// what previously allowed a 24-byte HTML error page to be stored as a ".jpg".
function detectImageType(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { ext: '.jpg', mime: 'image/jpeg' };
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return { ext: '.png', mime: 'image/png' };
    }
    if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
        return { ext: '.gif', mime: 'image/gif' };
    }
    // RIFF....WEBP
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
        return { ext: '.webp', mime: 'image/webp' };
    }
    return null;
}

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) { err ? reject(err) : resolve(this); });
});

// --- JWT SECRET RESOLUTION -------------------------------------------------
// Sessions are stateless JWTs, so the signing secret must stay identical across
// every process restart. Previously the secret was read straight from
// `process.env.JWT_SECRET || ''`, which caused two production failures:
//
//   1. When the variable was absent the secret silently became an EMPTY STRING.
//      `jwt.sign` then threw inside the async `db.get` callback of /api/login,
//      so no response was ever written and the browser just hung on "Login".
//   2. Because the secret only ever came from the environment, there was no
//      durable copy anywhere. Any redeploy that regenerated, dropped or rotated
//      the variable invalidated every issued token, logging every user out.
//
// The secret is now resolved once, in priority order:
//   1. `JWT_SECRET` / `JWT_SECRET_PREVIOUS` from the environment (authoritative).
//   2. A previously generated secret persisted in the `app_secrets` table, so
//      redeploys that lose the env var keep every existing session valid.
//   3. A freshly generated secret, persisted so it is stable from then on.
//
// `JWT_SECRET_PREVIOUS` is a comma-separated list of retired secrets that are
// still accepted during verification. That makes rotation safe: tokens signed
// before the change keep working until they expire naturally.
const envJwtSecret = String(process.env.JWT_SECRET || '').trim();
const legacyJwtSecrets = String(process.env.JWT_SECRET_PREVIOUS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

const JWT_SECRET_ROW_KEY = 'jwt_secret';
let jwtSecretSource = 'pending';
let resolvedJwtSecret = envJwtSecret;

// Signs are synchronous but verification must tolerate the brief startup window
// before the persisted secret has been read back from the database. Until then
// we fall back to the env value so a warm process never rejects a good token.
const getJwtSecrets = () => [resolvedJwtSecret, ...legacyJwtSecrets].filter(Boolean);

async function resolveJwtSecret() {
    let persisted = null;
    try {
        // `id` is required: the Postgres SQL translator appends `RETURNING id` to
        // every INSERT that lacks it, so the table must expose that column or the
        // insert fails outright on Postgres.
        await dbRun(`CREATE TABLE IF NOT EXISTS app_secrets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            value TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        const row = await dbGet(`SELECT value FROM app_secrets WHERE name = ?`, [JWT_SECRET_ROW_KEY]);
        persisted = row?.value ? String(row.value) : null;
    } catch (err) {
        console.error('[JWT] Could not open the app_secrets table:', err.message);
    }

    if (envJwtSecret) {
        // An explicit env var always wins, but persist it so a later deploy that
        // drops the variable keeps signing with the identical secret.
        if (persisted && persisted !== envJwtSecret) {
            legacyJwtSecrets.push(persisted);
        }
        if (!persisted) {
            try {
                await dbRun(
                    `INSERT INTO app_secrets (name, value) VALUES (?, ?)`,
                    [JWT_SECRET_ROW_KEY, envJwtSecret]
                );
            } catch (err) {
                console.error('[JWT] Could not persist the configured secret:', err.message);
            }
        }
        resolvedJwtSecret = envJwtSecret;
        jwtSecretSource = 'environment';
        console.log('[JWT] Signing secret loaded from the environment (persisted for redeploy stability).');
        return;
    }

    if (persisted) {
        resolvedJwtSecret = persisted;
        jwtSecretSource = 'database';
        console.log('[JWT] JWT_SECRET is not set; reusing the secret persisted in the database so existing sessions stay valid.');
        return;
    }

    const generated = crypto.randomBytes(48).toString('hex');
    try {
        await dbRun(
            `INSERT INTO app_secrets (name, value) VALUES (?, ?)`,
            [JWT_SECRET_ROW_KEY, generated]
        );
        jwtSecretSource = 'generated';
        console.log('[JWT] JWT_SECRET is not set; generated and persisted a new signing secret.');
    } catch (err) {
        jwtSecretSource = 'ephemeral';
        console.error('[JWT] Could not persist a generated secret; it will change on the next restart:', err.message);
    }
    resolvedJwtSecret = generated;
}

const jwtSecretReady = resolveJwtSecret().catch(err => {
    console.error('[JWT] Secret resolution failed; using a process-local secret:', err.message);
    resolvedJwtSecret = envJwtSecret || crypto.randomBytes(48).toString('hex');
    jwtSecretSource = 'ephemeral';
});

// Signs a token with the current secret, guaranteeing callers never hit the
// empty-secret throw that used to hang /api/login.
const signJwt = (payload, options = {}) => {
    if (!resolvedJwtSecret) throw new Error('JWT signing secret is not available yet.');
    return jwt.sign(payload, resolvedJwtSecret, options);
};

// Verifies against the active secret first, then any retired secrets.
const verifyJwt = (token) => {
    const secrets = getJwtSecrets();
    if (!secrets.length) throw new Error('JWT verification secret is not available yet.');
    let lastError;
    for (const secret of secrets) {
        try {
            return jwt.verify(token, secret);
        } catch (err) {
            // An expired token still matched this secret's signature, so it is
            // genuinely expired. Stop here instead of letting a later secret
            // report a misleading "invalid signature" to the client.
            if (err?.name === 'TokenExpiredError') throw err;
            lastError = err;
        }
    }
    throw lastError;
};

// Runs `fn` inside a database transaction on Postgres, or simply invokes it on
// SQLite (where dbRun already serialises and autocommits). Prefer this over
// manual BEGIN/COMMIT strings: it guarantees the connection is committed,
// rolled back and returned to the pool exactly once, and it keeps concurrent
// tasks from being swept into someone else's transaction.
const withTransaction = (fn) => {
    if (typeof db.transaction === 'function') return db.transaction(fn);
    return Promise.resolve().then(fn);
};

async function ensureDbColumn(tableName, columnName, definition) {
    const columns = await dbAll(`PRAGMA table_info(${tableName})`);
    if (columns.some(col => col.name === columnName)) return;
    try {
        await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition.replace(/,$/, '')}`);
    } catch (e) {
        // Postgres raises 42701 ("column ... already exists"); SQLite says "duplicate column name".
        if (e.code !== '42701' && !/duplicate column|already exists/i.test(e.message || '')) throw e;
    }
}

// --- CORE UTILS ---
const normalizePhone = (phone) => {
    if (!phone) return null;
    // Remove all non-digit characters except leading zero logic
    let p = phone.toString().replace(/\D/g, ''); 
    if (p.startsWith('0')) return '254' + p.slice(1);
    return p;
};

// --- ADMIN IDENTITY RESOLUTION ---------------------------------------------
// Admin login is driven by ADMIN_PHONE, but that variable is routinely missing
// on the host (Railway), which made /api/admin/pin-login and /admin/master-login
// reject every attempt with "Admin not configured on this server."
//
// The identity is resolved once and cached so that pin-login, master-login and
// the authenticateAdmin middleware ALWAYS agree on the same phone. That
// agreement is essential: if login minted a token for a fallback identity while
// the middleware compared against the (absent) env var, every subsequent admin
// API call would fail with 403 straight after a "successful" login.
//
// Resolution order:
//   1. ADMIN_PHONE from the environment (authoritative when present).
//   2. admin_settings.admin_phone, persisted on first successful configuration.
//   3. The first user already flagged role='admin' in the database.
// Credentials (PIN / master password) are still required in every case - this
// only decides WHICH identity the resulting token is issued for.
let cachedAdminPhone = null;
let adminPhoneResolution = null;

async function resolveAdminPhone() {
    if (cachedAdminPhone) return cachedAdminPhone;
    if (adminPhoneResolution) return adminPhoneResolution;

    adminPhoneResolution = (async () => {
        const fromEnv = normalizePhone(process.env.ADMIN_PHONE);
        if (fromEnv) {
            cachedAdminPhone = fromEnv;
            return fromEnv;
        }

        try {
            const stored = await dbGet(
                `SELECT admin_phone FROM admin_settings WHERE id = 1`
            ).catch(() => null);
            const fromSettings = normalizePhone(stored?.admin_phone);
            if (fromSettings) {
                cachedAdminPhone = fromSettings;
                console.warn(`[ADMIN] ADMIN_PHONE is not set; using the admin phone saved in the database (${fromSettings}). Set ADMIN_PHONE to make this explicit.`);
                return fromSettings;
            }
        } catch (err) {
            console.error('[ADMIN] Could not read the stored admin phone:', err.message);
        }

        // Last resort: reuse whichever account the database already treats as an
        // admin. The PIN/master-password check still gates access.
        try {
            const row = await dbGet(
                `SELECT phone FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
            ).catch(() => null);
            const fromDb = normalizePhone(row?.phone);
            if (fromDb) {
                cachedAdminPhone = fromDb;
                console.warn(`[ADMIN] ADMIN_PHONE is not set; falling back to the existing admin account ${fromDb}. Set ADMIN_PHONE to make this explicit.`);
                return fromDb;
            }
        } catch (err) {
            console.error('[ADMIN] Could not resolve an admin account from the database:', err.message);
        }

        return null;
    })();

    try {
        return await adminPhoneResolution;
    } finally {
        // Allow a later retry (e.g. after an admin account is created) instead of
        // caching the failure for the lifetime of the process.
        adminPhoneResolution = null;
    }
}

async function persistAdminPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    cachedAdminPhone = normalized;
    try {
        await dbRun(
            `UPDATE admin_settings SET admin_phone = ? WHERE id = 1`,
            [normalized]
        );
    } catch (err) {
        console.error('[ADMIN] Could not persist the admin phone:', err.message);
    }
}

const formatNairobiDate = (offsetDays = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);

    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
};

const personaFilePath = path.join(__dirname, '..', 'public', 'persona.txt');
const personaRaw = fs.existsSync(personaFilePath) ? fs.readFileSync(personaFilePath, 'utf8') : '';
const personaConfig = personaRaw.split(/\r?\n/).reduce((acc, line) => {
    const parts = line.split(':');
    if (parts.length < 2) return acc;
    const key = parts[0].trim().toUpperCase();
    const value = parts.slice(1).join(':').trim();
    if (key === 'KEYWORDS') acc.keywords = value.split(',').map((w) => w.trim()).filter(Boolean);
    if (key === 'INSTRUCTIONS') acc.instructions = value;
    if (key === 'TONE') acc.tone = value;
    if (key === 'ROLE') acc.role = value;
    return acc;
}, { keywords: [], instructions: '', tone: 'High-Energy', role: 'Elite Analyst' });

function buildNewsQuestion(headline) {
    const clean = String(headline || '')
        .replace(/\s+-\s+[^-]+$/, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/^['"Ã¢â‚¬Å“Ã¢â‚¬Â]+|['"Ã¢â‚¬Å“Ã¢â‚¬Â]+$/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\?+$/g, '')
        .trim();
    if (!clean) return 'Is this report accurate?';

    const lower = clean.toLowerCase();
    const tmdbQuestion = buildTmdbQuestion(clean);
    if (tmdbQuestion) return polishMarketTitle(tmdbQuestion);

    const statementQuestion = buildStatementMarketQuestion(clean);
    if (statementQuestion) return polishMarketTitle(statementQuestion);

    const contextQuestion = buildContextMarketQuestion(clean);
    if (contextQuestion) return polishMarketTitle(contextQuestion);

    const footballQuestion = buildFootballQuestion(clean);
    if (footballQuestion) return polishMarketTitle(footballQuestion);

    const directQuestion = buildDirectNewsQuestion(clean);
    if (directQuestion) return polishMarketTitle(directQuestion);

    const clauseQuestion = buildClauseQuestion(clean);
    if (clauseQuestion) return polishMarketTitle(clauseQuestion);

    const actionQuestion = buildActionQuestion(clean, lower);
    if (actionQuestion) return polishMarketTitle(actionQuestion);

    return polishMarketTitle(buildFallbackMarketQuestion(clean));
}

function buildStatementMarketQuestion(headline) {
    const clean = String(headline || '').trim();
    const normalized = sentenceCase(clean.toLowerCase())
        .replace(/\bsupplimentary\b/gi, 'supplementary')
        .replace(/\bi\b/g, 'I');

    const noMatch = normalized.match(/^No\s+(.+)$/i);
    if (noMatch?.[1]) {
        const subject = cleanMarketSubject(noMatch[1]);
        const timed = subject.match(/^(.+?)\s+((?:this|next)\s+(?:summer|winter|month|week|year))$/i);
        if (timed?.[1] && timed?.[2]) return `Are ${timed[1]} unlikely ${timed[2]}?`;
        return `Are ${subject} unlikely?`;
    }

    const toBeMatch = normalized.match(/^(.+?)\s+to be\s+(.+)$/i);
    if (toBeMatch?.[1] && toBeMatch?.[2]) {
        return `Is ${cleanMarketSubject(toBeMatch[1])} likely to be ${cleanMarketPredicate(toBeMatch[2])}?`;
    }

    const likelyMatch = normalized.match(/^(.+?)\s+likely to\s+(.+)$/i);
    if (likelyMatch?.[1] && likelyMatch?.[2]) {
        return `Is ${cleanMarketSubject(likelyMatch[1])} likely to ${cleanMarketPredicate(likelyMatch[2])}?`;
    }

    return null;
}

function buildContextMarketQuestion(headline) {
    const clean = String(headline || '').trim();
    const lower = clean.toLowerCase();
    const countryOrPlace = extractPlace(clean);
    const topic = extractMarketTopic(clean);

    if (/\b(ebola|cholera|mpox|malaria|outbreak|epidemic|pandemic|virus|disease|health emergency)\b/i.test(clean)) {
        const place = countryOrPlace || 'the affected area';
        if (/\b(centre|center|clinic|hospital|isolation|treatment|quarantine)\b/i.test(clean)) {
            return `Are emergency health centres likely in ${place} within 30 days?`;
        }
        return `Are new outbreak measures likely in ${place} within 30 days?`;
    }

    if (/\b(protest|protests|demonstration|demonstrations|strike|strikes|riot|unrest|march|rally)\b/i.test(clean)) {
        const place = countryOrPlace ? ` in ${countryOrPlace}` : '';
        const issue = topic ? ` over ${topic}` : '';
        return `Are protests likely${place}${issue}?`;
    }

    if (/\b(group\s+[a-z0-9]+|world cup|champions league|euros|afcon|copa america|tournament|league title|qualify|qualification)\b/i.test(clean) && isFootballNews(clean)) {
        const group = clean.match(/\bgroup\s+([a-z0-9]+)\b/i)?.[1]?.toUpperCase();
        const team = extractLikelyTeam(clean);
        if (group && team) return `Can ${team} win Group ${group}?`;
        if (group) return `Who is likely to win Group ${group}?`;
        if (team && /\b(win|winner|title|trophy|champion|champions)\b/i.test(clean)) return `Can ${team} win the tournament?`;
        return `Who is likely to win this football race?`;
    }

    if (/\b(poll|polls|election|vote|ballot|candidate|campaign|president|parliament|senate|governor)\b/i.test(clean)) {
        const candidate = extractLikelyCandidate(clean);
        if (candidate) return `Is ${candidate} likely to win the election?`;
        const place = countryOrPlace ? ` in ${countryOrPlace}` : '';
        return `Is the election race tightening${place}?`;
    }

    if (/\b(sanction|sanctions|tariff|ceasefire|peace talks|deal|agreement|border|war|conflict|troops|invasion|missile|strike|airstrike|nato|united nations|security council)\b/i.test(clean)) {
        const actor = extractActor(clean);
        if (/\bceasefire|peace talks|deal|agreement\b/i.test(clean)) {
            return `Are peace talks likely to produce a deal soon?`;
        }
        if (/\bsanction|sanctions|tariff\b/i.test(clean) && actor) {
            return `Is ${actor} likely to face new sanctions or tariffs?`;
        }
        if (actor) return `Are tensions involving ${actor} likely to escalate?`;
        return `Are geopolitical tensions likely to escalate?`;
    }

    if (/\b(launch|release|unveil|announce|debut|roll out|rollout|ship|introduce)\b/i.test(clean)) {
        const actor = extractActor(clean) || extractBetSubject(clean);
        return `Is ${cleanMarketSubject(actor)} close to a launch?`;
    }

    if (/\b(price|stock|shares|bitcoin|ethereum|crypto|market cap|record high|surge|rally|slump|fall|drop|gain)\b/i.test(clean)) {
        const asset = extractActor(clean) || extractBetSubject(clean);
        if (/\b(slump|fall|drop|lower|decline|selloff)\b/i.test(clean)) return `Is ${cleanMarketSubject(asset)} likely to fall further?`;
        return `Is ${cleanMarketSubject(asset)} likely to keep rising?`;
    }

    if (/\b(court|judge|lawsuit|trial|charges|investigation|probe|arrest|indictment)\b/i.test(clean)) {
        const actor = extractActor(clean) || extractBetSubject(clean);
        return `Is ${cleanMarketSubject(actor)} likely to face legal consequences?`;
    }

    return null;
}

function buildClauseQuestion(headline) {
    const clean = String(headline || '').trim();
    const quotedClaim = clean.match(/^(.+?)\s+(?:says?|claims?|reports?|announces?)\s+['"Ã¢â‚¬Å“](.+?)['"Ã¢â‚¬Â]?$/i);
    if (quotedClaim?.[1] && quotedClaim?.[2]) {
        return `Is ${cleanMarketSubject(quotedClaim[1])}'s claim accurate?`;
    }

    const modalMatch = clean.match(/^(.+?)\s+(will|can|could|may|might|should|is set to|are set to)\s+(.+)$/i);
    if (modalMatch?.[1] && modalMatch?.[3]) {
        const subject = cleanMarketSubject(modalMatch[1]);
        const modal = modalMatch[2].toLowerCase();
        const rest = cleanMarketPredicate(modalMatch[3]);
        if (!subject || !rest) return null;
        if (modal === 'is set to') return `Is ${subject} set to ${rest}?`;
        if (modal === 'are set to') return `Are ${subject} set to ${rest}?`;
        if (modal === 'will') return `Is ${subject} likely to ${rest}?`;
        return `${sentenceCase(modal)} ${subject} ${rest}?`;
    }

    const stateMatch = clean.match(/^(.+?)\s+(is|are|was|were|has|have|had)\s+(.+)$/i);
    if (stateMatch?.[1] && stateMatch?.[3]) {
        const subject = cleanMarketSubject(stateMatch[1]);
        const verb = stateMatch[2].toLowerCase();
        const rest = cleanMarketPredicate(stateMatch[3]);
        if (!subject || !rest) return null;
        if (verb === 'is' || verb === 'are') return `${sentenceCase(verb)} ${subject} ${rest}?`;
        if (verb === 'was' || verb === 'were') return `${sentenceCase(verb)} ${subject} ${rest}?`;
        if (verb === 'has' || verb === 'have' || verb === 'had') return `${sentenceCase(verb)} ${subject} ${rest}?`;
    }

    return null;
}

function buildActionQuestion(clean, lower) {
    const subject = cleanMarketSubject(extractBetSubject(clean));
    if (!subject || subject.length < 2) return null;

    if (/\b(launch|release|unveil|announce|debut|roll out|rollout)\b/.test(lower)) {
        return `Is ${subject} close to launch?`;
    }
    if (/\b(win|wins|beat|beats|defeat|defeats|victory|election|vote|poll)\b/.test(lower)) {
        return `Can ${subject} win?`;
    }
    if (/\b(rise|rises|surge|surges|jump|jumps|gain|gains|higher|record high)\b/.test(lower)) {
        return `Is ${subject} likely to keep rising?`;
    }
    if (/\b(fall|falls|drop|drops|slump|slumps|lower|decline|declines)\b/.test(lower)) {
        return `Is ${subject} likely to fall further?`;
    }
    if (/\b(approve|approves|pass|passes|deal|agreement|settlement)\b/.test(lower)) {
        return `Is ${subject} likely to be approved?`;
    }
    if (/\b(ban|block|halt|cancel|suspend|delay|postpone)\b/.test(lower)) {
        return `Is ${subject} likely to be blocked?`;
    }
    if (/\b(court|judge|lawsuit|trial|charges|investigation|probe)\b/.test(lower)) {
        return `Is ${subject} facing legal action?`;
    }
    return null;
}

function sentenceCase(value) {
    const text = String(value || '').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function cleanMarketSubject(value) {
    return String(value || '')
        .replace(/^(breaking|update|exclusive|analysis|live):\s*/i, '')
        .replace(/\b(favorites?|favourites?|favored|favoured|backed|tipped|likely|odds-on|front[- ]?runners?)\b/ig, '')
        .replace(/\b(to|for)\s*$/i, '')
        .replace(/["Ã¢â‚¬Å“Ã¢â‚¬Â]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^(that|whether)\s+/i, '')
        .replace(/[,;:.!?]+$/g, '')
        .trim();
}

function cleanMarketPredicate(value) {
    return String(value || '')
        .replace(/^that\s+/i, '')
        .replace(/\s+-\s+[^-]+$/, '')
        .replace(/["Ã¢â‚¬Å“Ã¢â‚¬Â]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[,;:.!?]+$/g, '')
        .trim();
}

function polishMarketTitle(value) {
    let title = String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\s+([?,.:;!])/g, '$1')
        .replace(/\?+$/g, '?')
        .trim();
    if (!title) return 'Is this report accurate?';
    title = title.replace(/^Will it rain\b/i, 'Is rain likely');
    title = title.replace(/^Will we see\b/i, 'Are we likely to see');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) win\b/i, 'Can $1 win');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) face\b/i, 'Is $1 likely to face');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) be\b/i, 'Is $1 likely to be');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) close higher\b/i, 'Can $1 close higher');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) hit\b/i, 'Can $1 hit');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) exceed\b/i, 'Is $1 likely to exceed');
    title = title.replace(/^Will ([A-Z][^?]{1,80}?) open\b/i, 'Is $1 likely to open');
    title = title.replace(/^Will (.+?) stay married\b/i, 'Are $1 likely to stay married');
    title = title.replace(/^Will (.+?) stay\b/i, 'Can $1 stay');
    title = title.replace(/^Will it be\b/i, 'Is it likely to be');
    title = title.charAt(0).toUpperCase() + title.slice(1);
    if (!/[?.!]$/.test(title)) title += '?';
    return title;
}

function titleWords(value, maxWords = 5) {
    return cleanMarketSubject(value)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, maxWords)
        .join(' ');
}

function extractPlace(headline) {
    const clean = String(headline || '');
    const explicit = clean.match(/\b(?:in|across|near|around|inside)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})\b/);
    if (explicit?.[1]) return cleanMarketSubject(explicit[1]);

    const knownPlaces = [
        'Kenya', 'Nairobi', 'Uganda', 'Tanzania', 'Rwanda', 'Ethiopia', 'Somalia', 'Sudan',
        'South Sudan', 'Nigeria', 'South Africa', 'Ghana', 'Egypt', 'Israel', 'Palestine',
        'Ukraine', 'Russia', 'China', 'Taiwan', 'India', 'Pakistan', 'Iran', 'United States',
        'US', 'UK', 'Britain', 'France', 'Germany', 'Spain', 'Italy'
    ];
    const lower = clean.toLowerCase();
    return knownPlaces.find(place => lower.includes(place.toLowerCase())) || '';
}

function extractLikelyTeam(headline) {
    const clean = String(headline || '');
    const groupMatch = clean.match(/\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+(?:look(?:s|ing)? sharp|impress(?:es|ive|ing)?|dominates?|favou?rites?|backs?|tips?|leads?)\b/);
    if (groupMatch?.[1]) return cleanMarketSubject(groupMatch[1]);

    const toWinMatch = clean.match(/\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+(?:to|can|could|may|might|set to|likely to)\s+win\b/);
    if (toWinMatch?.[1]) return cleanMarketSubject(toWinMatch[1]);

    const knownTeams = ['Spain', 'France', 'England', 'Argentina', 'Brazil', 'Germany', 'Portugal', 'Netherlands', 'Italy', 'Kenya', 'Morocco', 'Nigeria', 'Ghana', 'USA', 'Mexico'];
    const lower = clean.toLowerCase();
    return knownTeams.find(team => lower.includes(team.toLowerCase())) || '';
}

function extractLikelyCandidate(headline) {
    const clean = String(headline || '');
    const match = clean.match(/\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})\s+(?:leads?|ahead|favou?rite|surges?|gains?|wins?)\b/);
    if (match?.[1]) return cleanMarketSubject(match[1]);
    return '';
}

function extractActor(headline) {
    const clean = String(headline || '')
        .replace(/^(breaking|update|exclusive|analysis|live):\s*/i, '')
        .trim();
    const beforeVerb = clean.match(/^(.+?)\s+(?:is|are|was|were|has|have|had|will|can|could|may|might|should|to|set to|faces?|seeks?|plans?|launches?|announces?|warns?|says?|backs?|hits?|opens?|reports?)\b/i);
    const raw = beforeVerb?.[1] || clean.split(/\s+(?:after|amid|over|as|following|during|before)\s+/i)[0];
    const actor = titleWords(raw, 5);
    if (!actor || /^(the|a|an|this|new|latest)$/i.test(actor)) return '';
    return actor;
}

function extractMarketTopic(headline) {
    const clean = String(headline || '');
    const topicMatch = clean.match(/\b(?:over|about|concerning|after|following|amid)\s+(.+)$/i);
    if (!topicMatch?.[1]) return '';
    return titleWords(topicMatch[1], 7).toLowerCase();
}

function buildFallbackMarketQuestion(headline) {
    const clean = String(headline || '').trim();
    const actor = extractActor(clean);
    const topic = extractMarketTopic(clean);
    if (actor && topic) return `Is ${actor} likely to face fallout over ${topic}?`;
    if (actor) return `Is ${actor} likely to stay in the spotlight?`;
    return `Is this story likely to develop further?`;
}

function buildFootballQuestion(headline) {
    if (!isFootballNews(headline)) return null;

    const clean = headline.replace(/\bFIFA\b/ig, 'FIFA').trim();
    const lower = clean.toLowerCase();
    const worldCupLabel = /\bclub world cup\b/i.test(clean)
        ? 'the FIFA Club World Cup'
        : /\bworld cup\b/i.test(clean)
            ? 'the FIFA World Cup'
            : '';

    if (worldCupLabel) {
        const winnerMatch = clean.match(/^(.+?)\s+(?:are\s+|is\s+)?(?:favorites?|favourites?|favored|favoured|backed|tipped|likely|odds-on|front[- ]?runners?)\s+(?:to|for)\s+win(?:ning)?\b/i)
            || clean.match(/^(.+?)\s+to\s+win\s+(?:the\s+)?(?:fifa\s+)?(?:club\s+)?world cup\b/i)
            || clean.match(/^(.+?)\s+(?:can|could|may|might|will|set to)\s+win\s+(?:the\s+)?(?:fifa\s+)?(?:club\s+)?world cup\b/i);
        const subject = cleanMarketSubject(winnerMatch?.[1]);
        if (subject && subject.length <= 60) return `Can ${subject} win ${worldCupLabel}?`;

        if (/\bwho\b.+\bwin\b/i.test(clean) || /\bwinner\b|\bfavorites?\b|\bfavourites?\b/i.test(clean)) {
            return `Who is likely to win ${worldCupLabel}?`;
        }
    }

    const transferMatch = clean.match(/^(.+?)\s+(?:to join|set to join|agrees? to join|nears? move to|linked with|targets?)\s+(.+?)$/i);
    if (transferMatch?.[1] && transferMatch?.[2]) {
        return `Is ${cleanMarketSubject(transferMatch[1])} likely to join ${cleanMarketSubject(transferMatch[2])}?`;
    }

    const injuryMatch = clean.match(/^(.+?)\s+(?:injured|ruled out|doubtful|returns?)\b/i);
    if (injuryMatch?.[1]) {
        return `Is ${cleanMarketSubject(injuryMatch[1])} likely to be available next match?`;
    }

    if (/\b(win|wins|beat|beats|defeat|defeats|qualify|qualifies|advance|advances)\b/i.test(lower)) {
        const subject = extractBetSubject(clean);
        return `Can ${subject} win or qualify?`;
    }

    return null;
}

function buildDirectNewsQuestion(headline) {
    const clean = String(headline || '').trim();
    const patterns = [
        {
            match: /^(.+?)\s+(?:to|set to|will)\s+(launch|release|announce|unveil|debut|roll out)\b(.+)?$/i,
            format: ([subject]) => `Is ${cleanMarketSubject(subject)} close to a launch?`
        },
        {
            match: /^(.+?)\s+(?:to|set to|will)\s+(win|beat|defeat|pass|approve|ban|block|halt|cancel|delay|postpone)\b(.+)?$/i,
            format: ([subject, verb, rest]) => {
                const cleanSubject = cleanMarketSubject(subject);
                const action = verb.toLowerCase();
                if (['win', 'beat', 'defeat'].includes(action)) return `Can ${cleanSubject} ${action}${rest ? ` ${rest.trim()}` : ''}?`;
                if (['approve', 'pass'].includes(action)) return `Is ${cleanSubject} likely to approve or pass this?`;
                if (['ban', 'block', 'halt', 'cancel', 'delay', 'postpone'].includes(action)) return `Is ${cleanSubject} likely to block or delay this?`;
                return `Is ${cleanSubject} likely to act soon?`;
            }
        },
        {
            match: /^(.+?)\s+(?:reports?|says?|claims?)\s+(.+)$/i,
            format: ([subject]) => `Is ${cleanMarketSubject(subject)}'s claim credible?`
        }
    ];

    for (const pattern of patterns) {
        const match = clean.match(pattern.match);
        if (!match) continue;
        const question = pattern.format(match.slice(1)).replace(/\s+/g, ' ').replace(/\s+\?/g, '?');
        if (question.length <= 140) return question;
    }
    return null;
}

function buildTmdbQuestion(headline) {
    const patterns = [
        {
            match: /^(.+?) is trending on TMDB right now$/i,
            format: (title) => `Can ${title} stay trending on TMDB?`
        },
        {
            match: /^(.+?) is an upcoming TMDB release$/i,
            format: (title) => `Is ${title} on track for release?`
        },
        {
            match: /^(.+?) is one of TMDB'?s most popular titles$/i,
            format: (title) => `Can ${title} remain one of TMDB's most popular titles?`
        },
        {
            match: /^(.+?) is a top rated TMDB title$/i,
            format: (title) => `Can ${title} remain a top-rated TMDB title?`
        },
        {
            match: /^(.+?) is getting award attention on TMDB$/i,
            format: (title) => `Is ${title} likely to keep getting award attention?`
        },
        {
            match: /^(.+?) is featured on TMDB$/i,
            format: (title) => `Can ${title} remain featured on TMDB?`
        }
    ];

    for (const pattern of patterns) {
        const match = headline.match(pattern.match);
        if (match?.[1]) return pattern.format(match[1].trim());
    }

    return null;
}

function extractBetSubject(headline) {
    const stopAt = headline
        .replace(/^(breaking|update|exclusive|analysis|live):\s*/i, '')
        .split(/\s+(?:as|after|amid|over|before|during|following|according to|says|said)\s+/i)[0]
        .replace(/["]/g, '')
        .trim();
    const words = stopAt.split(/\s+/).filter(Boolean).slice(0, 7);
    const subject = words.join(' ').replace(/[,;:.]+$/g, '').trim();
    return subject || 'this story';
}

function buildPersonaInsight(headline) {
    const base = headline.replace(/\s+-\s+[^-]+$/, '').trim();
    const hook = personaConfig.instructions || 'Always focus on impact and narrative.';
    const keyword = personaConfig.keywords?.[Math.floor(Math.random() * personaConfig.keywords.length)] || 'Relevant';
    return `Market insight: ${base}. ${hook} This feels ${keyword.toLowerCase()} unless trends shift.`;
}

// --- GEOPOLITICAL NEWS DETECTION ---
function isGeopoliticalNews(headline, description) {
    const text = `${headline || ''} ${description || ''}`.toLowerCase();
    
    // Geopolitical keywords that indicate political, diplomatic, or international affairs news
    const geopoliticalKeywords = [
        // Government & Diplomacy
        'parliament', 'congress', 'senate', 'minister', 'government', 'diplomat', 'ambassador',
        'treaty', 'sanctions', 'embargo', 'resolution', 'legislation', 'bill',
        
        // Elections & Politics
        'election', 'vote', 'campaign', 'candidate', 'political', 'politician', 'party',
        'referendum', 'ballots', 'voting', 'inauguration',
        
        // International Relations
        'war', 'conflict', 'border', 'invasion', 'military', 'troops', 'deployed',
        'ceasefire', 'peace talks', 'negotiations', 'tension', 'crisis',
        
        // Regional & Global Issues
        'russia', 'china', 'iran', 'ukraine', 'israel', 'palestine', 'middle east',
        'north korea', 'south korea', 'taiwan', 'eu', 'brexit', 'nato', 'un',
        'united nations', 'security council', 'geopolitical',
        
        // Economic Sanctions & Trade Wars
        'tariff', 'trade war', 'trade deal', 'export ban', 'import ban', 'trade agreement',
        'commerce department', 'trade policy',
        
        // Protests & Civil Unrest
        'protest', 'demonstration', 'riot', 'civil unrest', 'martial law', 'coup', 'uprising',
        'revolution', 'rebellion',
        
        // Key Politicians & Leaders
        'trump', 'biden', 'putin', 'xi jinping', 'modi', 'macron', 'sunak', 'zelensky',
        'johnson', 'scholz', 'draghi', 'sanchez',
        
        // International Organizations & Summits
        'summit', 'g7', 'g20', 'imf', 'world bank', 'wto', 'oecd', 'brics',
        'apec', 'asean', 'european union',
        
        // Weapons & Military Technology
        'nuclear', 'missile', 'drone strike', 'weapons', 'military exercise', 'defense',
        'airstrikes', 'bombardment', 'naval'
    ];
    
    // Check if any geopolitical keyword matches
    return geopoliticalKeywords.some(keyword => text.includes(keyword));
}

function isTechNews(headline, description) {
    const text = `${headline || ''} ${description || ''}`.toLowerCase();
    const techKeywords = [
        'tech', 'technology', 'software', 'hardware', 'app', 'apps', 'internet',
        'startup', 'silicon', 'chip', 'semiconductor', 'cpu', 'gpu', 'ai', 'artificial intelligence',
        'machine learning', 'robot', 'robotics', 'cloud', 'data breach', 'cyber', 'cybersecurity',
        'hack', 'hacker', 'security', 'smartphone', 'mobile', 'device', 'gadget',
        'streaming', 'vr', 'ar', 'metaverse', 'blockchain', 'web3', 'nft', 'crypto',
        'google', 'apple', 'microsoft', 'amazon', 'tesla', 'meta', 'facebook', 'netflix',
        'spotify', 'elon musk', 'twitter', 'x.com', 'samsung', 'intel', 'amd',
        'nvidia', 'oracle', 'ibm', 'qualcomm', 'sap', 'tiktok', 'wechat',
        'drone', 'satellite', '5g', '6g', 'quantum', 'ai chip', 'sensor',
        'autonomous', 'autonomy', 'self-driving', 'electric vehicle', 'ev',
        'software update', 'operating system', 'ios', 'android'
    ];
    return techKeywords.some(keyword => text.includes(keyword));
}

function createMatchNewsQuery(teamA, teamB) {
    const safeTeamA = teamA ? teamA.replace(/[^a-zA-Z0-9 ]/g, ' ').trim() : '';
    const safeTeamB = teamB ? teamB.replace(/[^a-zA-Z0-9 ]/g, ' ').trim() : '';
    if (safeTeamA && safeTeamB) return `${safeTeamA} OR ${safeTeamB}`;
    return safeTeamA || safeTeamB || 'football';
}

function isFootballNews(title, content = '') {
    const text = `${title || ''} ${content || ''}`.toLowerCase();
    const footballKeywords = [
        'football', 'soccer', 'premier league', 'champions league', 'europa league',
        'world cup', 'nations league', 'la liga', 'bundesliga', 'serie a', 'ligue 1',
        'afl', 'transfer', 'goalkeeper', 'striker', 'midfielder', 'defender',
        'penalty', 'red card', 'yellow card', 'hat trick', 'derby', 'playoff',
        'world cup', 'euros', 'copa america', 'afcon', 'fifa',
        'premiership', 'football league', 'fa cup', 'carabao cup', 'community shield'
    ];
    return footballKeywords.some(keyword => text.includes(keyword));
}

function classifyNewsArticle(title, content = '') {
    const text = `${title || ''} ${content || ''}`;
    
    // Football-specific news goes to its own category
    if (isFootballNews(title, content)) {
        return { category: 'football', sideA: 'YES', sideB: 'NO', expiryHours: 24, prefix: 'news_football' };
    }
    
    const sportsKeywords = [
        'nba', 'nfl', 'mlb', 'nhl',
        'tennis', 'cricket', 'rugby', 'golf', 'formula 1', 'f1', 'ufc', 'boxing', 'olympics',
        'basketball', 'baseball', 'hockey', 'volleyball'
    ];
    const lower = text.toLowerCase();
    const isSports = sportsKeywords.some(keyword => lower.includes(keyword));
    if (isSports) {
        return { category: 'sports', sideA: 'YES', sideB: 'NO', expiryHours: 18, prefix: 'news_sports' };
    }
    if (isTechNews(title, content)) {
        return { category: 'tech', sideA: 'YES', sideB: 'NO', expiryHours: 24, prefix: 'tech' };
    }
    if (isGeopoliticalNews(title, content)) {
        return { category: 'politics', sideA: 'LIKELY', sideB: 'UNLIKELY', expiryHours: 48, prefix: 'geo' };
    }
    return { category: 'news', sideA: 'YES', sideB: 'NO', expiryHours: 18, prefix: 'news' };
}

function normalizeNewsArticle(article) {
    const rawHeadline = String(article?.title || '').replace(/\s+-\s+[^-]+$/, '').replace(/\s+/g, ' ').trim();
    if (!rawHeadline || rawHeadline === '[Removed]') return null;

    const content = article.description || article.content || rawHeadline;
    const classification = classifyNewsArticle(rawHeadline, content);
    const hash = crypto.createHash('md5').update(rawHeadline + (article.source?.name || '') + (article.publishedAt || '')).digest('hex');
    const market = buildNewsMarket({
        id: `${classification.prefix}_${hash}`,
        title: rawHeadline,
        description: content,
        content,
        media_url: article.urlToImage || null,
        media_type: 'image',
        category: classification.category,
        country: article.source?.name || 'GLOBAL',
        source: article.source?.name || 'GLOBAL',
        sideA: classification.sideA,
        sideB: classification.sideB,
        url: article.url || null,
        startTime: new Date(Date.now() + classification.expiryHours * 60 * 60 * 1000).toISOString(),
        status: 'open'
    });
    market.rawHeadline = rawHeadline;
    return market;
}

async function saveNewsMarket(market) {
    await dbRun(
        `INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            description=excluded.description,
            content=excluded.content,
            media_url=excluded.media_url,
            media_type=excluded.media_type,
            category=excluded.category,
            country=excluded.country,
            sideA=excluded.sideA,
            sideB=excluded.sideB,
            startTime=excluded.startTime,
            status=excluded.status,
            url=excluded.url,
            timestamp=CURRENT_TIMESTAMP`,
        [market.id, market.title, market.description, market.content, market.media_url, market.media_type, market.category, market.country, market.sideA, market.sideB, market.startTime, market.status, market.url]
    );
}

async function syncNewsApiMarkets({ force = false, limit = 120 } = {}) {
    const apiKey = process.env.NEWS_API_KEY;
    if (!apiKey) throw new Error('NEWS_API_KEY is not configured');

    const cachedNews = await dbAll(
        `SELECT *
         FROM markets
         WHERE category IN ('news','tech','politics','sports')
           AND (id LIKE 'news_%' OR id LIKE 'tech_%' OR id LIKE 'geo_%')
           AND status IN ('open','upcoming','live')
         ORDER BY timestamp DESC
         LIMIT ?`,
        [limit]
    );
    if (!force && cachedNews.length >= 12) return cachedNews;

    const countries = ['us', 'ke'];
    const topicQueries = [
        'technology OR artificial intelligence OR geopolitics OR election OR sports'
    ];
    const requests = [
        ...countries.map(country =>
            axios.get('https://newsapi.org/v2/top-headlines', {
                params: { country, pageSize: 10, apiKey }
            }).catch(() => ({ data: { articles: [] } }))
        ),
        ...topicQueries.map(q =>
            axios.get('https://newsapi.org/v2/everything', {
                params: { q, language: 'en', sortBy: 'publishedAt', pageSize: 15, apiKey }
            }).catch(() => ({ data: { articles: [] } }))
        )
    ];

    const responses = await Promise.all(requests);
    const articles = responses.flatMap(response => response.data?.articles || []);
    const seen = new Set();
    const processedMarkets = [];

    for (const article of articles) {
        const market = normalizeNewsArticle(article);
        if (!market || seen.has(market.id)) continue;
        seen.add(market.id);
        await saveNewsMarket(market);
        processedMarkets.push(market);
        if (processedMarkets.length >= limit) break;
    }

    return processedMarkets.length ? processedMarkets : cachedNews;
}

async function syncTmdbMarkets() {
    if (!process.env.TMDB_API_KEY) {
        console.warn('TMDB API key is not configured. Skipping TMDB market sync.');
        return;
    }

    const tmdbBase = 'https://api.themoviedb.org/3';
    const authHeaders = process.env.TMDB_READ_ACCESS_TOKEN ? {
        Authorization: `Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}`
    } : undefined;

    const endpoints = [
        { path: '/trending/movie/week', label: 'Trending Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/upcoming', label: 'Upcoming Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/popular', label: 'Popular Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/top_rated', label: 'Top Rated Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/now_playing', label: 'Now Playing Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/trending/tv/week', label: 'Trending TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/tv/popular', label: 'Popular TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/tv/top_rated', label: 'Top Rated TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/search/movie', label: 'Award Movie', categorySuffix: 'movie', limit: 5, params: { query: 'oscar', include_adult: false } },
        { path: '/search/tv', label: 'Award TV Show', categorySuffix: 'tv', limit: 5, params: { query: 'award', include_adult: false } }
    ];

    try {
        for (const endpoint of endpoints) {
            const url = `${tmdbBase}${endpoint.path}`;
            const response = await axios.get(url, {
                params: {
                    api_key: process.env.TMDB_API_KEY,
                    language: 'en-US',
                    page: 1,
                    ...(endpoint.params || {})
                },
                headers: authHeaders
            });

            const items = Array.isArray(response.data?.results) ? response.data.results.slice(0, endpoint.limit) : [];
            const expiryTime = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

            items.forEach((item) => {
                const title = item.title || item.name || item.original_name || item.original_title || 'Unnamed';
                const idSource = `${endpoint.path}_${item.id || title}`;
                const hash = crypto.createHash('md5').update(idSource).digest('hex');
                const rawHeadline = endpoint.path.includes('trending')
                    ? `${title} is trending on TMDB right now`
                    : endpoint.path.includes('upcoming')
                        ? `${title} is an upcoming TMDB release`
                        : endpoint.path.includes('popular')
                            ? `${title} is one of TMDB's most popular titles`
                            : endpoint.path.includes('top_rated')
                                ? `${title} is a top rated TMDB title`
                                : endpoint.path.includes('/search/')
                                    ? `${title} is getting award attention on TMDB`
                                    : `${title} is featured on TMDB`; 

                const overview = item.overview || item.description || `TMDB entry for ${title}.`;
                const mediaUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null;
                const detailUrl = item.id ? `${endpoint.categorySuffix === 'tv' ? 'https://www.themoviedb.org/tv' : 'https://www.themoviedb.org/movie'}/${item.id}` : null;

                const content = [
                    `Title: ${title}`,
                    endpoint.categorySuffix === 'movie' ? `Release Date: ${item.release_date || 'N/A'}` : `First Air Date: ${item.first_air_date || item.first_air_date || 'N/A'}`,
                    `Popularity: ${item.popularity}`,
                    `Vote Average: ${item.vote_average ?? 'N/A'}`,
                    `Vote Count: ${item.vote_count ?? 'N/A'}`,
                    `Overview: ${overview}`
                ].join('\n');

                const market = buildNewsMarket({
                    id: `tmdb_${endpoint.categorySuffix}_${hash}`,
                    title: rawHeadline,
                    description: overview,
                    content,
                    media_url: mediaUrl,
                    media_type: 'image',
                    category: 'tech',
                    country: 'TMDB',
                    startTime: expiryTime,
                    url: item.homepage || detailUrl,
                    status: 'open',
                    sideA: 'YES',
                    sideB: 'NO'
                });

                db.run(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, 'image', 'tech', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, media_type=excluded.media_type, category=excluded.category, country=excluded.country, sideA=excluded.sideA, sideB=excluded.sideB, startTime=excluded.startTime, status=excluded.status, url=excluded.url, timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, market.country, market.sideA, market.sideB, market.startTime, market.status, market.url]);
            });
        }
    } catch (e) {
        console.error('TMDB sync error:', e.message);
    }
}

// --- MAILER ---
// Gmail refuses plain account passwords for SMTP ("534-5.7.9 Application-specific
// password required"). EMAIL_PASS must therefore hold a 16-character Google App
// Password, not the normal account password.
const EMAIL_FROM_NAME = 'PolySoko Support';
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error('[FATAL CONFIG] EMAIL_USER / EMAIL_PASS are not set; transactional email will not send.');
}

// --- AI helpers: retry on 429 and fallback between OpenAI <-> Gemini ---
async function callOpenAI(model, messages, opts = {}) {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            const res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model,
                messages,
                temperature: opts.temperature ?? 0.6,
                max_tokens: opts.max_tokens ?? 320
            }, {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
            });
            return res.data?.choices?.[0]?.message?.content || null;
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429) {
                attempt++;
                const delay = 300 * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    const e = new Error('OpenAI rate-limited');
    e.code = 429;
    throw e;
}

async function callGemini(promptText, opts = {}) {
    const modelCandidates = [
        opts.model,
        process.env.GEMINI_MODEL,
        ...DEFAULT_GEMINI_MODELS
    ].filter(Boolean);
    const models = [...new Set(modelCandidates)];
    const maxAttempts = 3;

    for (const model of models) {
        let attempt = 0;
        while (attempt < maxAttempts) {
            try {
                const body = {
                    contents: [{ parts: [{ text: promptText }] }],
                    generationConfig: {
                        temperature: opts.temperature ?? 0.6,
                        maxOutputTokens: opts.maxOutputTokens ?? 320
                    }
                };
                const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, body);
                return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
            } catch (err) {
                const status = err?.response?.status;
                if (status === 404 || status === 400) {
                    console.warn(`Gemini model unavailable: ${model} (${status})`);
                    break;
                }
                if (status === 429) {
                    attempt++;
                    const delay = 300 * Math.pow(2, attempt);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
    }
    const e = new Error(`No configured Gemini model could generate content. Tried: ${models.join(', ')}`);
    e.code = 'NO_GEMINI_MODEL';
    throw e;
}

async function callAI({ engine = 'gpt', messages = null, promptText = '', suppressErrors = false }) {
    const localText = buildLocalAIReply({ engine, messages, promptText });
    if (localText) return { engine: 'polysoko-local', text: localText };
    return {
        engine: 'polysoko-local',
        text: suppressErrors ? null : 'PolySoko Chat is ready. Ask about markets, bets, deposits, withdrawals, profile photos, sports, or account safety.'
    };
    if (suppressErrors) return { engine: 'polysoko-local', text: null };

    // Priority 1: OpenAI (only if engine is gpt and key is available)
    const useOpenAI = engine === 'gpt' && !!process.env.OPENAI_API_KEY;
    const useGemini = !!process.env.GEMINI_API_KEY;

    if (useOpenAI) {
        try {
            const resp = await callOpenAI('gpt-4o', messages, { temperature: 0.6, max_tokens: 320 });
            if (resp) return { engine: 'openai', text: resp };
        } catch (err) {
            if (suppressErrors) return { engine: 'none', text: null };
            console.error("Ã¢ÂÅ’ OpenAI Error:", err.response?.status || err.message);
            if (suppressErrors) return { engine: 'none', text: null };
            if (!useGemini) throw err; // Only throw if we can't fall back to Gemini
        }
    }

    if (useGemini) {
        try {
            const resp = await callGemini(promptText || (messages?.map(m => m.content).join('\n') || ''), { temperature: 0.6, maxOutputTokens: 320 });
            if (resp) return { engine: 'gemini', text: resp };
        } catch (err) {
            if (suppressErrors) return { engine: 'none', text: null };
            console.error("Ã¢ÂÅ’ Gemini Error:", err.response?.status || err.message);
            if (suppressErrors) return { engine: 'none', text: null };
            throw err;
        }
    }

    return { engine: 'none', text: null };
}

function buildLocalAIReply({ engine = '', messages = null, promptText = '' } = {}) {
    const latest = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m.role === 'user')?.content || ''
        : promptText;
    const text = String(latest || promptText || '').trim();
    const lower = text.toLowerCase();
    const original = text.replace(/^title:\s*/i, '').replace(/\s+/g, ' ').trim();

    if (!text) return null;

    if (engine === 'headline-bot') {
        return buildNewsQuestion(text);
    }

    if (engine === 'market-editor' || /rewrite|rephrase|sharper|clearer/i.test(text)) {
        const titleMatch = text.match(/TITLE:\s*([^\n]+)/i);
        const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/i);
        const title = buildNewsQuestion(titleMatch?.[1] || original || 'Market update');
        const description = cleanMarketDescription(descMatch?.[1] || title);
        return JSON.stringify({ title, description });
    }

    if (/generate.*prediction market|current price|24h change/i.test(text)) {
        const coin = text.match(/for\s+([A-Za-z0-9 .'-]+)\s+\(/i)?.[1]?.trim() || 'this asset';
        return polishMarketTitle(`Can ${coin} close higher today?`);
    }

    if (lower.includes('avatar') || lower.includes('profile picture') || lower.includes('photo')) {
        return 'Open Profile, choose a PNG, JPG, WebP, or GIF under 5MB, then press Save. If the old photo stays visible, refresh once after the save because browsers can cache images.';
    }
    if (lower.includes('deposit') || lower.includes('mpesa') || lower.includes('m-pesa')) {
        return `Use Deposit, enter the amount, then approve the M-Pesa prompt. Never share your PIN or OTP with anyone claiming to help from chat.`;
    }
    if (lower.includes('withdraw')) {
        return 'Open Withdrawals, enter at least 100 sKES, and submit. If it fails, check your balance first, then ask an admin to review the withdrawal log.';
    }
    if (lower.includes('bet') || lower.includes('market') || lower.includes('odds')) {
        return 'Open the market card, compare the two sides, then stake only what you are comfortable risking. Live and boosted markets can change quickly, so check the status before confirming.';
    }
    if (lower.includes('settle') || lower.includes('won') || lower.includes('lost')) {
        return 'Settlements run from confirmed market results. If a bet should be settled, open Admin and use the settlement controls for closed markets.';
    }
    if (lower.includes('sport') || lower.includes('football') || lower.includes('nba') || lower.includes('nfl')) {
        return 'Sports are grouped by subcategory now. Open Sports, pick Football, NBA, NFL, Basketball, Baseball, Hockey, Volleyball, Rugby, Handball, or AFL, and matches will appear under their leagues.';
    }
    if (lower.includes('password') || lower.includes('login') || lower.includes('security')) {
        return 'For account safety, use reset password from the login page and ignore anyone asking for your password, OTP, wallet private key, or M-Pesa PIN.';
    }

    return 'I can help with PolySoko markets, sports, deposits, withdrawals, profile photos, and account safety. Tell me what you are trying to do and I will guide you through the next step.';
}

function cleanMarketTitle(value) {
    const text = String(value || '').replace(/\s+-\s+[^-]+$/, '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Market update';
    return text.length > 140 ? `${text.slice(0, 137).trim()}...` : text;
}

function cleanMarketDescription(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Follow the source update and resolve this market using reliable public records.';
    return text.length > 260 ? `${text.slice(0, 257).trim()}...` : text;
}

function normalizeEmailAddress(value) {
    const email = String(value || '').trim();
    return email || null;
}

function htmlToEmailText(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
        .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const sendPolyMail = async (to, subject, html) => {
    const recipient = normalizeEmailAddress(to);
    console.log(`[mail] Attempting to send "${subject}" to: "${recipient || 'missing recipient'}"`);
    if (!recipient || recipient === "null") return { success: false, error: 'missing recipient' };
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        const error = 'EMAIL_USER / EMAIL_PASS are not configured';
        console.error(`[mail] ERROR sending "${subject}" to ${recipient}: ${error}`);
        return { success: false, error };
    }
    try {
        const text = htmlToEmailText(html);
        const info = await transporter.sendMail({
            from: `"${EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
            sender: process.env.EMAIL_USER,
            replyTo: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
            to: recipient,
            subject,
            text: text || subject,
            html,
            headers: {
                'X-PolySoko-Email-Type': 'transactional'
            }
        });
        const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
        const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
        const pending = Array.isArray(info?.pending) ? info.pending : [];
        if (rejected.length || pending.length || accepted.length === 0) {
            const error = `SMTP did not accept recipient. accepted=${accepted.join(',') || 'none'} rejected=${rejected.join(',') || 'none'} pending=${pending.join(',') || 'none'}`;
            console.error(`[mail] ERROR sending "${subject}" to ${recipient}: ${error}`);
            return { success: false, error, messageId: info?.messageId, accepted, rejected, pending };
        }
        console.log(`[mail] Accepted "${subject}" for ${recipient} (id=${info?.messageId || 'n/a'}, accepted=${accepted.join(',')})`);
        return { success: true, messageId: info?.messageId, accepted };
    } catch (e) {
        // Gmail rejects normal account passwords with "534-5.7.9 Application-specific
        // password required". That was previously swallowed into one log line, so
        // verification emails silently never arrived. Report the cause explicitly.
        const message = (e && e.message) ? e.message : String(e);
        console.error(`[mail] ERROR sending "${subject}" to ${recipient}:`, message);
        if (/Application-specific password|534-5\.7\.9|Invalid login/i.test(message)) {
            console.error('[mail] EMAIL_PASS must be a Google App Password (16 chars), not the normal Gmail password.');
            console.error('[mail] Create one at https://myaccount.google.com/apppasswords');
        }
        return { success: false, error: message };
    }
};

function mailFailureMessage(result, fallback = "Email could not be sent. Please try again shortly.") {
    const raw = String(result?.error || '');
    if (/EMAIL_USER|EMAIL_PASS|Missing credentials/i.test(raw)) {
        return "Email is not configured on the server. Add EMAIL_USER and EMAIL_PASS to server/.env locally and to Railway variables in production, then restart.";
    }
    if (/Application-specific password|534-5\.7\.9|Invalid login/i.test(raw)) {
        return "Email login failed. For Gmail, EMAIL_PASS must be a Google App Password, not your normal Gmail password.";
    }
    return fallback;
}
// Define the paths you need
const foldersToCreate = [
    uploadPath,
    path.join(__dirname, 'backups')
];

foldersToCreate.forEach(dir => {
    if (!fs.existsSync(dir)) {
        // recursive: true allows it to create /public AND /uploads at once
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Ã°Å¸â€œÂ Created directory: ${dir}`);
    }
});
const emitAdminEvent = (event, data = {}) => {
    io.to("adminRoom").emit(event, data);
};
const mapStatus = (short) => {
    if (["1H","2H","HT"].includes(short)) return "live";
    if (short === "FT") return "ended";
    return "open"; // Ã°Å¸â€˜Ë† CRITICAL
};
const MARKET_STATUS = {
  UPCOMING: "upcoming",
  LIVE: "live",
  CLOSED: "closed",
  SETTLED: "settled"
};

const formatPhone = (phone) => {
    let p = String(phone || '').trim();
    if (!p) return '';
    if (p.startsWith('0')) p = '+254' + p.substring(1);
    if (!p.startsWith('+')) p = '+' + p;
    return p;
};
// --- MULTER STORAGE ---
const storage = multer.diskStorage({
    destination: uploadPath,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const mime = String(file.mimetype || '').toLowerCase();
        if (/\.(jpeg|jpg|png|webp|gif)$/.test(ext) && /^image\/(jpeg|png|webp|gif)$/.test(mime)) {
            return cb(null, true);
        }
        cb(new Error("Only images are allowed"));
    }
});

function handleAvatarUpload(req, res, next) {
    upload.single('avatar')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? "Profile picture must be 5MB or smaller"
            : (err.message || "Avatar upload failed");
        return res.status(400).json({ success: false, message });
    });
}

const profileAvatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mime = String(file.mimetype || '').toLowerCase();
        if (/\.(jpeg|jpg|png|webp|gif)$/.test(ext) && /^image\/(jpeg|png|webp|gif)$/.test(mime)) {
            return cb(null, true);
        }
        cb(new Error("Only PNG, JPG, WebP, or GIF images are allowed"));
    }
});

function handleProfileAvatarUpload(req, res, next) {
    profileAvatarUpload.single('avatar')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? "Profile picture must be 2MB or smaller"
            : (err.message || "Avatar upload failed");
        return res.status(400).json({ success: false, message });
    });
}

async function persistProfileAvatar(req, res) {
    if (!req.file?.buffer?.length) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    // Verify the real content instead of trusting the declared type. This is what
    // let an HTML error page be saved as a ".jpg" in the first place.
    const detected = detectImageType(req.file.buffer);
    if (!detected) {
        return res.status(400).json({
            success: false,
            message: "That file is not a valid PNG, JPG, WebP, or GIF image."
        });
    }
    if (req.file.buffer.length > AVATAR_MAX_BYTES) {
        return res.status(400).json({ success: false, message: "Profile picture must be 2MB or smaller" });
    }

    const phone = normalizePhone(req.user.phone);
    const avatarPath = avatarPathFor(phone);
    const buffer = Buffer.from(req.file.buffer);

    try {
        const current = await dbGet(`SELECT avatar_url FROM users WHERE phone = ?`, [phone]);
        const result = await dbRun(
            `UPDATE users SET avatar_url = ?, avatar_mime = ?, avatar_data = ? WHERE phone = ?`,
            [avatarPath, detected.mime, buffer, phone]
        );

        if (!result.changes) {
            return res.status(404).json({ success: false, message: "User account not found for this session" });
        }

        // Best-effort cleanup of the legacy on-disk file. Failure is harmless
        // because the picture is now served from the database.
        const previous = current?.avatar_url || '';
        if (previous.startsWith('/uploads/avatars/') && !previous.includes('default.png')) {
            const oldFilePath = path.join(uploadPath, path.basename(previous));
            if (oldFilePath.startsWith(uploadPath)) {
                fs.promises.rm(oldFilePath, { force: true }).catch(() => {});
            }
        }

        const publicAvatarUrl = publicAssetUrl(req, avatarPath);
        return res.json({ success: true, avatarPath, avatar_url: avatarPath, avatarUrl: publicAvatarUrl, url: publicAvatarUrl });
    } catch (e) {
        console.error("Profile avatar save failed:", e.message);
        return res.status(500).json({ success: false, message: "Profile picture could not be saved" });
    }
}

function publicAssetUrl(req, assetPath) {
    if (!assetPath) return null;
    if (/^https?:\/\//i.test(assetPath)) return assetPath;
    const cleanPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
    if (configuredPublicApiBase) return `${configuredPublicApiBase}${cleanPath}`;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
    if (!host) {
        return `${DEFAULT_PUBLIC_API_BASE}${cleanPath}`;
    }
    return `${proto}://${host}${cleanPath}`;
}

function publicSiteUrl() {
    const candidate = configuredPublicSiteUrl;
    if (candidate && !/ngrok|localhost|127\.0\.0\.1/i.test(candidate) && !isStaleUrl(candidate)) {
        return candidate;
    }
    return DEFAULT_PUBLIC_SITE_URL;
}

function verificationUrl(token) {
    const url = new URL('/verify.html', PUBLIC_SITE_URL);
    url.searchParams.set('token', token);
    return url.toString();
}

function passwordResetUrl(token, otp) {
    const url = new URL('/reset.password.html', PUBLIC_SITE_URL);
    url.searchParams.set('token', token);
    url.searchParams.set('otp', otp);
    return url.toString();
}

// --- DB SCHEMA & AUTO-MIGRATION ---
db.serialize(() => {
    // 1. Create tables
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE, password TEXT, 
        balance REAL DEFAULT 0, crypto_balance REAL DEFAULT 0, otp TEXT, status TEXT DEFAULT 'unverified',
        terms_accepted INTEGER DEFAULT 0, referral_code TEXT, referred_by TEXT, verification_token TEXT,
        avatar_url TEXT DEFAULT '/uploads/avatars/default.png', avatar_mime TEXT, avatar_data BLOB, wallet_address TEXT,
        role TEXT DEFAULT 'user'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_phone TEXT,
        title TEXT,
        message TEXT,
        type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT, type TEXT, amount REAL, 
        reference TEXT, market_id TEXT, side TEXT, status TEXT, potential_payout REAL, 
        settled_amount REAL, odds REAL, bet_id INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY, title TEXT, description TEXT, category TEXT, sideA TEXT, sideB TEXT, 
        oddsA REAL DEFAULT 1.90, oddsB REAL DEFAULT 1.90, home_volume REAL DEFAULT 0, away_volume REAL DEFAULT 0,
        league TEXT, country TEXT, sport TEXT, startTime DATETIME, result TEXT, settled INTEGER DEFAULT 0,
        media_url TEXT, media_type TEXT, content TEXT,
        creator TEXT,
        url TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'open'
    )`);
db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    token TEXT,
        otp TEXT,
    expires INTEGER
)`);
db.run(`
CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    market_id TEXT,
    event TEXT,
    picked TEXT,
    amount REAL,
    odds REAL,
    status TEXT CHECK(status IN ('active','won','lost','cancelled')),
    transaction_id INTEGER,
    reference TEXT,
    category TEXT,
    commence_time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    ua_string TEXT,
    first_login DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
    // 2. Performance Indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(user_phone)`);

const addColumnSafely = (tableName, columnName, definition, callback) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
        if (err || !columns) return;

        const exists = columns.some(col => String(col.name).toLowerCase() === String(columnName).toLowerCase());
        
        if (!exists) {
            const cleanDef = definition.replace(/,$/, '');
            const sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${cleanDef}`;

            console.log("Ã°Å¸Â§Âª Running:", sql);

            db.run(sql, (err) => {
                if (err) console.error("Ã¢ÂÅ’ ALTER ERROR:", err.message);
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    });
};
   
    addColumnSafely('users', 'crypto_balance', 'REAL DEFAULT 0');
    addColumnSafely('markets', 'category', 'TEXT');
    addColumnSafely('markets', 'league', 'TEXT');
    addColumnSafely('markets', 'country', 'TEXT');
    addColumnSafely('markets', 'startTime', 'DATETIME');
    addColumnSafely('markets', 'result', 'TEXT');
    addColumnSafely('markets', 'settled', 'INTEGER DEFAULT 0');
    addColumnSafely('markets', 'media_url', 'TEXT');    
    addColumnSafely('markets', 'media_type', 'TEXT');   
    addColumnSafely('markets', 'content', 'TEXT');  
    addColumnSafely('transactions', 'odds', 'REAL');
    addColumnSafely('transactions', 'settled_amount', 'REAL');
    addColumnSafely('transactions', 'potential_payout', 'REAL');
    addColumnSafely('transactions', 'bet_id', 'INTEGER');
    addColumnSafely('users', 'verification_token', 'TEXT');
addColumnSafely('transactions', 'mpesa_receipt', 'TEXT');
addColumnSafely('transactions', 'internal_id', 'TEXT');
addColumnSafely('password_resets', 'otp', 'TEXT');
    addColumnSafely('users', 'is_upgraded', 'INTEGER DEFAULT 0');
    addColumnSafely('users', 'upgrade_expiry', 'DATETIME');
    addColumnSafely('users', 'is_suspended', 'INTEGER DEFAULT 0');
    addColumnSafely('users', 'suspension_expires', 'DATETIME');
    
    // Activity logs table
    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_phone TEXT,
        action TEXT,
        details TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const addActivityLog = (phone, action, details = '', ip = '', ua = '') => {
        try {
            db.run(`INSERT INTO activity_logs (user_phone, action, details, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
                [phone, action, String(details).slice(0, 500), ip, String(ua).slice(0, 200)]);
        } catch (e) { console.error('Activity log error:', e.message); }
    };
    global.addActivityLog = addActivityLog;
    addColumnSafely('markets', 'creator', 'TEXT');
    addColumnSafely('markets', 'url', 'TEXT');
    addColumnSafely('markets', 'is_boosted', 'INTEGER DEFAULT 0');
    addColumnSafely('transactions', 'is_boosted', 'INTEGER DEFAULT 0');
    addColumnSafely('bets', 'is_boosted', 'INTEGER DEFAULT 0');
    addColumnSafely('bets', 'transaction_id', 'INTEGER');
    addColumnSafely('bets', 'reference', 'TEXT');
    // Avatar bytes live in the database so they survive redeploys (the container
    // filesystem is ephemeral and used to lose every uploaded picture).
    addColumnSafely('users', 'avatar_mime', 'TEXT');
    addColumnSafely('users', 'avatar_data', 'BLOB');

    // Admin settings table (stores hashed PIN + the resolved admin phone)
    db.run(`CREATE TABLE IF NOT EXISTS admin_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pin_hash TEXT,
        admin_phone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // `admin_phone` lets admin login survive a host that does not define
    // ADMIN_PHONE. Added separately so existing databases are upgraded in place.
    addColumnSafely('admin_settings', 'admin_phone', 'TEXT');
    // Guarantee the singleton row exists; the CHECK (id = 1) constraint means an
    // UPDATE against a missing row is a silent no-op.
    db.run(`INSERT OR IGNORE INTO admin_settings (id, created_at, updated_at) VALUES (1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    setTimeout(() => {
        if (process.env.ADMIN_PHONE) {
            const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
            db.run(`UPDATE users SET role='admin' WHERE phone=?`, [adminPhone], (err) => {
                if (err) console.error("Ã¢ÂÅ’ Admin Assignment Failed:", err.message);
                else console.log(`Ã°Å¸â€˜â€˜ SuperAdmin verified: ${adminPhone}`);
            });
            return;
        }
        // ADMIN_PHONE is optional. When it is absent, adopt whichever account the
        // database already treats as an admin so the panel remains reachable, and
        // remember it so later restarts resolve the same identity.
        resolveAdminPhone()
            .then((resolved) => {
                if (resolved) console.log(`Ã°Å¸â€˜â€˜ SuperAdmin identity resolved: ${resolved}`);
                else console.warn('⚠️  No admin identity available. Set ADMIN_PHONE to enable the admin panel.');
            })
            .catch((err) => console.error('Admin identity resolution failed:', err.message));
    }, 2000); 
});
// --- UTILS ---

// --- CORE UTILS & MIDDLEWARE (Defined early to avoid ReferenceErrors) ---
/** 
 * --- CORE UTILS & MIDDLEWARE ---
 * Defined early to prevent SyntaxErrors (re-declaration) 
 * and ReferenceErrors (using before initialization).
 */
const authenticate = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if(!token) return res.status(401).json({ success:false, code: 'NO_TOKEN' });
    // Resolve the signing secret before verifying. Without this await a request
    // that arrives during startup could be rejected by a process that has not
    // yet loaded the persisted secret, logging the user out spuriously.
    jwtSecretReady.then(() => {
        let decoded;
        try {
            decoded = verifyJwt(token);
        } catch (err) {
            // Distinguish an expired token from a genuinely invalid one so the
            // client can re-authenticate gracefully instead of wiping state.
            const expired = err?.name === 'TokenExpiredError';
            return res.status(401).json({
                success: false,
                code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
                message: expired ? 'Your session has expired. Please sign in again.' : 'Invalid session. Please sign in again.'
            });
        }
        req.user = decoded;
        req.user.phone = normalizePhone(req.user.phone);
        // Check email verification for non-admin routes
        if (!req.user.role || req.user.role !== 'admin') {
            db.get(`SELECT status FROM users WHERE phone=?`, [req.user.phone], (err, user) => {
                if (err || !user) return res.status(401).json({ success: false, code: 'ACCOUNT_NOT_FOUND', message: "Account not found" });
                if (user.status !== 'verified') {
                    return res.status(403).json({ 
                        success: false, 
                        code: 'NEEDS_VERIFICATION',
                        message: "Please verify your email address before accessing this feature. Check your inbox for the verification link.",
                        needsVerification: true 
                    });
                }
                addActivityLog(req.user.phone, 'authenticate', `Accessed ${req.method} ${req.path}`, req.ip, req.headers['user-agent']);
                next();
            });
        } else {
            next();
        }
    }).catch(() => res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: "Authentication is starting up. Please try again." }));
};

const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(403).json({ success: false, message: "Authentication token missing" });

    jwtSecretReady.then(async () => {
        let decoded;
        try {
            decoded = verifyJwt(token);
        } catch {
            return res.status(403).json({ success: false, code: 'TOKEN_INVALID', message: "Invalid or expired session" });
        }
        // Must use the same resolver as the login routes. Comparing against a
        // missing ADMIN_PHONE here would reject every token that pin-login or
        // master-login had just issued for the fallback identity.
        const adminPhone = await resolveAdminPhone();
        const userPhone = normalizePhone(decoded.phone);

        if (!adminPhone || userPhone !== adminPhone) {
            console.warn(`Ã°Å¸Å¡Â« Unauthorized admin access attempt from: ${userPhone}`);
            return res.status(403).json({ success: false, message: "Access denied: Not an administrator" });
        }

        req.user = decoded;
        req.user.role = 'admin';
        req.user.phone = normalizePhone(decoded.phone);
        next();
    }).catch(() => res.status(503).json({ success: false, message: "Authentication is starting up. Please try again." }));
};

const createNotification = async (phone, title, message, type = 'info') => {
    try {
        await dbRun(`INSERT INTO notifications (user_phone, title, message, type) VALUES (?, ?, ?, ?)`, 
            [normalizePhone(phone), title, message, type]);
        io.to(normalizePhone(phone)).emit('newNotification', { title, message, type });
    } catch (e) { console.error("Notification Error:", e); }
};

const emitBalance = (phone) => {
    const normalized = normalizePhone(phone);
    db.get(`SELECT balance FROM users WHERE phone=?`, [normalized], (err, user) => {
        if (err) return console.error("Ã¢ÂÅ’ Database error in emitBalance:", err);
        if (user) {
            io.to(normalized).emit("balanceUpdate", { balance: user.balance });
        }
    });
};

const emitMarkets = () => {
    const sql = `SELECT * FROM markets WHERE status IN ('open','live','upcoming','pending') ORDER BY category ASC, title ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) return console.error("Ã¢ÂÅ’ DB Error:", err.message);
        io.emit('marketsUpdated', {
            status: 'success',
            count: rows?.length || 0,
            lastUpdated: new Date().toISOString(),
            markets: rows || []
        });
        // Also notify admin room of pending counts
        const pending = rows.filter(m => m.status === 'pending').length;
        io.to("adminRoom").emit('adminStatsUpdate', { pendingMarkets: pending });
    });
};

// --- NOTIFICATION ROUTES ---
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const notes = await dbAll(
            `SELECT * FROM notifications WHERE user_phone = ? ORDER BY created_at DESC LIMIT 50`,
            [normalizePhone(req.user.phone)]
        );
        res.json({ success: true, notifications: notes });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/notifications/read-all', authenticate, async (req, res) => {
    try {
        await dbRun(
            `UPDATE notifications SET is_read = 1 WHERE user_phone = ?`,
            [normalizePhone(req.user.phone)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/notifications/:id', authenticate, async (req, res) => {
    try {
        await dbRun(
            `DELETE FROM notifications WHERE id = ? AND user_phone = ?`,
            [req.params.id, normalizePhone(req.user.phone)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

const syncFootballMarkets = async () => {
    try {
        if (!API_SPORTS_KEY) {
            console.warn("Sports API key is not configured. Football sync skipped.");
            return;
        }

        console.log("Ã¢Å¡Â½ Syncing football fixtures via API-Football...");

        // Dates for Today and Tomorrow in YYYY-MM-DD
        const dates = [0, 1].map((daysAhead) => formatNairobiDate(daysAhead));

        const responses = await Promise.all(dates.map((date) => (
            axios.get('https://v3.football.api-sports.io/fixtures', {
                params: {
                    date,
                    timezone: 'Africa/Nairobi'
                },
                headers: {
                    'x-apisports-key': API_SPORTS_KEY
                }
            })
        )));

        // API-Football returns data inside 'response'
        const matches = responses.flatMap((res) => res.data?.response || []);
        const apiErrors = responses.map((res) => res.data?.errors).filter(e => e && Object.keys(e).length > 0);

        if (apiErrors.length > 0) {
            console.error("Ã¢Å¡Â Ã¯Â¸Â API-Football Errors:", JSON.stringify(apiErrors));
        }

        if (matches.length === 0) {
            console.log("Ã¢Å¡Â Ã¯Â¸Â No fixtures returned from API-Football.");
            return;
        }

        console.log(`Ã¢Å¡Â½ Syncing ${matches.length} matches...`);
        await processMatches(matches);

    } catch (e) {
        console.error("Ã¢Å¡Â½ API-Football Sync Error:", e.response?.data || e.message);
    }
};
const processMatches = async (matches) => {
    if (!matches || matches.length === 0) return;

    for (const m of matches) {
        // API-Football uses m.fixture.id and m.fixture.date
        const marketId = `fb_${m.fixture.id}`;
        const homeTeam = m.teams.home.name;
        const awayTeam = m.teams.away.name;
        const title = `${homeTeam} vs ${awayTeam}`;

        // Compute status using the fixture status (e.g., 'NS', '1H', 'FT')
        const status = computeMarketStatus(
            m.fixture.date,
            m.fixture.status.short
        );

        const category = "sports";

        // Determine result once the match is finished.
        // Football markets settle on HOME vs AWAY (draws are refunded).
        let result = null;
        if (status === 'closed') {
            const hg = Number(m.goals?.home);
            const ag = Number(m.goals?.away);
            if (Number.isFinite(hg) && Number.isFinite(ag)) {
                if (hg > ag) result = 'HOME';
                else if (ag > hg) result = 'AWAY';
                else result = 'DRAW';
            }
        }

        await dbRun(
            `INSERT INTO markets 
            (id, title, category, sport, sideA, sideB, oddsA, oddsB, startTime, status, league, country, result) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
            title = excluded.title,
            category = excluded.category,
            sport = excluded.sport,
            sideA = excluded.sideA,
            sideB = excluded.sideB,
            status = excluded.status,
            startTime = excluded.startTime,
            league = excluded.league,
            country = excluded.country,
            result = COALESCE(excluded.result, markets.result)`,
            [
                marketId,
                title,
                category,
                'Football',
                homeTeam,
                awayTeam,
                1.90, 
                1.90, 
                m.fixture.date,
                status,
                m.league.name || "Football",
                m.league.country || m.league.flag || "Football",
                result
            ]
        );

        // Auto-settle as soon as outcome is known.
        if (status === 'closed' && result) {
            if (result === 'DRAW') {
                await cancelMarket(marketId, 'DRAW');
            } else {
                await settleMarket(marketId, result);
            }
        }
    }

    emitMarkets();
};

const SPORTS_SOURCES = [
    { key: 'nba', label: 'NBA', host: 'https://v2.nba.api-sports.io', path: '/games' },
    { key: 'nfl', label: 'NFL', host: 'https://v1.american-football.api-sports.io', path: '/games' },
    { key: 'basketball', label: 'Basketball', host: 'https://v1.basketball.api-sports.io', path: '/games' },
    { key: 'baseball', label: 'Baseball', host: 'https://v1.baseball.api-sports.io', path: '/games' },
    { key: 'hockey', label: 'Hockey', host: 'https://v1.hockey.api-sports.io', path: '/games' },
    { key: 'volleyball', label: 'Volleyball', host: 'https://v1.volleyball.api-sports.io', path: '/games' },
    { key: 'rugby', label: 'Rugby', host: 'https://v1.rugby.api-sports.io', path: '/games' },
    { key: 'handball', label: 'Handball', host: 'https://v1.handball.api-sports.io', path: '/games' },
    { key: 'cricket', label: 'Cricket', host: 'https://v1.cricket.api-sports.io', path: '/matches' },
    { key: 'tennis', label: 'Tennis', host: 'https://v1.tennis.api-sports.io', path: '/matches' },
    { key: 'mma', label: 'MMA', host: 'https://v1.mma.api-sports.io', path: '/fights' },
    { key: 'afl', label: 'AFL', host: 'https://v1.afl.api-sports.io', path: '/games' }
];
const SPORTS_LABEL_BY_KEY = Object.fromEntries(SPORTS_SOURCES.map(sport => [sport.key, sport.label]));

function sportKeyFromMarketId(id) {
    const match = String(id || '').match(/^sp_([a-z0-9-]+)_/i);
    return match ? match[1].toLowerCase() : '';
}

function sportLabelFromMarketId(id) {
    const key = sportKeyFromMarketId(id);
    return SPORTS_LABEL_BY_KEY[key] || (key ? key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
}

function contentFieldValue(content, field) {
    const match = String(content || '').match(new RegExp(`^${field}:\\s*(.+)$`, 'im'));
    return match ? match[1].trim() : '';
}

async function repairSportsMarketMetadata() {
    await ensureDbColumn('markets', 'sport', 'TEXT');

    const rows = await dbAll(
        `SELECT id, title, category, sport, sideA, sideB, country, league, content, startTime, status
         FROM markets
         WHERE id LIKE 'sp_%' OR id LIKE 'fb_%' OR category='football' OR category='sports'`,
        []
    );

    const validStatuses = new Set(['open', 'upcoming', 'live', 'closed', 'settled', 'cancelled', 'suspended', 'pending']);

    for (const row of rows || []) {
        const isFootballFixture = row.id?.startsWith('fb_') || (
            row.category === 'football' &&
            (
                String(row.sport || '').toLowerCase() === 'football' ||
                /\s+vs\s+/i.test(String(row.title || '')) ||
                !['YES', 'NO', 'LIKELY', 'UNLIKELY'].includes(String(row.sideA || '').toUpperCase())
            )
        );
        if (row.category === 'football' && !isFootballFixture) continue;

        const isFootball = isFootballFixture;
        const sport = isFootball
            ? 'Football'
            : (row.sport || contentFieldValue(row.content, 'Sport') || sportLabelFromMarketId(row.id) || 'Other');
        const country = contentFieldValue(row.content, 'Location') ||
            (/^sp_/i.test(row.id || '') && row.country === sport ? 'International' : row.country) ||
            'International';
        const status = validStatuses.has(String(row.status || '').toLowerCase())
            ? row.status
            : computeMarketStatus(row.startTime);

        // Skip writes when the row already matches (avoids piling up no-op
        // UPDATEs on every boot, which is costly on remote PostgreSQL).
        if (
            row.category === 'sports' &&
            row.sport === sport &&
            row.country === country &&
            row.status === status
        ) {
            continue;
        }


        await dbRun(
            `UPDATE markets
             SET category = 'sports',
                 sport = ?,
                 country = ?,
                 status = ?
             WHERE id = ?`,
            [sport, country, status, row.id]
        );
    }
}

const sportsStatusCache = new Map();

function parseEnabledSports() {
    const configured = process.env.SPORTS_ENABLED_SOURCES || process.env.API_SPORTS_ENABLED_SOURCES || '';
    return configured
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
}

function sportsUrl(sport, endpoint = sport.path) {
    return `${sport.host}${endpoint}`;
}

function hasApiErrors(data) {
    const errors = data?.errors;
    if (!errors) return false;
    if (Array.isArray(errors)) return errors.length > 0;
    return Object.keys(errors).length > 0;
}

async function isSportsSourceAvailable(sport) {
    const enabled = parseEnabledSports();
    if (enabled.length && !enabled.includes(sport.key)) return false;

    const cached = sportsStatusCache.get(sport.key);
    if (cached && Date.now() - cached.checkedAt < 6 * 60 * 60 * 1000) {
        return cached.available;
    }

    try {
        const response = await axios.get(sportsUrl(sport, '/status'), {
            headers: { 'x-apisports-key': API_SPORTS_KEY },
            timeout: 10000
        });
        const available = response.status === 200 && !hasApiErrors(response.data);
        const plan = response.data?.response?.subscription?.plan || 'unknown';
        const requests = response.data?.response?.requests;
        sportsStatusCache.set(sport.key, { available, checkedAt: Date.now(), plan, requests });
        if (available) {
            console.log(`${sport.label} API available on ${plan} plan.`);
        } else {
            console.warn(`${sport.label} API is not available for this key.`);
        }
        return available;
    } catch (e) {
        const status = e.response?.status;
        const errors = e.response?.data?.errors || e.response?.data || e.message;
        sportsStatusCache.set(sport.key, { available: false, checkedAt: Date.now(), plan: 'unavailable' });
        console.warn(`${sport.label} API status check failed${status ? ` (${status})` : ''}:`, errors);
        return false;
    }
}

function getSportsGameId(game, sportKey) {
    return game?.game?.id || game?.id || game?.fixture?.id || game?.event?.id || `${sportKey}_${crypto.createHash('md5').update(JSON.stringify(game)).digest('hex').slice(0, 14)}`;
}

function getSportsTeamName(game, side) {
    const index = side === 'home' ? 0 : 1;
    const teamValue = game?.teams?.[side] || game?.team?.[side] || game?.[side] || game?.competitors?.[index] || game?.participants?.[index];
    if (typeof teamValue === 'string') return teamValue;
    return game?.teams?.[side]?.name ||
        game?.team?.[side]?.name ||
        game?.[side]?.name ||
        game?.competitors?.[index]?.name ||
        game?.participants?.[index]?.name ||
        game?.participants?.[index]?.team?.name ||
        game?.teams?.[side]?.team?.name ||
        "";
}

function getSportsStartTime(game) {
    return game?.game?.date ||
        game?.date ||
        game?.fixture?.date ||
        game?.time ||
        new Date().toISOString();
}

function getSportsStatus(game, startTime) {
    const raw = game?.game?.status?.short ||
        game?.status?.short ||
        game?.fixture?.status?.short ||
        game?.status ||
        null;
    return computeMarketStatus(startTime, raw);
}

const syncSportsMarkets = async () => {
    if (!API_SPORTS_KEY) {
        console.warn("Sports API key is not configured. Set SPORTS_API_KEY, API_SPORTS_KEY, or FOOTBALL_API_KEY.");
        return;
    }

    await dbRun(
        `DELETE FROM markets
         WHERE (category='sports' OR id LIKE 'sp_%')
           AND (title IN ('Home vs Away', 'Unknown vs Unknown')
                OR sideA IN ('Home', 'Away', 'Unknown', '')
                OR sideB IN ('Home', 'Away', 'Unknown', '')
                OR sideA IS NULL
                OR sideB IS NULL)`,
        []
    );

    const dates = Array.from({ length: SPORTS_SYNC_DAYS }, (_, daysAhead) => formatNairobiDate(daysAhead));
    let synced = 0;
    const sourceCounts = {};

    for (const sport of SPORTS_SOURCES) {
        try {
            const responses = await Promise.all(dates.map((date) => (
                axios.get(sportsUrl(sport), {
                    params: { date, timezone: 'Africa/Nairobi' },
                    headers: { 'x-apisports-key': API_SPORTS_KEY }
                }).catch((e) => {
                    console.warn(`${sport.label} sync skipped for ${date}:`, e.response?.data || e.message);
                    return { data: { response: [] } };
                })
            )));

            const games = responses.flatMap((res) => res.data?.response || []);
            sourceCounts[sport.label] = games.length;
            sportsStatusCache.set(sport.key, {
                available: games.length > 0,
                checkedAt: Date.now(),
                plan: games.length > 0 ? 'games endpoint' : 'no games returned'
            });
            for (const game of games) {
                const rawId = getSportsGameId(game, sport.key);
                const marketId = `sp_${sport.key}_${rawId}`;
                const homeTeam = getSportsTeamName(game, 'home');
                const awayTeam = getSportsTeamName(game, 'away');
                if (!homeTeam || !awayTeam) {
                    console.warn(`${sport.label} game skipped because teams were missing: ${rawId}`);
                    continue;
                }
                const startTime = getSportsStartTime(game);
                const status = getSportsStatus(game, startTime);
                const league = game?.league?.name || game?.league || sport.label;
                const location = game?.country?.name || game?.league?.country || 'International';
                const title = `${homeTeam} vs ${awayTeam}`;
                const description = `${sport.label} match in ${league}${location ? `, ${location}` : ''}.`;

                await dbRun(
                `INSERT INTO markets
                    (id, title, description, content, category, sport, sideA, sideB, oddsA, oddsB, startTime, status, league, country)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.90, 1.90, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        description = excluded.description,
                        content = excluded.content,
                        category = excluded.category,
                        sport = excluded.sport,
                        sideA = excluded.sideA,
                        sideB = excluded.sideB,
                        startTime = excluded.startTime,
                        status = excluded.status,
                        league = excluded.league,
                        country = excluded.country,
                        timestamp = CURRENT_TIMESTAMP`,
                    [
                        marketId,
                        title,
                        description,
                        [
                            `Sport: ${sport.label}`,
                            `League: ${league}`,
                            `Location: ${location}`,
                            `Starts: ${startTime}`
                        ].join('\n'),
                        'sports',
                        sport.label,
                        homeTeam,
                        awayTeam,
                        startTime,
                        status,
                        league,
                        location
                    ]
                );
                synced += 1;
            }
        } catch (e) {
            console.error(`${sport.label} API-Sports sync error:`, e.response?.data || e.message);
        }
    }

    if (synced > 0) {
        console.log(`Sports sync loaded ${synced} non-football games across ${SPORTS_SYNC_DAYS} days:`, sourceCounts);
        emitMarkets();
    } else {
        console.warn(`Sports sync found no non-football games across ${SPORTS_SYNC_DAYS} days:`, sourceCounts);
    }
    return { synced, sourceCounts, days: SPORTS_SYNC_DAYS };
};

    // Sync weather markets once every 24 hours using the official Weather API
    // Expanded Environmental & Weather Sync
    const syncWeatherMarkets = async () => {
        const towns = [
            // Kenya hub
            { name: 'Mombasa', lat: -4.0435, lon: 39.6682 },
            { name: 'Nairobi', lat: -1.2864, lon: 36.8172 },
            { name: 'Kisumu', lat: -0.0917, lon: 34.7680 },
            { name: 'Nakuru', lat: -0.3031, lon: 36.0800 },
            { name: 'Eldoret', lat: 0.5143, lon: 35.2698 },
            // Global Hubs
            { name: 'London', lat: 51.5074, lon: -0.1278 },
            { name: 'New York', lat: 40.7128, lon: -74.0060 },
            { name: 'Tokyo', lat: 35.6895, lon: 139.6917 },
            { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
            { name: 'Lagos', lat: 6.5244, lon: 3.3792 },
            { name: 'Johannesburg', lat: -26.2041, lon: 28.0473 },
            { name: 'Paris', lat: 48.8566, lon: 2.3522 },
            { name: 'Sydney', lat: -33.8688, lon: 151.2093 }
        ];

        for (const town of towns) {
            try {
                let forecast = null;
                try {
                    const wRes = await axios.get(`http://api.weatherapi.com/v1/forecast.json`, {
                        params: { key: process.env.WEATHER_API_KEY, q: town.name, days: 2, alerts: 'yes' }
                    });
                    const tomorrow = wRes.data?.forecast?.forecastday?.[1];
                    if (tomorrow) {
                        forecast = {
                            date: tomorrow.date,
                            icon: tomorrow.day?.condition?.icon ? `https:${tomorrow.day.condition.icon}` : null,
                            condition: tomorrow.day?.condition?.text || 'Forecast',
                            rainChance: tomorrow.day?.daily_chance_of_rain || 0,
                            avgTemp: tomorrow.day?.avgtemp_c || 0,
                            maxTemp: tomorrow.day?.maxtemp_c || 0,
                            maxWind: tomorrow.day?.maxwind_kph || 0,
                            alerts: wRes.data?.alerts?.alert || [],
                            provider: 'WeatherAPI'
                        };
                    }
                } catch (err) {
                    // Fallback to Open-Meteo if WeatherAPI fails
                    const meteo = await axios.get('https://api.open-meteo.com/v1/forecast', {
                        params: {
                            latitude: town.lat,
                            longitude: town.lon,
                            timezone: 'Africa/Nairobi',
                            daily: 'precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max'
                        }
                    });
                    const daily = meteo.data.daily || {};
                    forecast = {
                        date: daily.time?.[1] || formatNairobiDate(1),
                        icon: null,
                        condition: 'Forecast available',
                        rainChance: daily.precipitation_probability_max?.[1] || 0,
                        avgTemp: ((daily.temperature_2m_max?.[1] || 0) + (daily.temperature_2m_min?.[1] || 0)) / 2,
                        maxTemp: daily.temperature_2m_max?.[1] || 0,
                        maxWind: daily.wind_speed_10m_max?.[1] || 0,
                        alerts: [],
                        provider: 'Open-Meteo'
                    };
                }

                if (!forecast) continue;

                const baseId = `env_${town.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${forecast.date.replace(/-/g, '_')}`;
                
                const marketVariants = [
                    {
                        id: `${baseId}_rain`,
                        title: `Is rain likely in ${town.name} tomorrow?`,
                        desc: `Forecast: ${forecast.condition}. Chance of rain: ${forecast.rainChance}%.`,
                    },
                    {
                        id: `${baseId}_temp`,
                        title: `Is ${town.name} likely to exceed 35Ã‚Â°C tomorrow?`,
                        desc: `Expected Max Temp: ${forecast.maxTemp}Ã‚Â°C. This market resolves YES if the daily high reaches 35.0Ã‚Â°C or more.`,
                    },
                    {
                        id: `${baseId}_wind`,
                        title: `Gale Warning: Winds over 50km/h in ${town.name}?`,
                        desc: `Forecasted Max Wind: ${forecast.maxWind} kph. Resolves YES if peak gusts exceed 50kph.`,
                    },
                    {
                        id: `${baseId}_alert`,
                        title: `Severe Warning (Tsunami/Flood) for ${town.name}?`,
                        desc: `Current Alerts: ${forecast.alerts?.length || 0}. Resolves YES if any official Severe Weather, Tsunami, or Flood warnings are issued for this date.`,
                    }
                ];
                for (const m of marketVariants) {
                    await dbRun(
                        `INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status) 
                         VALUES (?, ?, ?, ?, ?, 'image', 'weather', ?, 'YES', 'NO', ?, 'open')
                         ON CONFLICT(id) DO UPDATE SET 
                            title=excluded.title, 
                            description=excluded.description, 
                            content=excluded.content, 
                            media_url=excluded.media_url, 
                            timestamp=CURRENT_TIMESTAMP`,
                        [
                            m.id, 
                            m.title, 
                            m.desc, 
                            m.desc, 
                            forecast.icon, 
                            town.name.toLowerCase(), 
                            forecast.date
                        ]
                    );
                }
            } catch (e) {
                console.warn(`Weather sync failed for ${town.name}:`, e.message);
            }
        }

        // After syncing, push markets to connected clients
        emitMarkets();
        return { success: true };
    };
const normalizeStatus = (status) => {
    if (!status) return "upcoming";

    const s = status.toUpperCase();

    if (["1H", "2H", "HT", "ET", "P", "LIVE"].includes(s)) {
        return "live";
    }

    if (["FT", "AET", "PEN"].includes(s)) {
        return "closed";
    }
    
    if (["CANCL", "PSTP", "ABD", "SUSP", "INT"].includes(s)) {
        return "suspended";
    }

    return "upcoming";
};

const computeMarketStatus = (startTime, apiStatusShort = null) => {
    const now = Date.now();
    
    const start = new Date(startTime).getTime();

    if (apiStatusShort) {
        const normalized = normalizeStatus(apiStatusShort);
        if (normalized !== "upcoming") return normalized;
    }

    if (start <= now) return "live";
    
    return "upcoming";
};
const cleanupOutdatedMarkets = async () => {
    const today = formatNairobiDate();
    const now = new Date().toISOString();

    // 1. Only purge markets that are already settled/cancelled and old.
    // Deleting "closed" markets breaks settlement because bets still reference them.
    await dbRun(`DELETE FROM markets WHERE settled = 1 AND timestamp < datetime('now', '-7 days')`);
    await dbRun(`DELETE FROM markets WHERE status IN ('cancelled') AND timestamp < datetime('now', '-7 days')`);
    
    // 2. Remove football matches that started before today (only once settled/cancelled)
    await dbRun(
        `DELETE FROM markets 
         WHERE category='football' 
         AND settled = 1
         AND date(startTime) < date(?)`,
        [today]
    );

    // 3. Do not delete expired crypto/weather/news markets here.
    // They must remain until settled; expiry is handled by status updates + settlement engine.

    // 4. Remove redundant markets with no startTime that are old (orphaned)
    await dbRun(`DELETE FROM markets WHERE startTime IS NULL AND timestamp < datetime('now', '-1 day')`);
    
    console.log("Ã°Å¸Â§Â¹ Database cleanup complete: Redundant markets cleared.");
};

// Helper to ensure all active markets have a closure time
const fixMissingMarketTimes = async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await dbRun(`UPDATE markets SET startTime = ? WHERE startTime IS NULL AND status IN ('open', 'upcoming', 'live')`, [tomorrow]);
};

const recalculateOdds = async (marketId) => {
    try {
        const market = await dbGet(
            `SELECT home_volume, away_volume FROM markets WHERE id=?`,
            [marketId]
        );

        if (!market) return;

        const total = market.home_volume + market.away_volume;

        // Avoid division by zero
        if (total === 0) return;

        // Simple probability-based odds
        const minLiquidity = 100;

let oddsA = (total + minLiquidity) / ((market.home_volume || 1) + minLiquidity);
let oddsB = (total + minLiquidity) / ((market.away_volume || 1) + minLiquidity);
        // Add house margin (important for profit)
        const margin = 1.05;
        oddsA = Number((oddsA * margin).toFixed(2));
        oddsB = Number((oddsB * margin).toFixed(2));

        await dbRun(
            `UPDATE markets SET oddsA=?, oddsB=? WHERE id=?`,
            [oddsA, oddsB, marketId]
        );

    } catch (e) {
        console.error("Odds calc error:", e.message);
    }
};
// --- SETTLEMENT ENGINE ---
const cancelMarket = async (marketId, reason = 'CANCELLED') => {
    console.log(`Ã°Å¸â€ºâ€˜ Cancelling market ${marketId} Ã¢â€ â€™ ${reason}`);
    try {
        const market = await dbGet(`SELECT settled FROM markets WHERE id=?`, [marketId]);
        if (!market) return { success: false, message: "Market not found" };
        if (market?.settled) return { success: true, alreadySettled: true };

        const bets = await dbAll(`
            SELECT * FROM bets
            WHERE market_id = ?
            AND status = 'active'
        `, [marketId]);

        await withTransaction(async () => {
        for (const bet of bets) {
            const refund = Number(Number(bet.amount || 0).toFixed(2));
            if (refund > 0) {
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, bet.user_phone]);
            }
            await dbRun(
                `UPDATE transactions
                 SET status='cancelled', settled_amount=?
                 WHERE type='bet'
                 AND status IN ('active','pending','open')
                 AND (
                    bet_id=?
                    OR id=?
                    OR (bet_id IS NULL AND market_id=? AND user_phone=? AND side=?)
                 )`,
                [refund, bet.id, bet.transaction_id || -1, marketId, bet.user_phone, bet.picked]
            );
            await dbRun(
                `UPDATE bets SET status='cancelled' WHERE id=? AND status='active'`,
                [bet.id]
            );
            emitBalance(bet.user_phone);
        }

        await dbRun(
            `UPDATE markets SET status='cancelled', result=?, settled=1 WHERE id=?`,
            [String(reason || 'CANCELLED').toUpperCase(), marketId]
        );
        });

        emitMarkets();
        console.log(`Ã¢Å“â€¦ Market ${marketId} cancelled/refunded`);
        return { success: true, cancelledBets: bets.length };
    } catch (e) {
        console.error("Ã¢ÂÅ’ Market cancel failed:", e.message);
    }
};

function normalizeSettlementSide(value) {
    return String(value || '').trim().toUpperCase();
}

function isWinningBetSide(betSide, winningSide, market = {}) {
    const bet = normalizeSettlementSide(betSide);
    const winner = normalizeSettlementSide(winningSide);
    const sideA = normalizeSettlementSide(market.sideA || 'YES');
    const sideB = normalizeSettlementSide(market.sideB || 'NO');

    if (!bet || !winner) return false;

    if (bet === winner) return true;

    const winnerIsA = winner === sideA || winner === 'HOME' || winner === 'YES';
    const winnerIsB = winner === sideB || winner === 'AWAY' || winner === 'NO';
    const betIsA = bet === sideA || bet === 'HOME' || bet === 'YES';
    const betIsB = bet === sideB || bet === 'AWAY' || bet === 'NO';

    return (winnerIsA && betIsA) || (winnerIsB && betIsB);
}

const settleMarket = async (marketId, winningSide) => {
    console.log(`Ã¢Å¡â€“Ã¯Â¸Â Settling market ${marketId} Ã¢â€ â€™ ${winningSide}`);

    try {
        // Ã¢Å“â€¦ CHECK FIRST
        const market = await dbGet(
            `SELECT settled, sideA, sideB FROM markets WHERE id=?`,
            [marketId]
        );

        if (!market) {
            console.warn(`Market ${marketId} not found for settlement.`);
            return { success: false, message: "Market not found" };
        }

        if (market?.settled) {
            console.log("Ã¢Å¡Â Ã¯Â¸Â Market already settled.");
            return { success: true, alreadySettled: true };
        }

        if (normalizeSettlementSide(winningSide) === 'DRAW') {
            await cancelMarket(marketId, 'DRAW');
            return { success: true, cancelled: true };
        }

        // 1. Get bets
        const bets = await dbAll(`
            SELECT * FROM bets
            WHERE market_id = ?
            AND status = 'active'
        `, [marketId]);

        if (!bets.length) {
            console.log("Ã¢Å¡Â Ã¯Â¸Â No active bets found.");
            await dbRun(
                `UPDATE markets SET status='settled', result=?, settled=1 WHERE id=?`,
                [normalizeSettlementSide(winningSide), marketId]
            );
            emitMarkets();
            return { success: true, settledBets: 0 };
        }

        let totalPayout = 0;
        let totalStake = 0;
        const winnersToNotify = [];

        await withTransaction(async () => {
        for (const bet of bets) {
            totalStake += Number(bet.amount || 0);

            const isWinner = isWinningBetSide(bet.picked, winningSide, market);

            if (isWinner) {
                const payout = Number((Number(bet.amount || 0) * Number(bet.odds || 1)).toFixed(2));
                totalPayout += payout;

                winnersToNotify.push({
                    user_phone: bet.user_phone,
                    event: bet.event,
                    payout: payout
                });

                await dbRun(
                    `UPDATE users SET balance = balance + ? WHERE phone = ?`,
                    [payout, bet.user_phone]
                );

                await dbRun(
                    `UPDATE transactions
                     SET status='won', settled_amount=?
                     WHERE type='bet'
                     AND status IN ('active','pending','open')
                     AND (
                        bet_id=?
                        OR id=?
                        OR (bet_id IS NULL AND market_id=? AND user_phone=? AND side=?)
                     )`,
                    [payout, bet.id, bet.transaction_id || -1, marketId, bet.user_phone, bet.picked]
                );

                await dbRun(
                    `UPDATE bets SET status='won' WHERE id=? AND status='active'`,
                    [bet.id]
                );

                emitBalance(bet.user_phone);
                io.to(normalizePhone(bet.user_phone)).emit('winningPayout', {
                    title: 'Prediction won',
                    message: `Congratulations! sKES ${payout} has been credited to your account.`,
                    payout,
                    marketId,
                    event: bet.event
                });

            } else {
                await dbRun(
                    `UPDATE transactions
                     SET status='lost', settled_amount=0
                     WHERE type='bet'
                     AND status IN ('active','pending','open')
                     AND (
                        bet_id=?
                        OR id=?
                        OR (bet_id IS NULL AND market_id=? AND user_phone=? AND side=?)
                     )`,
                    [bet.id, bet.transaction_id || -1, marketId, bet.user_phone, bet.picked]
                );

                await dbRun(
                    `UPDATE bets SET status='lost' WHERE id=? AND status='active'`,
                    [bet.id]
                );
            }
        }

        console.log(`Ã°Å¸â€œÅ  Market P&L Ã¢â€ â€™ Stake: ${totalStake}, Paid: ${totalPayout}, Profit: ${totalStake - totalPayout}`);

        await dbRun(`
            UPDATE markets 
            SET status='settled', result=?, settled=1 
            WHERE id=?
        `, [normalizeSettlementSide(winningSide), marketId]);
        });

        console.log(`Ã¢Å“â€¦ Market ${marketId} fully settled`);

        emitMarkets();

        // Send notifications asynchronously after transaction commits successfully
        for (const w of winnersToNotify) {
            (async () => {
                try {
                    // 1. App Notification
                    await createNotification(
                        w.user_phone,
                        "Prediction Won! Ã°Å¸Å½â€°",
                        `Congratulations! Your prediction on "${w.event}" won sKES ${w.payout}.`,
                        'win'
                    );

                    // 2. Fetch User Email & Send Email
                    const user = await dbGet(`SELECT email FROM users WHERE phone=?`, [w.user_phone]);
                    if (user && user.email) {
                        const emailSubject = `Prediction Won!`;
                        const emailHtml = `
                            <h2>Congratulations!</h2>
                            <p>Your prediction on <strong>${w.event}</strong> was correct!</p>
                            <p>Payout of <strong>sKES ${w.payout}</strong> has been credited to your Soko Wallet.</p>
                            <p>Soko ni Soko.</p>
                        `;
                        await sendPolyMail(user.email, emailSubject, emailHtml);
                    }

                    // 3. Send SMS
                    const formattedPhone = formatPhone(w.user_phone);
                    if (formattedPhone) {
                        const smsMessage = `PolySoko: Prediction Won! You won sKES ${w.payout} on "${w.event}". Winnings have been credited to your Soko Wallet. Soko ni Soko.`;
                        await sendSms({
                            to: [formattedPhone],
                            message: smsMessage
                        });
                        console.log(`Ã¢Å“â€¦ Win SMS Sent to ${w.user_phone}`);
                    }
                } catch (err) {
                    console.error(`Ã¢ÂÅ’ Notification failed for ${w.user_phone}:`, err.message || err);
                }
            })();
        }

        return { success: true, settledBets: bets.length, totalStake, totalPayout };

    } catch (e) {
        console.error("Ã¢ÂÅ’ Settlement failed:", e.message);
        throw e;
    }
};

const cancelBetById = async (betId, reason = 'ADMIN_CANCELLED') => {
    const bet = await dbGet(`SELECT * FROM bets WHERE id=?`, [betId]);
    if (!bet) throw new Error("Bet not found");
    if (bet.status !== 'active') return { success: true, alreadySettled: true };

    const refund = Number(Number(bet.amount || 0).toFixed(2));
    return withTransaction(async () => {
        if (refund > 0) {
            await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, bet.user_phone]);
        }
        await dbRun(`UPDATE bets SET status='cancelled' WHERE id=? AND status='active'`, [bet.id]);
        await dbRun(
            `UPDATE transactions
             SET status='cancelled', settled_amount=?
             WHERE type='bet'
             AND status IN ('active','pending','open')
             AND (
                bet_id=?
                OR id=?
                OR (bet_id IS NULL AND market_id=? AND user_phone=? AND side=?)
             )`,
            [refund, bet.id, bet.transaction_id || -1, bet.market_id, bet.user_phone, bet.picked]
        );
    }).then(() => {
        emitBalance(bet.user_phone);
        return { success: true, cancelledBets: 1, refunded: refund, reason };
    });
};

const settleBetById = async (betId, winningSide) => {
    const bet = await dbGet(`SELECT * FROM bets WHERE id=?`, [betId]);
    if (!bet) throw new Error("Bet not found");
    if (bet.status !== 'active') return { success: true, alreadySettled: true };

    const market = await dbGet(`SELECT sideA, sideB FROM markets WHERE id=?`, [bet.market_id]) || {};
    const outcome = normalizeSettlementSide(winningSide);
    if (!outcome) throw new Error("Missing settlement result");
    if (outcome === 'DRAW' || outcome === 'CANCEL' || outcome === 'CANCELLED') {
        return cancelBetById(betId, outcome);
    }

    const isWinner = isWinningBetSide(bet.picked, outcome, market);
    const payout = isWinner ? Number((Number(bet.amount || 0) * Number(bet.odds || 1)).toFixed(2)) : 0;
    const nextStatus = isWinner ? 'won' : 'lost';

    await withTransaction(async () => {
        if (payout > 0) {
            await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [payout, bet.user_phone]);
        }
        await dbRun(`UPDATE bets SET status=? WHERE id=? AND status='active'`, [nextStatus, bet.id]);
        await dbRun(
            `UPDATE transactions
             SET status=?, settled_amount=?
             WHERE type='bet'
             AND status IN ('active','pending','open')
             AND (
                bet_id=?
                OR id=?
                OR (bet_id IS NULL AND market_id=? AND user_phone=? AND side=?)
             )`,
            [nextStatus, payout, bet.id, bet.transaction_id || -1, bet.market_id, bet.user_phone, bet.picked]
        );
        await dbRun(`UPDATE markets SET result=COALESCE(NULLIF(result, ''), ?), status='settled', settled=1 WHERE id=?`, [outcome, bet.market_id]);
    });

    try {
        emitBalance(bet.user_phone);
        if (isWinner && payout > 0) {
            io.to(normalizePhone(bet.user_phone)).emit('winningPayout', {
                title: 'Prediction won',
                message: `Congratulations! sKES ${payout} has been credited to your account.`,
                payout,
                marketId: bet.market_id,
                event: bet.event
            });
        }
        emitMarkets();

        if (isWinner && payout > 0) {
            (async () => {
                try {
                    // 1. App Notification
                    await createNotification(
                        bet.user_phone,
                        "Prediction Won! Ã°Å¸Å½â€°",
                        `Congratulations! Your prediction on "${bet.event}" won sKES ${payout}.`,
                        'win'
                    );

                    // 2. Fetch User Email & Send Email
                    const user = await dbGet(`SELECT email FROM users WHERE phone=?`, [bet.user_phone]);
                    if (user && user.email) {
                        const emailSubject = `Prediction Won!`;
                        const emailHtml = `
                            <h2>Congratulations!</h2>
                            <p>Your prediction on <strong>${bet.event}</strong> was correct!</p>
                            <p>Payout of <strong>sKES ${payout}</strong> has been credited to your Soko Wallet.</p>
                            <p>Soko ni Soko.</p>
                        `;
                        await sendPolyMail(user.email, emailSubject, emailHtml);
                    }

                    // 3. Send SMS
                    const formattedPhone = formatPhone(bet.user_phone);
                    if (formattedPhone) {
                        const smsMessage = `PolySoko: Prediction Won! You won sKES ${payout} on "${bet.event}". Winnings have been credited to your Soko Wallet. Soko ni Soko.`;
                        await sendSms({
                            to: [formattedPhone],
                            message: smsMessage
                        });
                        console.log(`Ã¢Å“â€¦ Win SMS Sent to ${bet.user_phone}`);
                    }
                } catch (err) {
                    console.error(`Ã¢ÂÅ’ Notification failed for ${bet.user_phone}:`, err.message || err);
                }
            })();
        }

        return { success: true, settledBets: 1, status: nextStatus, payout };
    } catch (e) {
        throw e;
    }
};
const settleWeatherMarkets = async () => {
    const markets = await dbAll(`
        SELECT * FROM markets 
        WHERE category='weather' 
        AND settled=0
        AND startTime IS NOT NULL
    `);

    for (const m of markets) {
        try {
            const town = m.country;
            const date = new Date(m.startTime).toISOString().split('T')[0];

            const res = await axios.get(
                `http://api.weatherapi.com/v1/history.json`,
                {
                    params: { key: process.env.WEATHER_API_KEY, q: town, dt: date }
                }
            );

            const day = res.data?.forecast?.forecastday?.[0]?.day;
            if (!day) continue;

            let result = 'NO';
            if (m.id.endsWith('_rain')) {
                result = day.daily_will_it_rain ? 'YES' : 'NO';
            } else if (m.id.endsWith('_temp')) {
                result = day.maxtemp_c >= 35 ? 'YES' : 'NO';
            } else if (m.id.endsWith('_wind')) {
                result = day.maxwind_kph >= 50 ? 'YES' : 'NO';
            } else if (m.id.endsWith('_alert')) {
                // For history, alerts are harder to retroactively get from WeatherAPI Basic.
                // Fallback: If wind > 80 or rain > 90% or precip > 20mm, it's a severe event.
                result = (day.maxwind_kph > 80 || day.totalprecip_mm > 20) ? 'YES' : 'NO';
            }

            await settleMarket(m.id, result);

        } catch (e) {
            console.error("Ã°Å¸Å’Â§Ã¯Â¸Â Weather settlement error:", e.message);
        }
    }
};
const closeExpiredMarkets = async () => {
    try {
        const now = Date.now();

        const markets = await dbAll(
            `SELECT * FROM markets 
             WHERE status IN ('upcoming', 'live', 'open') AND startTime IS NOT NULL`
        );

        for (const m of markets) {
            const start = new Date(m.startTime).getTime();
            const isExpiredUpcoming = (m.status === "upcoming" || m.status === "open") && start <= now;
            const isStaleLive = m.status === "live" && start + (3 * 60 * 60 * 1000) <= now;

            if (isExpiredUpcoming || isStaleLive) {
                await dbRun(
                    `UPDATE markets SET status='closed' WHERE id=?`,
                    [m.id]
                );

                console.log(`Ã¢â€ºâ€ Market closed: ${m.id}`);
            }
        }

        emitMarkets();

    } catch (e) {
        console.error("Close market error:", e.message);
    }
};
const refreshBoostedMarkets = async () => {
    try {
        const candidates = await dbAll(`
            SELECT id, home_volume, away_volume, status
            FROM markets
            WHERE status IN ('open','upcoming','live') AND settled = 0
        `, []);

        if (!candidates || candidates.length === 0) {
            return;
        }

        const selectedIds = candidates
            .map(m => ({
                id: m.id,
                volume: Number(m.home_volume || 0) + Number(m.away_volume || 0)
            }))
            .sort((a, b) => b.volume - a.volume || Math.random() - 0.5)
            .slice(0, 10)
            .map(m => m.id);

        await withTransaction(async () => {
            await dbRun(`UPDATE markets SET is_boosted = 0 WHERE is_boosted = 1`);
            for (const id of selectedIds) {
                await dbRun(`UPDATE markets SET is_boosted = 1 WHERE id = ?`, [id]);
            }
        });

        if (selectedIds.length) {
            console.log(`Ã°Å¸Å¸Â© Refreshed boosted markets: ${selectedIds.join(', ')}`);
            emitMarkets();
        }
    } catch (e) {
        console.error("Ã¢ÂÅ’ Boosted markets refresh failed:", e.message);
    }
};

const settleResolvedMarkets = async () => {
    try {
        const toSettle = await dbAll(`
            SELECT id, result
            FROM markets
            WHERE settled = 0 AND result IS NOT NULL AND TRIM(result) != ''
        `, []);

        for (const market of toSettle) {
            await settleMarket(market.id, market.result);
        }
    } catch (e) {
        console.error("Ã¢ÂÅ’ Resolved market settlement failed:", e.message);
    }
};

const sendDailyMarkets = () => {
    db.all(`SELECT email FROM users WHERE terms_accepted=1`, [], (err, users) => {
        db.all(`SELECT title, oddsA, oddsB FROM markets WHERE status='upcoming' LIMIT 5`, [], (err, markets) => {
            if (!markets || markets.length === 0) return;
            const marketList = markets.map(m => `${m.title} (Yes: ${m.oddsA} | No: ${m.oddsB})`).join('\n');
            users.forEach(u => {
                sendPolyMail(u.email, "Today's Hot Markets Ã°Å¸â€Â¥", `Check out these live odds:\n\n${marketList}`);
            });
        });
    });
};
// --- AUTH MIDDLEWARE ---

// --- SYNC LOGIC ---
// Dedicated football news sync - fetches football-specific news from APIs
const syncFootballNews = async () => {
    const apiKey = process.env.NEWS_API_KEY;
    if (!apiKey) return;

    try {
        const footballQueries = [
            'FIFA World Cup favorites likely win prediction',
            'World Cup football odds favorites winner',
            'premier league football',
            'champions league football',
            'football transfer news',
            'football injuries team news',
            'football match preview prediction'
        ];

        const requests = footballQueries.map(q =>
            axios.get('https://newsapi.org/v2/everything', {
                params: { q, language: 'en', sortBy: 'publishedAt', pageSize: 8, apiKey }
            }).catch(() => ({ data: { articles: [] } }))
        );

        const responses = await Promise.all(requests);
        const articles = responses.flatMap(r => r.data?.articles || []);
        const seen = new Set();

        const existing = await dbAll(`SELECT id FROM markets WHERE category='football' AND id LIKE 'news_football_%'`, []);
        existing.forEach(m => seen.add(m.id));

        let saved = 0;
        for (const article of articles) {
            const market = normalizeNewsArticle(article);
            if (!market || market.category !== 'football' || seen.has(market.id)) continue;
            seen.add(market.id);
            await saveNewsMarket(market);
            saved++;
            if (saved >= 40) break;
        }

        if (saved > 0) {
            console.log(`Ã¢Å¡Â½ Football news sync: saved ${saved} new markets`);
            emitMarkets();
        }
    } catch (e) {
        console.error('Football news sync error:', e.message);
    }
};

// Stablecoins, wrapped/derivative assets and tokenised credit products make for
// dull "will it close higher today?" questions (they are pegged or illiquid), so
// they are skipped in favour of tradeable coins such as BNB, BTC and ETH.
const NON_PREDICTABLE_COINS = new Set([
    'tether', 'usd-coin', 'dai', 'usds', 'fdusd', 'usde', 'pyusd', 'tusd', 'usdtb',
    'ethena', 'first-digital-usd', 'ondo-us-yield', 'mountain-protocol',
    'wrapped-bitcoin', 'wrapped-ether', 'weth', 'steth', 'wsteth', 'wbtc', 'cbbtc',
    'bsc', 'binance-staked-sol', 'staked-ether', 'blackrock', 'circle',
    'figure-heloc'
]);

const syncAllMarkets = async () => {
    console.log(`[${new Date().toLocaleTimeString()}] Ã°Å¸â€â€ž STARTING GLOBAL SYNC...`);
    // --- 2. CRYPTO MARKETS (Using CoinGecko + AI Enhancements) ---
    try {
        // Widen the slice (previously top-10) so the crypto tab and the guest
        // preview have plenty of markets to display.
        const cryptoRes = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=false&price_change_percentage=24h');

        // BNB sits comfortably inside the top-25 by market cap so it is always
        // synced; dropping pegged assets frees the remaining slots for real coins.
        const coins = (cryptoRes.data || []).filter((coin) => coin?.id && !NON_PREDICTABLE_COINS.has(String(coin.id).toLowerCase()));

        const marketDate = formatNairobiDate();
        const expiryTime = new Date(new Date().setHours(23, 59, 59, 999)).toISOString();

        for (const coin of coins) {
            const marketId = `crypto_${coin.id}_${marketDate}`;            
            
            // Fallback values
            let title = `Can ${coin.name} hit $${(coin.current_price * 1.02).toFixed(2)} today?`;
            let description = `${coin.name} is trading at $${coin.current_price?.toLocaleString()}. 24h change: ${Number(coin.price_change_percentage_24h || 0).toFixed(2)}%.`;

            // Try AI title generation
            try {
                const aiPrompt = `Generate a catchy prediction market question for ${coin.name} (Current Price: $${coin.current_price}, 24h Change: ${coin.price_change_percentage_24h}%). Keep it under 10 words. Format as a question.`;
                const aiRes = await callAI({ engine: 'gemini', promptText: aiPrompt, suppressErrors: true });
                if (aiRes?.text) title = polishMarketTitle(aiRes.text.replace(/"/g, '').trim());
            } catch (aiErr) {
                console.warn(`Crypto title fallback for ${coin.id}:`, aiErr.message);
            }

            await dbRun(
                `INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url)
                 VALUES (?, ?, ?, ?, ?, 'image', 'crypto', 'Global', 'YES', 'NO', ?, 'open', ?)
                 ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    description=excluded.description,
                    content=excluded.content,
                    media_url=excluded.media_url,
                    media_type=excluded.media_type,
                    category=excluded.category,
                    country=excluded.country,
                    sideA=excluded.sideA,
                    sideB=excluded.sideB,
                    startTime=excluded.startTime,
                    status=excluded.status,
                    url=excluded.url,
                    timestamp=CURRENT_TIMESTAMP`,
                [
                    marketId,
                    title,
                    description,
                    description,
                    coin.image || '',
                    expiryTime,
                    `https://www.coingecko.com/en/coins/${coin.id}`
                ]
            );
        }

        emitMarkets();
    } catch (e) {
        console.error("Crypto market sync failed:", e.message);
    }
};

app.get('/api/markets/preview', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT * FROM markets
             WHERE status IN ('open', 'upcoming', 'live')
               AND NOT (
                    (category='sports' OR category='football' OR id LIKE 'sp_%' OR id LIKE 'fb_%')
                    AND (
                        title IN ('Home vs Away', 'Unknown vs Unknown')
                        OR sideA IN ('Home', 'Away', 'Unknown', '')
                        OR sideB IN ('Home', 'Away', 'Unknown', '')
                        OR sideA IS NULL
                        OR sideB IS NULL
                    )
               )
             ORDER BY
                CASE WHEN status='live' THEN 0 ELSE 1 END,
                COALESCE(is_boosted, 0) DESC,
                COALESCE(home_volume, 0) + COALESCE(away_volume, 0) DESC,
                startTime ASC,
                title ASC`,
            []
        );

        // Serve a few markets per category instead of a single one, so guests see
        // a full, scrollable preview rather than one lonely card per section.
        const wanted = ['sports', 'crypto', 'news', 'weather', 'politics', 'tech', 'football'];
        const perCategoryLimit = 3;
        const byCategory = new Map(wanted.map((category) => [category, []]));

        for (const market of rows || []) {
            // fb_* fixtures and sp_* matches go to 'sports' category
            // Football NEWS markets (category='football') stay as 'football'
            const category = (market.id?.startsWith('fb_') || market.id?.startsWith('sp_')) && market.category === 'sports'
                ? 'sports'
                : String(market.category || 'other').toLowerCase();
            if (!byCategory.has(category)) continue;
            const bucket = byCategory.get(category);
            if (bucket.length >= perCategoryLimit) continue;
            bucket.push({ ...market, category });
        }

        const markets = wanted.flatMap((category) => byCategory.get(category));
        res.json({ success: true, markets });
    } catch (e) {
        console.error("Preview markets failed:", e.message);
        res.status(500).json({ success: false, message: "Unable to load preview markets" });
    }
});

app.get('/api/markets', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT *
             FROM markets
             WHERE status IN ('open', 'upcoming', 'live')
               AND NOT (
                    (category='sports' OR category='football' OR id LIKE 'sp_%' OR id LIKE 'fb_%')
                    AND (
                        title IN ('Home vs Away', 'Unknown vs Unknown')
                        OR sideA IN ('Home', 'Away', 'Unknown', '')
                        OR sideB IN ('Home', 'Away', 'Unknown', '')
                        OR sideA IS NULL
                        OR sideB IS NULL
                    )
               )
             ORDER BY
                CASE WHEN status='live' THEN 0 ELSE 1 END,
                COALESCE(is_boosted, 0) DESC,
                COALESCE(home_volume, 0) + COALESCE(away_volume, 0) DESC,
                startTime ASC,
                title ASC`,
            []
        );

        const markets = (rows || []).map((market) => {
            const category = String(market.category || '').toLowerCase();
            const generatedNews = /^(news_|tech_|geo_)/i.test(String(market.id || '')) ||
                ['news', 'politics', 'tech'].includes(category);
            return generatedNews ? buildNewsMarket(market) : market;
        });

        res.json({ success: true, markets });
    } catch (e) {
        console.error("Markets load failed:", e.message);
        res.status(500).json({ success: false, message: "Unable to load markets" });
    }
});

app.get('/api/markets/:id/order-book', authenticate, async (req, res) => {
    const marketId = String(req.params.id || '').trim();
    if (!marketId) return res.status(400).json({ success: false, message: "Missing market ID" });

    try {
        const market = await dbGet(
            `SELECT id, title, sideA, sideB, oddsA, oddsB, home_volume, away_volume
             FROM markets
             WHERE id=?`,
            [marketId]
        );
        if (!market) return res.status(404).json({ success: false, message: "Market not found" });

        const rows = await dbAll(
            `SELECT picked AS side, odds, COUNT(*) AS orders, SUM(amount) AS volume
             FROM bets
             WHERE market_id=? AND status='active'
             GROUP BY picked, odds
             ORDER BY odds DESC`,
            [marketId]
        );

        const normalizeSide = (value) => {
            const side = normalizeSettlementSide(value);
            if (side === normalizeSettlementSide(market.sideA || 'YES') || side === 'YES' || side === 'HOME') return 'YES';
            if (side === normalizeSettlementSide(market.sideB || 'NO') || side === 'NO' || side === 'AWAY') return 'NO';
            return side || 'OTHER';
        };
        const emptyBook = () => ({ orders: 0, volume: 0, levels: [] });
        const orderBook = { yes: emptyBook(), no: emptyBook() };

        for (const row of rows || []) {
            const key = normalizeSide(row.side) === 'YES' ? 'yes' : normalizeSide(row.side) === 'NO' ? 'no' : null;
            if (!key) continue;
            const volume = Number(row.volume || 0);
            const orders = Number(row.orders || 0);
            orderBook[key].orders += orders;
            orderBook[key].volume += volume;
            orderBook[key].levels.push({
                odds: Number(row.odds || 0),
                orders,
                volume: Number(volume.toFixed(2))
            });
        }

        res.json({
            success: true,
            market: {
                id: market.id,
                title: market.title,
                sideA: market.sideA || 'YES',
                sideB: market.sideB || 'NO',
                oddsA: Number(market.oddsA || 1.9),
                oddsB: Number(market.oddsB || 1.9),
                homeVolume: Number(market.home_volume || 0),
                awayVolume: Number(market.away_volume || 0)
            },
            orderBook
        });
    } catch (e) {
        console.error("Order book failed:", e.message);
        res.status(500).json({ success: false, message: "Unable to load order book" });
    }
});

app.get('/api/sports/categories', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT
                CASE
                    WHEN id LIKE 'fb_%' THEN 'Football'
                    ELSE COALESCE(sport, 'Other')
                END AS sport,
                COUNT(*) AS count
             FROM markets
             WHERE ((category='sports') OR id LIKE 'sp_%' OR id LIKE 'fb_%')
               AND status IN ('open', 'upcoming', 'live')
               AND title NOT IN ('Home vs Away', 'Unknown vs Unknown')
               AND sideA NOT IN ('Home', 'Away', 'Unknown', '')
               AND sideB NOT IN ('Home', 'Away', 'Unknown', '')
               AND sideA IS NOT NULL
               AND sideB IS NOT NULL
             GROUP BY
                CASE
                    WHEN id LIKE 'fb_%' THEN 'Football'
                    ELSE COALESCE(sport, 'Other')
                END
             ORDER BY sport ASC`,
            []
        );
        const counts = new Map((rows || []).map(row => [String(row.sport || "Other"), Number(row.count || 0)]));
        const sports = [...counts.entries()]
            .filter(([, count]) => count > 0)
            .map(([sport, count]) => ({ sport, count }))
            .sort((a, b) => a.sport.localeCompare(b.sport));
        res.json({ success: true, sports });
    } catch (e) {
        res.status(500).json({ success: false, message: "Unable to load sports categories" });
    }
});

app.post('/api/admin/sync-sports', authenticateAdmin, async (req, res) => {
    try {
        const syncResult = await syncSportsMarkets();
        const categories = await dbAll(`
            SELECT
                CASE
                    WHEN id LIKE 'fb_%' THEN 'Football'
                    ELSE COALESCE(sport, 'Other')
                END AS sport,
                COUNT(*) AS count
            FROM markets
            WHERE ((category='sports') OR id LIKE 'sp_%' OR id LIKE 'fb_%')
              AND status IN ('open','upcoming','live')
            GROUP BY
                CASE
                    WHEN id LIKE 'fb_%' THEN 'Football'
                    ELSE COALESCE(sport, 'Other')
                END
            ORDER BY sport ASC
        `, []);
        res.json({
            success: true,
            synced: Number(syncResult?.synced || 0),
            days: Number(syncResult?.days || SPORTS_SYNC_DAYS),
            sourceCounts: syncResult?.sourceCounts || {},
            sports: categories || []
        });
    } catch (e) {
        res.status(500).json({ success: false, message: "Sports sync failed" });
    }
});
app.get('/api/user/context', async (req, res) => {
    const fallbackTowns = {
        mombasa: { city: "Mombasa", country: "Kenya", lat: -4.0435, lon: 39.6682 },
        nairobi: { city: "Nairobi", country: "Kenya", lat: -1.2864, lon: 36.8172 },
        kisumu: { city: "Kisumu", country: "Kenya", lat: -0.0917, lon: 34.7680 },
        nakuru: { city: "Nakuru", country: "Kenya", lat: -0.3031, lon: 36.0800 },
        eldoret: { city: "Eldoret", country: "Kenya", lat: 0.5143, lon: 35.2698 }
    };
    const weatherCodeText = (code) => {
        const map = {
            0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Cloudy",
            45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
            61: "Light rain", 63: "Rain", 65: "Heavy rain", 80: "Rain showers",
            81: "Rain showers", 82: "Heavy rain showers", 95: "Thunderstorm"
        };
        return map[Number(code)] || "Current weather";
    };

    try {
        const { lat, lon } = req.query;
        let city = "";
        let country = "";
        let weatherQuery = "";
        let fallbackCoords = fallbackTowns.mombasa;

        if (lat && lon) {
            weatherQuery = `${lat},${lon}`;
            fallbackCoords = { city: "Mombasa", country: "Kenya", lat: Number(lat), lon: Number(lon) };
        } else {
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || "").split(",")[0].trim();
            const publicIp = ip === "::1" || ip === "127.0.0.1" ? "" : ip;
            const geo = await axios.get(`http://ip-api.com/json/${publicIp || ""}`);
            city = geo.data.city || "";
            country = geo.data.country || "";
            weatherQuery = city || "Mombasa";
            fallbackCoords = fallbackTowns[String(city).toLowerCase()] || fallbackTowns.mombasa;
        }

        let temp;
        let condition;
        try {
            const weather = await axios.get(
                `http://api.weatherapi.com/v1/current.json`,
                {
                    params: {
                        key: process.env.WEATHER_API_KEY,
                        q: weatherQuery
                    }
                }
            );

            temp = weather.data.current.temp_c;
            condition = weather.data.current.condition.text;
            city = weather.data.location?.name || city || fallbackCoords.city;
            country = weather.data.location?.country || country || fallbackCoords.country;
        } catch (weatherErr) {
            const meteo = await axios.get('https://api.open-meteo.com/v1/forecast', {
                params: {
                    latitude: fallbackCoords.lat,
                    longitude: fallbackCoords.lon,
                    current_weather: true,
                    timezone: 'Africa/Nairobi'
                }
            });
            temp = meteo.data?.current_weather?.temperature ?? "--";
            condition = weatherCodeText(meteo.data?.current_weather?.weathercode);
            city = city || fallbackCoords.city;
            country = country || fallbackCoords.country;
        }

        res.json({
            success: true,
            city,
            country,
            temp,
            condition
        });

    } catch (e) {
        console.error("Context error:", e.message);

        res.json({
            success: true,
            city: "Mombasa",
            country: "Kenya",
            temp: "--",
            condition: "Unavailable"
        });
    }
});
app.post('/api/register', authLimiter, async (req, res) => {
    const { name, phone, password, email, referralCode } = req.body;
    const normalized = normalizePhone(phone);
    const normalizedEmail = normalizeEmailAddress(email)?.toLowerCase();
    try {
        if (!name || !normalizedEmail || !normalized) {
            return res.status(400).json({ success: false, message: "Name, email, and phone are required." });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
        }
        if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
            return res.status(400).json({ success: false, message: "Password must include uppercase, lowercase, and a number." });
        }

        const existing = await dbGet(
            `SELECT phone, email FROM users WHERE phone = ? OR LOWER(email) = LOWER(?) LIMIT 1`,
            [normalized, normalizedEmail]
        );
        if (existing) {
            const samePhone = existing.phone === normalized;
            const sameEmail = String(existing.email || '').toLowerCase() === normalizedEmail;
            const message = samePhone && sameEmail
                ? "An account with this phone number and email already exists."
                : samePhone
                    ? "An account with this phone number already exists."
                    : "An account with this email already exists.";
            return res.status(409).json({ success: false, message });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const myReferralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const verificationToken = crypto.randomBytes(32).toString('hex');

        db.run(`INSERT INTO users (name, phone, password, email, referral_code, referred_by, verification_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified')`,
            [name, normalized, hashedPassword, normalizedEmail, myReferralCode, referralCode || null, verificationToken], async function(err) {
                if (err) {
                    console.error("Registration insert failed:", err.message || err);
                    const isUniqueFailure = err.code === '23505' || /unique|constraint|duplicate/i.test(err.message || '');
                    return res.status(isUniqueFailure ? 409 : 500).json({
                        success: false,
                        message: isUniqueFailure
                            ? "An account with this phone number or email already exists."
                            : "Registration failed. Please try again."
                    });
                }

                const verifyLink = `${verificationUrl(verificationToken)}`;
                const mailResult = await sendPolyMail(normalizedEmail, "PolySoko Account Access",
                    `<p>Hello ${name},</p>
                     <p>Please verify your PolySoko account to activate your referral benefits.</p>
                     <p><a href="${verifyLink}" style="display:inline-block;padding:12px 18px;background:#00ff88;color:#020405;text-decoration:none;border-radius:8px;font-weight:bold;">Verify Account</a></p>
                     <p>If the button does not open, paste this link into your browser:<br><span style="word-break:break-all;">${verifyLink}</span></p>`);
                if (!mailResult.success) {
                    return res.status(503).json({
                        success: false,
                        accountCreated: true,
                        message: mailFailureMessage(mailResult, "Account created, but the verification email could not be sent. Please try resending it shortly.")
                    });
                }

                if (referralCode) {
                    db.get(`SELECT phone, is_upgraded FROM users WHERE UPPER(referral_code) = UPPER(?)`, [referralCode], (err, referrer) => {
                        if (referrer && referrer.phone !== normalized) {
                            const bonus = referrer.is_upgraded === 1 ? 100 : 50;
                            db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [bonus, referrer.phone]);
                            db.run(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'referral_bonus', ?, 'completed', ?)`,
                                [referrer.phone, bonus, `REF_BONUS_${normalized}`], (err) => {
                                    if (!err) emitBalance(referrer.phone);
                                });
                        }
                    });
                }
                res.json({ success: true });
            }
        );
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/verify', (req, res) => {
    const { token } = req.query;
    db.get(`SELECT phone, name, email FROM users WHERE verification_token = ?`, [token], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: "Invalid or expired token" });

        db.run(`UPDATE users SET status = 'verified', verification_token = NULL WHERE verification_token = ?`, [token], async (err) => {
            if (err) return res.status(500).json({ success: false });

            const userName = user.name || 'there';
            const userEmail = user.email;

            if (userEmail) {
                sendPolyMail(userEmail, "Welcome to PolySoko - You're Verified!",
                    `<div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 500px; margin: auto;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <h1 style="color: #00ff88; margin: 0;">PolySoko</h1>
                            <p style="color: #888; font-size: 0.85rem;">Soko ni Soko!</p>
                        </div>
                        <h2 style="color: #222;">Welcome ${userName}!</h2>
                        <p>Your account has been verified and is now fully active.</p>
                        <a href="${publicSiteUrl()}" style="display: inline-block; padding: 14px 28px; background: #00ff88; color: #020405; text-decoration: none; border-radius: 10px; font-weight: bold; margin: 20px 0;">Start Trading Now</a>
                    </div>`);

                sendPolyMail(userEmail, "New Account Activated - Security Alert",
                    `<div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 500px; margin: auto;">
                        <h2 style="color: #00ff88;">Account Activated</h2>
                        <p>Hello ${userName},</p>
                        <p>Your PolySoko account has been activated via email verification.</p>
                    </div>`);
            }

            if (typeof global.addActivityLog === 'function') {
                global.addActivityLog(user.phone, 'email_verified', 'Account verified via email link', req.ip || '', req.headers['user-agent'] || '');
            }

            // Browser users clicking the emailed link should land on a real page, not raw
            // JSON. login.html already understands ?verified=1. API/XHR callers keep
            // receiving JSON based on the Accept header or ?format=json.
            const wantsJson = req.query.format === 'json'
                || req.headers.accept?.includes('application/json')
                || req.headers['sec-fetch-mode'] === 'cors';
            if (wantsJson) {
                return res.json({ success: true, message: "Account verified! Your referral code is now active." });
            }
            return res.redirect(302, `${PUBLIC_SITE_URL}/login.html?verified=1`);
        });
    });
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword, otp } = req.body;
    try {
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
        }
        if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
            return res.status(400).json({ success: false, message: "Password must include uppercase, lowercase, and a number." });
        }
        const reset = await dbGet(`SELECT phone FROM password_resets WHERE token = ? AND otp = ? AND expires > ?`, [token, otp, Date.now()]);
        if (!reset) return res.status(400).json({ success: false, message: "Link expired or invalid" });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun(`UPDATE users SET password = ? WHERE phone = ?`, [hashedPassword, reset.phone]);
        await dbRun(`DELETE FROM password_resets WHERE phone = ?`, [reset.phone]);

        const user = await dbGet(`SELECT email FROM users WHERE phone = ?`, [reset.phone]);
        if (user?.email) {
            sendPolyMail(user.email, "Security Notification: Password Changed",
                `<p>Hello, your PolySoko password was successfully reset. If you did not perform this action, please contact support immediately.</p>`);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/login', authLimiter, (req, res) => {
    const { phone, password } = req.body;
    const normalized = normalizePhone(phone);
    const ua = req.headers['user-agent'] || 'Unknown Device';

    if (!normalized || !password) {
        return res.status(400).json({ success: false, message: "Phone and password are required." });
    }

    db.get(`SELECT * FROM users WHERE phone=?`, [normalized], async (err, user) => {
        if (err) {
            console.error("Login lookup failed:", err.message || err);
            return res.status(500).json({ success: false, message: "Login failed because the database could not be reached." });
        }
        if (!user) {
            return res.status(404).json({
                success: false,
                message: `No account found for ${normalized}. Check the phone number or register again.`
            });
        }
        if (!user.password || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: "Incorrect password for this account." });
        }
        if (user.is_suspended) return res.json({ success: false, message: "This account has been suspended." });

        if (user.status !== 'verified') {
            return res.json({
                success: false,
                message: "Please verify your email address before logging in. Check your inbox (including spam) for the verification link we sent during registration.",
                needsVerification: true
            });
        }

        db.get(`SELECT id FROM user_devices WHERE user_phone=? AND ua_string=?`, [normalized, ua], async (err, device) => {
            if (!device) {
                await dbRun(`INSERT INTO user_devices (user_phone, ua_string) VALUES (?, ?)`, [normalized, ua]);

                let deviceType = "Desktop/Unknown";
                if (/iPhone/i.test(ua)) deviceType = "iPhone";
                else if (/Android/i.test(ua)) deviceType = "Android Device";
                else if (/iPad/i.test(ua)) deviceType = "iPad";

                if (user.email) {
                    sendPolyMail(user.email, "Security Alert: New Login Detected", `
                        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #333; border-radius: 12px; background: #0b0c10; color: white;">
                            <h2 style="color: #00ff88;">New Device Login</h2>
                            <p>Hello ${user.name}, your account was just accessed from a new device.</p>
                            <div style="background: #1a1b23; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <b>Device Type:</b> ${deviceType}<br>
                                <b>Time:</b> ${new Date().toLocaleString()}<br>
                                <b>User Agent:</b> <span style="font-size: 0.7rem; color: #777;">${ua}</span>
                            </div>
                            <p style="font-size: 0.8rem; color: #888;">If this wasn't you, please reset your password immediately in the app.</p>
                        </div>`);
                }
            }
        });

        // Sign only after the secret is resolved. Previously `jwt.sign` threw
        // inside this async db.get callback when the secret was empty, so the
        // response was never written and the browser hung on "Logging in...".
        jwtSecretReady.then(() => {
            let token;
            try {
                token = signJwt({ phone: normalized }, { expiresIn: '7d' });
            } catch (err) {
                console.error('Login token signing failed:', err.message);
                return res.status(503).json({ success: false, message: "Sign-in is temporarily unavailable. Please try again." });
            }
            res.json({ success: true, token });
        }).catch(() => res.status(503).json({ success: false, message: "Sign-in is temporarily unavailable. Please try again." }));
    });
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true, message: "Logged out successfully" });
});

function attachAvatarDisplayUrl(req, user) {
    if (!user) return user;
    const avatarPath = user.avatar_url || '/uploads/avatars/default.png';
    const avatarUrl = publicAssetUrl(req, avatarPath);
    // Cache-bust only legacy per-file disk paths. The new `/api/avatar/<phone>`
    // route has a stable URL, so versioning it would pin the browser to a stale
    // picture after the user replaces their image.
    const isDbBacked = /^\/api\/avatar\//.test(avatarPath);
    const version = avatarPath && !isDbBacked && !/default\.png$/i.test(avatarPath)
        ? String(path.basename(avatarPath)).replace(/\W+/g, '')
        : '';
    // `avatar_data` holds the raw image bytes. Never let it reach a client: it
    // would bloat every profile payload and is not needed by the frontend.
    const { avatar_data: _avatarData, ...safeUser } = user;
    return {
        ...safeUser,
        avatar_url: avatarPath,
        avatarUrl: version && avatarUrl ? `${avatarUrl}${avatarUrl.includes('?') ? '&' : '?'}v=${version}` : avatarUrl
    };
}

app.get('/api/profile', authenticate, (req, res) => {
    db.get(`SELECT name, phone, email, balance, referral_code, avatar_url, role, is_upgraded FROM users WHERE phone=?`, [req.user.phone], (err, user) => {
        if (err) return res.status(500).json({ success: false });
        if (!user) return res.status(404).json({ success: false, message: "User account not found for this session" });
        res.json({ success: true, user: attachAvatarDisplayUrl(req, user) });
    });
});

app.get('/api/user/me', authenticate, async (req, res) => {
    try {
        const user = await dbGet(
            `SELECT name, phone, balance, role, avatar_url, is_upgraded FROM users WHERE phone=?`,
            [req.user.phone]
        );
        if (!user) return res.status(404).json({ success: false });
        res.json({ success: true, user: attachAvatarDisplayUrl(req, user) });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/user/profile', authenticate, (req, res) => {
    db.get(`SELECT name, phone, email, balance, referral_code, avatar_url, role, is_upgraded FROM users WHERE phone=?`,
    [req.user.phone], (err, user) => {
        if (err || !user) return res.status(404).json({ success: false });
        res.json({ success: true, user: attachAvatarDisplayUrl(req, user) });
    });
});

app.post('/api/user/update', authenticate, (req, res) => {
    const { name, email } = req.body;
    db.run(
        `UPDATE users SET name = ?, email = ? WHERE phone = ?`,
        [name, email, req.user.phone],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: "Update failed" });
            res.json({ success: true });
        }
    );
});

app.post('/api/user/update-email', authenticate, (req, res) => {
    const { email } = req.body;
    db.run(
        `UPDATE users SET email = ? WHERE phone = ?`,
        [email, req.user.phone],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: "Email update failed" });
            res.json({ success: true });
        }
    );
});

app.post('/api/user/submit-market', authenticate, async (req, res) => {
    const { title, category, sideA, sideB, startTime, description, media_url, media_type } = req.body;
    try {
        const user = await dbGet(`SELECT is_upgraded, role, phone FROM users WHERE phone = ?`, [req.user.phone]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (!(user.is_upgraded === 1 || user.role === 'admin')) {
            return res.status(403).json({ success: false, message: 'Not authorized to create markets' });
        }

        const id = `user_${Date.now()}`;
        const isAutoOpen = (user.role === 'admin');
        const status = isAutoOpen ? 'open' : 'pending';

        await dbRun(`INSERT INTO markets (id, title, description, content, category, sideA, sideB, startTime, status, creator, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, title, description || '', description || '', category || 'misc', sideA || 'YES', sideB || 'NO', startTime || new Date().toISOString(), status, req.user.phone, media_url || null, media_type || 'auto']);

        if (isAutoOpen) {
            emitMarkets();
            try {
                const creator = await dbGet(`SELECT email, name FROM users WHERE phone=?`, [req.user.phone]);
                if (creator && creator.email) {
                    sendPolyMail(creator.email, `Your Market is LIVE: ${title}`, `<div style="font-family:sans-serif;padding:20px;color:#333;"><h2>Hi ${creator.name || ''},</h2><p>Your market "${title}" is now live on PolySoko. Good luck!</p></div>`);
                }
            } catch (e) { console.warn('Email send failed for auto-open market', e.message); }

            res.json({ success: true, message: 'Market created and is live' });
        } else {
            emitAdminEvent('newMarketPending', { id, title, creator: req.user.phone });
            res.json({ success: true, message: 'Market submitted for review' });
        }
    } catch (e) {
        console.error('Create market error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/admin/create-market', authenticateAdmin, async (req, res) => {
    const { title, category, sideA, sideB, startTime, description, media_url, media_type } = req.body;
    try {
        const id = `m_${Date.now()}`;
        await dbRun(
            `INSERT INTO markets (id, title, description, content, category, sideA, sideB, startTime, status, media_url, media_type, creator)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
            [id, title, description || '', description || '', category || 'misc', sideA || 'YES', sideB || 'NO', startTime || new Date().toISOString(), media_url || null, media_type || 'auto', req.user.phone]
        );
        emitMarkets();
        res.json({ success: true, message: 'Market created successfully' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/user/deposit-crypto', authenticate, async (req, res) => {
    const { amount, txhash } = req.body;
    try {
        if (!amount || !txhash) return res.status(400).json({ success: false, message: 'Missing amount or txhash' });
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, reference, status) VALUES (?, 'crypto', ?, ?, 'pending')`, [req.user.phone, amount, txhash]);
        emitAdminEvent('cryptoDepositPending', { user: req.user.phone, amount, txhash });
        res.json({ success: true });
    } catch (e) {
        console.error('Deposit crypto error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/payment-config', authenticate, (req, res) => {
    res.json({
        success: true,
        adminWallet: getAdminWalletAddress(),
        adminTill: ADMIN_TILL,
        mpesa: mpesaConfigStatus()
    });
});

app.post('/api/user/upgrade', authenticate, async (req, res) => {
    const FEE = 1500;
    try {
        const user = await dbGet(`SELECT balance, is_upgraded FROM users WHERE phone = ?`, [req.user.phone]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.is_upgraded === 1) {
            return res.json({ success: false, message: 'Account already upgraded' });
        }

        const balance = parseFloat(user.balance || 0);
        if (balance < FEE) {
            return res.json({ success: false, message: 'Insufficient balance for upgrade' });
        }

        const newBalance = (balance - FEE).toFixed(2);
        const expiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

        await dbRun(`UPDATE users SET balance = ?, is_upgraded = 1, upgrade_expiry = ? WHERE phone = ?`, [newBalance, expiry, req.user.phone]);
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, reference, status) VALUES (?, 'upgrade', ?, ?, 'completed')`, [req.user.phone, FEE, `UPGRADE_${Date.now()}`]);

        if (typeof emitBalance === 'function') emitBalance(req.user.phone);

        res.json({ success: true, message: 'Upgrade successful' });
    } catch (e) {
        console.error('Upgrade error:', e);
        res.status(500).json({ success: false, message: 'Server error during upgrade' });
    }
});

app.get('/api/user/history', authenticate, (req, res) => {
    const userPhone = normalizePhone(req.user.phone);

    const query = `
        SELECT id, type, amount, status, reference, mpesa_receipt, internal_id, timestamp, timestamp AS created_at
        FROM transactions
        WHERE user_phone = ?
        AND type IN ('stk_request', 'withdraw', 'deposit', 'referral_bonus', 'crypto')
        ORDER BY id DESC
    `;

    db.all(query, [userPhone], (err, rows) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ success: false, message: "Database query failed" });
        }
        res.json({ success: true, history: rows || [] });
    });
});

// Resend verification email for unverified users
app.post('/api/resend-verification', authLimiter, async (req, res) => {
    const { phone } = req.body;
    const norm = normalizePhone(phone);
    try {
        const user = await dbGet(`SELECT name, email, verification_token, status FROM users WHERE phone=?`, [norm]);
        if (!user) return res.json({ success: false, message: "Account not found." });
        if (user.status === 'verified') return res.json({ success: false, message: "Account is already verified. You can log in." });
        let token = user.verification_token;
        if (!token) {
            token = crypto.randomBytes(32).toString('hex');
            await dbRun(`UPDATE users SET verification_token = ? WHERE phone = ?`, [token, norm]);
        }
        const verifyLink = `${verificationUrl(token)}`;
        if (!user.email) return res.status(400).json({ success: false, message: "This account has no email address on file." });
        const mailResult = await sendPolyMail(user.email, "PolySoko Account Access", 
            `<p>Hello ${user.name || 'there'},</p>
             <p>Click the link below to verify your account and start using PolySoko.</p>
             <p><a href="${verifyLink}" style="display:inline-block;padding:12px 18px;background:#00ff88;color:#020405;text-decoration:none;border-radius:8px;font-weight:bold;">Verify Account</a></p>
             <p>If the button does not open, paste this link into your browser:<br><span style="word-break:break-all;">${verifyLink}</span></p>
             <p style="color:#666;font-size:0.85rem;">If you did not create an account, you can ignore this email.</p>`);
        if (!mailResult.success) {
            return res.status(503).json({
                success: false,
                message: mailFailureMessage(mailResult, "Verification email could not be sent. Please try again shortly.")
            });
        }
        res.json({ success: true, message: "Verification email resent! Check your inbox (including spam)." });
    } catch (e) {
        console.error('Resend verification error:', e);
        res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { phone } = req.body;
    const norm = normalizePhone(phone);
    db.get(`SELECT email, name, status, verification_token FROM users WHERE phone=?`, [norm], async (err, user) => {
        if (err) return res.status(500).json({ success: false, message: "Server error. Please try again." });
        if (!user) return res.json({ success: false, message: "Not registered" });
        if (!user.email) return res.status(400).json({ success: false, message: "This account has no email address on file." });
        const token = crypto.randomBytes(32).toString('hex');
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 1200000;
        let verifySection = '';
        if (user.status !== 'verified') {
            let verificationToken = user.verification_token;
            if (!verificationToken) {
                verificationToken = crypto.randomBytes(32).toString('hex');
                await dbRun(`UPDATE users SET verification_token = ? WHERE phone = ?`, [verificationToken, norm]);
            }
            const verifyLink = verificationUrl(verificationToken);
            verifySection = `
                 <hr style="border:none;border-top:1px solid #ddd;margin:22px 0;">
                 <p>Your account is still waiting for email verification. You can also verify it here:</p>
                 <p><a href="${verifyLink}" style="display:inline-block;padding:12px 18px;background:#00ff88;color:#020405;text-decoration:none;border-radius:8px;font-weight:bold;">Verify Account</a></p>
                 <p>If the button does not open, paste this link into your browser:<br><span style="word-break:break-all;">${verifyLink}</span></p>`;
        }
        db.run(`INSERT INTO password_resets (phone, token, otp, expires) VALUES (?, ?, ?, ?)`, [norm, token, otp, expires], async (err) => {
            if (err) return res.status(500).json({ success: false, message: "Could not create a reset request." });
            const resetLink = passwordResetUrl(token, otp);
            const mailResult = await sendPolyMail(user.email, "PolySoko Password Reset", 
                `<p>Use this secure link to reset your PolySoko password. It expires in 20 minutes.</p>
                 <p><a href="${resetLink}" style="display:inline-block;padding:12px 18px;background:#00ff88;color:#020405;text-decoration:none;border-radius:8px;font-weight:bold;">Reset Password</a></p>
                 <p>If the button does not open, paste this link into your browser:<br><span style="word-break:break-all;">${resetLink}</span></p>
                 ${verifySection}`);
            if (!mailResult.success) {
                return res.status(503).json({
                    success: false,
                    message: mailFailureMessage(mailResult, "Password reset email could not be sent. Please try again shortly.")
                });
            }
            
            sendSms({
                to: [formatPhone(norm)],
                message: `PolySoko: Your password reset code is ${otp}. Soko ni Soko.`,
                from: "POLYSOKO"
            }).catch(e => console.warn("SMS bypassed or failed. OTP sent via Email."));

            res.json({ success: true, message: "Check your email for the reset link." });
        });
    });
});

app.post('/api/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: "Current and new password are required." });
    }
    if (String(newPassword).length < 8) {
        return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }

    try {
        const user = await dbGet(`SELECT email, password FROM users WHERE phone = ?`, [req.user.phone]);
        // Guard the missing-hash case: bcrypt.compare throws on a null hash, which
        // inside this async callback would otherwise leave the request hanging.
        if (!user) {
            return res.status(404).json({ success: false, message: "User account not found for this session" });
        }
        if (!user.password) {
            return res.status(400).json({ success: false, message: "This account has no password set. Use reset password instead." });
        }
        if (!(await bcrypt.compare(String(currentPassword), user.password))) {
            return res.status(401).json({ success: false, message: "Current password is incorrect." });
        }

        const hashed = await bcrypt.hash(String(newPassword), 10);
        const result = await dbRun(`UPDATE users SET password = ? WHERE phone = ?`, [hashed, req.user.phone]);
        if (!result.changes) {
            return res.status(404).json({ success: false, message: "User account not found for this session" });
        }

        sendPolyMail(user.email, "Security Alert", "Password changed.");
        return res.json({ success: true, message: "Password updated." });
    } catch (e) {
        console.error("Change password failed:", e.message);
        return res.status(500).json({ success: false, message: "Password could not be changed. Please try again." });
    }
});
app.post('/api/place-bet', authenticate, async (req, res) => {
    const { marketId, side, amount } = req.body;
    const stake = parseFloat(amount);

    if (!marketId) return res.status(400).json({ success: false, message: "Missing Market ID" });
    if (isNaN(stake) || stake <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    const normalizedSide = side?.toUpperCase();
    let col = '';
    if (['HOME', 'YES'].includes(normalizedSide)) col = 'home_volume';
    if (['AWAY', 'NO'].includes(normalizedSide)) col = 'away_volume';
    if (!col) return res.status(400).json({ success: false, message: "Invalid side" });

    const reference = "BET_" + Date.now();

    try {
        const market = await dbGet(`SELECT * FROM markets WHERE id=?`, [marketId]);
        if (!market) return res.status(404).json({ success: false, message: "Market not found" });

        const bettableStatuses = ['open', 'upcoming'];
        if (!market.status || !bettableStatuses.includes(market.status.toLowerCase())) {
            return res.status(400).json({ success: false, message: "This market is closed." });
        }

        const baseOdds = ["HOME", "YES"].includes(normalizedSide) ? market.oddsA : market.oddsB;
        const user = await dbGet(`SELECT is_upgraded, upgrade_expiry FROM users WHERE phone = ?`, [req.user.phone]);
        
        const isElite = user && Number(user.is_upgraded) === 1 && new Date(user.upgrade_expiry || 0) > new Date();
        const isBoostedMarket = Number(market.is_boosted || 0) === 1;
        const boostedOdds = isElite && isBoostedMarket ? Number((baseOdds * 1.10).toFixed(2)) : baseOdds;
        const isBoostedBet = isElite && isBoostedMarket ? 1 : 0;

        // Using a transaction for atomicity
        let betRow = null;
        let insufficient = false;
        await withTransaction(async () => {
            // Deduct balance
            const deduction = await dbRun(`
                UPDATE users SET balance = balance - ?
                WHERE phone = ? AND balance >= ?
            `, [stake, req.user.phone, stake]);

            if (deduction.changes === 0) {
                // Throwing aborts the transaction, so no balance is deducted.
                insufficient = true;
                throw new Error('INSUFFICIENT_BALANCE');
            }

        // Update market volume
        await dbRun(`UPDATE markets SET ${col} = ${col} + ? WHERE id=?`, [stake, marketId]);

        // Insert transaction log
        const txInsert = await dbRun(`
            INSERT INTO transactions (user_phone, market_id, amount, type, side, status, odds, reference, is_boosted) 
            VALUES (?, ?, ?, 'bet', ?, 'active', ?, ?, ?)
        `, [req.user.phone, marketId, stake, side, boostedOdds, reference, isBoostedBet]);
        const transactionId = txInsert.lastID;

        // Insert actual bet record
        const betInsert = await dbRun(`
            INSERT INTO bets (user_phone, market_id, event, picked, amount, odds, status, category, commence_time, is_boosted, transaction_id, reference)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `, [req.user.phone, marketId, market.title, side, stake, boostedOdds, market.category || 'general', market.startTime || null, isBoostedBet, transactionId, reference]);

        const betId = betInsert.lastID;
            await dbRun(`UPDATE transactions SET bet_id=? WHERE id=?`, [betId, transactionId]);
            betRow = await dbGet(`SELECT * FROM bets WHERE id=?`, [betId]);
        });

        if (insufficient) {
            return res.status(400).json({ success: false, message: "Insufficient balance" });
        }

        // Run background tasks after commit
        recalculateOdds(marketId).catch(e => console.error("Odds error:", e.message));
        emitMarkets();
        emitBalance(req.user.phone);
        io.to(req.user.phone).emit('betPlaced', betRow);

        return res.json({
            success: true,
            message: "Bet placed successfully!",
            bet: betRow
        });

    } catch (e) {
        console.error("Ã¢ÂÅ’ Place Bet Error:", e.message);
        if (e.message === 'INSUFFICIENT_BALANCE') {
            return res.status(400).json({ success: false, message: "Insufficient balance" });
        }
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

async function triggerMpesaB2C(phone, amount) {
    const cleanPhone = phone.toString().replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 13) {
        throw new Error(`Invalid recipient: ${phone}. M-Pesa B2C service only supports individual phone numbers, not Till numbers.`);
    }
    if (!MPESA_B2C_SHORTCODE || !MPESA_B2C_INITIATOR || !MPESA_B2C_SECURITY_CREDENTIAL) {
        throw new Error('M-Pesa B2C withdrawal is not configured.');
    }

    const accessToken = await getMpesaAccessToken();
    const payload = {
        "InitiatorName": MPESA_B2C_INITIATOR,
        "SecurityCredential": MPESA_B2C_SECURITY_CREDENTIAL,
        "CommandID": MPESA_B2C_COMMAND_ID,
        "Amount": Math.round(amount),
        "PartyA": MPESA_B2C_SHORTCODE,
        "PartyB": cleanPhone,
        "Remarks": "PolySoko withdrawal",
        "QueueTimeOutURL": `${PUBLIC_API_BASE}/api/mpesa/timeout`,
        "ResultURL": `${PUBLIC_API_BASE}/api/mpesa/result`,
        "Occassion": "PolySoko withdrawal"
    };

    const response = await axios.post(
        `${MPESA_BASE_URL}/mpesa/b2c/v1/paymentrequest`, 
        payload, 
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data;
}

app.post('/api/withdraw', authenticate, async (req, res) => {
    const withdrawAmt = Number(req.body.amount);
    const userPhone = req.user.phone;

    if (isNaN(withdrawAmt) || withdrawAmt <= 0) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
    }

    try {
        const user = await dbGet(`SELECT balance FROM users WHERE phone = ?`, [userPhone]);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const currentBalance = Number(user.balance);
        if (currentBalance < withdrawAmt) return res.json({ success: false, message: "Insufficient balance." });

        let withdrawFailed = false;
        await withTransaction(async () => {
            const updateRes = await dbRun(`UPDATE users SET balance = balance - ? WHERE phone = ? AND balance >= ?`, [withdrawAmt, userPhone, withdrawAmt]);
            if (!updateRes || updateRes.changes === 0) {
                // Throwing aborts, so no funds are moved.
                withdrawFailed = true;
                throw new Error('BALANCE_UPDATE_FAILED');
            }

            const reference = "WD_" + Date.now();
            await dbRun(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'withdraw', ?, 'pending', ?)`, [userPhone, -withdrawAmt, reference]);
        });

        if (withdrawFailed) {
            return res.status(400).json({ success: false, message: "Balance update failed." });
        }

        emitBalance(userPhone);
        try {
            await sendPolyMail(process.env.ADMIN_EMAIL, "Ã°Å¸â€™Â° Withdrawal Request", `User ${userPhone} requested withdrawal of sKES ${withdrawAmt}`);
        } catch (e) { /* ignore mail errors */ }

        return res.json({ success: true, message: "Withdrawal request received and is pending approval." });
    } catch (e) {
        console.error('Withdraw error:', e);
        if (e.message === 'BALANCE_UPDATE_FAILED') {
            return res.status(400).json({ success: false, message: "Balance update failed." });
        }
        return res.status(500).json({ success: false });
    }
});

app.post('/api/mpesa/result', async (req, res) => {
    const Result = req.body.Result || {};
    const { ResultCode, ResultDesc, ConversationID, TransactionID } = Result;

    try {
        const tx = await dbGet(`SELECT id, user_phone, amount, status FROM transactions WHERE reference = ?`, [ConversationID]);
        if (!tx) return res.status(200).send('OK');

        if (Number(ResultCode) === 0) {
            if (tx.status !== 'completed') {
                await dbRun(
                    `UPDATE transactions SET status = 'completed', mpesa_receipt = ? WHERE id = ?`,
                    [TransactionID || ConversationID, tx.id]
                );
                console.log(`Withdrawal ${ConversationID} marked as completed with M-Pesa receipt ${TransactionID || 'N/A'}.`);
                emitAdminEvent('mpesaLogUpdate', { phone: tx.user_phone, amount: Math.abs(tx.amount || 0), status: 'completed', reference: ConversationID });
            }
        } else {
            if (tx.status !== 'failed' && tx.status !== 'completed') {
                await dbRun(`UPDATE transactions SET status = 'failed' WHERE id = ?`, [tx.id]);
                const refund = Math.abs(tx.amount || 0);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, tx.user_phone]);
                emitBalance(tx.user_phone);
                emitAdminEvent('mpesaLogUpdate', { phone: tx.user_phone, amount: refund, status: 'failed', reference: ConversationID });
                console.log(`Withdrawal ${ConversationID} failed: ${ResultDesc}. Refunded sKES ${refund} to ${tx.user_phone}`);
            }
        }
    } catch (e) {
        console.error('Error handling M-Pesa result:', e);
    }

    res.status(200).send('OK');
});

app.post('/api/mpesa/timeout', async (req, res) => {
    const Result = req.body.Result || {};
    const { ConversationID, ResultDesc } = Result;

    try {
        if (ConversationID) {
            const tx = await dbGet(`SELECT id, user_phone, amount, status FROM transactions WHERE reference = ?`, [ConversationID]);
            if (tx && tx.status !== 'failed' && tx.status !== 'completed') {
                const refund = Math.abs(tx.amount || 0);
                await dbRun(`UPDATE transactions SET status = 'failed' WHERE id = ?`, [tx.id]);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, tx.user_phone]);
                emitBalance(tx.user_phone);
                emitAdminEvent('mpesaLogUpdate', { phone: tx.user_phone, amount: refund, status: 'failed', reference: ConversationID });
            }
        }
    } catch (e) {
        console.error('Error handling M-Pesa timeout:', e);
    }

    res.status(200).send('OK');
});
app.post('/api/stkpush', authenticate, async (req,res)=>{
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 1) {
        return res.status(400).json({ success: false, message: "Minimum deposit is 1 sKES." });
    }
    if (!MPESA_STK_SHORTCODE || !MPESA_STK_PASSKEY || !MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
        return res.status(500).json({ success: false, message: "M-Pesa STK is not configured." });
    }

    try {
        const accessToken = await getMpesaAccessToken();
        const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0,14);
        const password = Buffer.from(`${MPESA_STK_SHORTCODE}${MPESA_STK_PASSKEY}${timestamp}`).toString('base64');
        const formattedPhone = normalizePhone(req.user.phone);
        const callbackUrl = STK_CALLBACK_URL;
        const roundedAmount = Math.round(amount);
        console.log(`M-Pesa STK callback URL: ${callbackUrl}`);

        const stkRes = await axios.post(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: MPESA_STK_SHORTCODE, 
    Password: password, 
    Timestamp: timestamp, 
    TransactionType: MPESA_STK_TRANSACTION_TYPE, 
    Amount: roundedAmount, 
    PartyA: formattedPhone, 
    PartyB: MPESA_STK_SHORTCODE,
    PhoneNumber: formattedPhone, 
    CallBackURL: callbackUrl, 
    AccountReference: 'PolySoko', 
    TransactionDesc: 'Deposit'
}, { headers:{ Authorization: `Bearer ${accessToken}` } });
        
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, reference, internal_id, status) VALUES (?, 'stk_request', ?, ?, ?, 'pending')`,
            [req.user.phone, roundedAmount, stkRes.data.CheckoutRequestID, stkRes.data.MerchantRequestID || null]);
        emitAdminEvent('mpesaLogUpdate', { phone: req.user.phone, amount: roundedAmount, status: 'pending', reference: stkRes.data.CheckoutRequestID });
        res.json({ success:true, checkoutRequestId: stkRes.data.CheckoutRequestID, merchantRequestId: stkRes.data.MerchantRequestID });
   } catch(err) {
    console.error("M-Pesa STK Push Error:", err.response ? err.response.data : err.message);
    res.status(500).json({ 
        success: false, 
        message: err.response ? (err.response.data.errorMessage || err.response.data.ResponseDescription) : "Server Error" 
    });
   }
});

app.post('/api/stkcallback', async (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    const stk = req.body.Body?.stkCallback;
    if (!stk) return;

    const checkoutID = stk.CheckoutRequestID;

    try {
        const tx = await dbGet(`SELECT id, user_phone, amount, status FROM transactions WHERE reference = ?`, [checkoutID]);
        if (!tx) {
            console.warn(`M-Pesa STK callback had no matching transaction: ${checkoutID}`);
            return;
        }
        if (tx.status !== 'pending') {
            console.log(`M-Pesa STK callback ignored for ${checkoutID}; current status is ${tx.status}.`);
            return;
        }

        if (Number(stk.ResultCode) !== 0) {
            await dbRun(`UPDATE transactions SET status = 'failed' WHERE id = ? AND status = 'pending'`, [tx.id]);
            console.log(`STK Push failed for ${checkoutID}: ${stk.ResultDesc}`);
            emitAdminEvent('mpesaLogUpdate', { phone: tx.user_phone, reference: checkoutID, status: 'failed' });
            return;
        }

        const metadata = stk.CallbackMetadata?.Item || [];
        const paidAmount = Number(metadata.find(i => i.Name === 'Amount')?.Value);
        const creditedAmount = Number.isFinite(paidAmount) && paidAmount > 0 ? paidAmount : Number(tx.amount || 0);
        const mpesaId = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value || null;
        const internalTxnId = "PS-" + Math.random().toString(36).substr(2, 7).toUpperCase();

        await withTransaction(async () => {
            const update = await dbRun(
                `UPDATE transactions SET status = 'completed', mpesa_receipt = ?, internal_id = ? WHERE id = ? AND status = 'pending'`,
                [mpesaId, internalTxnId, tx.id]
            );
            if (!update || update.changes === 0) return;
            await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [creditedAmount, tx.user_phone]);
        });

        console.log(`Deposit confirmed: KES ${creditedAmount} for ${tx.user_phone}`);
        sendPolysokoPush(tx.user_phone, creditedAmount, mpesaId, internalTxnId);
        emitBalance(tx.user_phone);
        emitAdminEvent('mpesaLogUpdate', {
            phone: tx.user_phone,
            amount: creditedAmount,
            status: 'completed',
            reference: checkoutID
        });
    } catch (e) {
        console.error('Error handling STK callback:', e);
    }
});

app.get('/api/user/sync-wallet', authenticate, async (req, res) => {
    try {
        const user = await dbGet("SELECT wallet_address, id FROM users WHERE phone = ?", [req.user.phone]);    
        if (!user?.wallet_address) return res.status(400).json({ message: "Link wallet first" });
        const balance = await getSokoBalance(user.wallet_address);
        await dbRun("UPDATE users SET crypto_balance = ? WHERE id = ?", [balance, user.id]);
        res.json({ success: true, balance });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.get('/api/transactions', authenticate, (req, res) => {
    db.all(
        `SELECT * FROM transactions WHERE user_phone = ? ORDER BY timestamp DESC`,
        [req.user.phone],
        (err, rows) => {
            if (err) return res.json({ success: false });
            res.json({ success: true, transactions: rows });
        }
    );
});
app.get('/api/my-bets', authenticate, (req, res) => {
    const phone = req.user.phone;
    const status = req.query.status; // active | won | lost | cancelled | all

    // Use the actual 'bets' table which has the event info
    let sql = `
        SELECT 
            id,
            market_id,
            event,
            picked,
            amount,
            odds,
            status,
            category,
            commence_time
        FROM bets 
        WHERE user_phone = ?
    `;

    const params = [phone];

    // Filter by status if the user clicked a specific tab (Active, Won, etc.)
    if (status && status !== 'all') {
        sql += ` AND status = ?`;
        params.push(status);
    }

    sql += ` ORDER BY id DESC`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error("DATABASE ERROR:", err);
            return res.status(500).json({ success: false, message: "Internal server error" });
        }

        // Send the response back to your switchBetTab function
        res.json({
            success: true,
            bets: rows
        });
    });
});
// --- ADMIN ROUTES ---
app.post('/api/admin/update-market', authenticateAdmin, (req, res) => {
    const { id, title, content, media_url, media_type } = req.body;
    
    db.run(`
        UPDATE markets 
        SET title = ?, content = ?, media_url = ?, media_type = ? 
        WHERE id = ?
    `, [title, content, media_url || null, media_type || 'auto', id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        
        if (typeof emitMarkets === "function") emitMarkets(); 
        
        res.json({ success: true });
    });
});

app.post('/api/admin/rephrase-market', authenticateAdmin, async (req, res) => {
    const { title, content, engine = 'gpt' } = req.body;
    if (!title && !content) {
        return res.status(400).json({ success: false, message: 'Provide title or description text to rephrase.' });
    }

    const originalText = `TITLE: ${title || ''}\nDESCRIPTION: ${content || ''}`;
    const prompt = `Rewrite the following betting market title and description into a sharper, clearer, more compelling market listing for a superadmin-reviewed marketplace. Keep the meaning exactly, preserve the category intent, and output only valid JSON with keys \"title\" and \"description\".`;

    const messages = [
        { role: 'system', content: 'You are an expert market editor for a sports and news betting platform.' },
        { role: 'user', content: `${prompt}\n\n${originalText}` }
    ];

    try {
        // Use helper that handles retries and provider fallback
        const aiResp = await callAI({ engine: 'market-editor', messages, promptText: `${prompt}\n\n${originalText}` });
        let responseText = aiResp?.text;
        let usedEngine = aiResp?.engine || 'none';

        if (!responseText) {
            return res.json({ success: true, engine: usedEngine, rephrased: { title: title || '', description: content || '' } });
        }

        let parsed = null;
        try {
            parsed = JSON.parse(responseText.replace(/^[^\{]*\{/, '{').trim());
        } catch (jsonErr) {
            const titleMatch = responseText.match(/"title"\s*:\s*"([^"]+)"/i);
            const descMatch = responseText.match(/"description"\s*:\s*"([^"]+)"/i);
            parsed = {
                title: titleMatch ? titleMatch[1] : title,
                description: descMatch ? descMatch[1] : content
            };
        }

        res.json({ success: true, engine: usedEngine, rephrased: parsed });
    } catch (err) {
        console.error('Rephrase service failed:', err.message || err);
        res.status(500).json({ success: false, message: 'AI rephrase failed. Check API key or try again.' });
    }
});

// Simple AI chat endpoint for assistant UI
app.post('/api/ai/chat', authenticate, async (req, res) => {
    const { message, engine = 'gpt', history = [] } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Missing message' });

    const user = await dbGet(`SELECT name, balance FROM users WHERE phone=?`, [req.user.phone]).catch(() => null);
    const systemPrompt = [
        personaRaw || 'You are a helpful PolySoko assistant.',
        'Keep replies compact: 1 to 4 short sentences unless the user asks for detail.',
        'Help with markets, bets, deposits, withdrawals, profile, and account issues.',
        'Do not ask for passwords, OTPs, card details, or private keys.',
        user ? `Current user: ${user.name || req.user.phone}. Balance: sKES ${Number(user.balance || 0).toFixed(2)}.` : ''
    ].filter(Boolean).join('\n');
    const compactHistory = Array.isArray(history)
        ? history.slice(-8).map(item => ({
            role: item.role === 'user' ? 'user' : 'assistant',
            content: String(item.text || '').slice(0, 600)
        }))
        : [];
    const messages = [
        { role: 'system', content: systemPrompt },
        ...compactHistory,
        { role: 'user', content: message }
    ];

    try {
        const aiResp = await callAI({ engine, messages, promptText: `${systemPrompt}\n\n${message}` });
        if (!aiResp || !aiResp.text) {
            return res.json({ success: true, engine: 'local', reply: 'I can help with that, but the AI service is unavailable right now. Try again shortly or use the admin tools for urgent bet settlement.' });
        }
        return res.json({ success: true, engine: aiResp.engine, reply: aiResp.text });
    } catch (err) {
        console.error('AI chat failed:', err.message || err);
        return res.json({ success: true, engine: 'local', reply: 'Chat is online, but the AI provider failed. Please try again shortly.' });
    }
});

async function settleAllOpenAdminMarkets() {
    await settleResolvedMarkets();
    await runSettlementEngine();

    const footballToResolve = await dbAll(`
        SELECT id
        FROM markets
        WHERE settled = 0
          AND (id LIKE 'fb_%' OR (category='sports' AND sport='Football') OR country='Football')
          AND status IN ('closed','ended')
        LIMIT 100
    `, []);

    let footballResolved = 0;
    for (const row of footballToResolve || []) {
        try {
            const result = await resolveFootballMarketResult(row.id);
            if (!result) continue;
            if (result === 'DRAW') await cancelMarket(row.id, 'DRAW');
            else await settleMarket(row.id, result);
            footballResolved++;
        } catch (e) {
            console.warn(`Admin settle-all failed for ${row.id}:`, e.message);
        }
    }

    const unresolved = await dbGet(`
        SELECT COUNT(*) AS count
        FROM markets
        WHERE settled = 0
          AND status IN ('closed','ended')
    `, []);

    emitMarkets();
    return { footballResolved, unresolvedClosed: Number(unresolved?.count || 0) };
}

app.post('/api/admin/settle-all-bets', authenticateAdmin, async (req, res) => {
    try {
        const summary = await settleAllOpenAdminMarkets();
        res.json({ success: true, ...summary });
    } catch (e) {
        console.error("Admin settle all bets failed:", e.message);
        res.status(500).json({ success: false, message: "Settle all bets failed" });
    }
});

app.post('/api/admin/settle-all', authenticateAdmin, async (req, res) => {
    try {
        const summary = await settleAllOpenAdminMarkets();
        res.json({ success: true, ...summary });
    } catch (e) {
        console.error("Admin settle all failed:", e.message);
        res.status(500).json({ success: false, message: "Settle all failed" });
    }
});

app.get('/api/admin/mpesa-log', authenticateAdmin, (req, res) => {
    db.all(`SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 200`, (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, logs: rows });
    });
});

app.get('/api/admin/mpesa-status', authenticateAdmin, (req, res) => {
    res.json({ success: true, mpesa: mpesaConfigStatus() });
});

app.get('/api/admin/all-markets', authenticateAdmin, (req, res) => {
    db.all("SELECT * FROM markets ORDER BY timestamp DESC", (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        res.json({ success: true, markets: rows || [] });
    });
});
app.get('/api/admin/all-active-bets', authenticateAdmin, async (req, res) => {
    try {
       const bets = await dbAll(`
            SELECT 
                b.id,
                b.user_phone,
                u.name AS userName,
                b.event AS marketTitle,
                b.market_id,
                b.amount,
                b.picked AS side,
                b.odds,
                b.status,
                m.sideA,
                m.sideB,
                m.status AS marketStatus,
                m.result AS marketResult,
                b.created_at as timestamp
            FROM bets b
            LEFT JOIN users u ON b.user_phone = u.phone
            LEFT JOIN markets m ON b.market_id = m.id
            ORDER BY b.created_at DESC
`);

        res.json({ success: true, bets });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});
app.post('/api/admin/delete-market', authenticateAdmin, async (req, res) => {
    const { id } = req.body;
    db.run(`DELETE FROM markets WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// SuperAdmin PIN Login (6-digit PIN only, no phone required)
app.post('/api/admin/pin-login', authLimiter, async (req, res) => {
    const { pin } = req.body;
    // Falls back to the stored/DB admin identity when ADMIN_PHONE is absent on
    // the host, which previously made this route unusable in production.
    const adminPhone = await resolveAdminPhone();
    
    if (!adminPhone) {
        return res.status(503).json({
            success: false,
            code: 'ADMIN_NOT_CONFIGURED',
            message: "Admin is not configured on this server. Set the ADMIN_PHONE environment variable to your admin phone number."
        });
    }
    
    if (!pin || String(pin).length !== 6) {
        return res.json({ success: false, message: "Please enter a valid 6-digit PIN." });
    }
    
    // Check if a PIN is stored in the DB
    const adminSettings = await dbGet(`SELECT pin_hash FROM admin_settings WHERE id = 1`).catch(() => null);
    
    let pinValid = false;
    
    if (adminSettings && adminSettings.pin_hash) {
        // Use bcrypt to compare against stored hash
        pinValid = await bcrypt.compare(String(pin), adminSettings.pin_hash);
    } else {
        // Fallback to env var for backward compatibility
        const adminPin = process.env.ADMIN_PASSWORD || 'Polymarket2024';
        pinValid = String(pin) === String(adminPin);
    }
    
    if (!pinValid) {
        console.warn(`Ã°Å¸Å¡Â« Failed admin PIN attempt from IP: ${req.ip}`);
        return res.json({ success: false, message: "Invalid PIN. Access denied." });
    }
    
    // Generate admin token
    const token = signJwt({ phone: adminPhone }, { expiresIn: '24h' });
    
    // Ensure admin role in DB
    try {
        await dbRun(`UPDATE users SET role='admin' WHERE phone=?`, [adminPhone]);
    } catch (e) { /* ignore */ }
    
    // Log the admin login
    if (typeof global.addActivityLog === 'function') {
        global.addActivityLog(adminPhone, 'admin_pin_login', 'Admin logged in via 6-digit PIN', req.ip || '', req.headers['user-agent'] || '');
    }
    
    res.json({ success: true, token, message: "SuperAdmin access granted." });
});

// Master password login (for first-time PIN setup, accepts full ADMIN_PASSWORD)
app.post('/api/admin/master-login', authLimiter, async (req, res) => {
    const { password } = req.body;
    const adminPhone = await resolveAdminPhone();
    const adminPassword = process.env.ADMIN_PASSWORD || 'Polymarket2024';
    
    if (!adminPhone) {
        return res.status(503).json({
            success: false,
            code: 'ADMIN_NOT_CONFIGURED',
            message: "Admin is not configured on this server. Set the ADMIN_PHONE environment variable to your admin phone number."
        });
    }
    
    if (!password || String(password) !== String(adminPassword)) {
        console.warn(`Ã°Å¸Å¡Â« Failed admin master login from IP: ${req.ip}`);
        return res.json({ success: false, message: "Invalid server password." });
    }
    
    const token = signJwt({ phone: adminPhone }, { expiresIn: '24h' });
    
    // Persist the identity that was actually used. If ADMIN_PHONE is absent this
    // records the fallback so every future restart resolves the same admin
    // instead of depending on whichever account happens to be flagged first.
    if (!process.env.ADMIN_PHONE) {
        await persistAdminPhone(adminPhone);
    }

    try {
        await dbRun(`UPDATE users SET role='admin' WHERE phone=?`, [adminPhone]);
    } catch (e) { /* ignore */ }
    
    if (typeof global.addActivityLog === 'function') {
        global.addActivityLog(adminPhone, 'admin_master_login', 'Admin logged in via master password (first-time setup)', req.ip || '', req.headers['user-agent'] || '');
    }
    
    res.json({ success: true, token, message: "Master access granted." });
});

// Check if admin PIN has been set up
app.get('/api/admin/pin-status', async (req, res) => {
    try {
        const adminSettings = await dbGet(`SELECT pin_hash FROM admin_settings WHERE id = 1`).catch(() => null);
        const hasPin = !!(adminSettings && adminSettings.pin_hash);
        res.json({ success: true, hasPin });
    } catch (e) {
        res.json({ success: true, hasPin: false });
    }
});

// Setup admin PIN (first-time registration, requires admin token)
app.post('/api/admin/setup-pin', authenticateAdmin, async (req, res) => {
    const { pin } = req.body;
    
    if (!pin || String(pin).length !== 6 || !/^\d{6}$/.test(String(pin))) {
        return res.status(400).json({ success: false, message: "PIN must be exactly 6 digits." });
    }
    
    try {
        const existing = await dbGet(`SELECT pin_hash FROM admin_settings WHERE id = 1`).catch(() => null);
        if (existing && existing.pin_hash) {
            return res.status(400).json({ success: false, message: "PIN is already set. Use change-pin to update it." });
        }
        
        const hashedPin = await bcrypt.hash(String(pin), 10);
        await dbRun(`INSERT OR REPLACE INTO admin_settings (id, pin_hash, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)`, [hashedPin]);
        
        if (typeof global.addActivityLog === 'function') {
            global.addActivityLog(req.user.phone, 'admin_pin_setup', 'Admin PIN was set up', req.ip || '', req.headers['user-agent'] || '');
        }
        
        res.json({ success: true, message: "Admin PIN set up successfully." });
    } catch (e) {
        console.error("Setup PIN error:", e);
        res.status(500).json({ success: false, message: "Failed to set up PIN." });
    }
});

// Change admin PIN (requires admin token + current PIN)
app.post('/api/admin/change-pin', authenticateAdmin, async (req, res) => {
    const { currentPin, newPin } = req.body;
    
    if (!currentPin || !newPin) {
        return res.status(400).json({ success: false, message: "Both current and new PIN are required." });
    }
    if (!/^\d{6}$/.test(String(newPin))) {
        return res.status(400).json({ success: false, message: "New PIN must be exactly 6 digits." });
    }
    
    try {
        const adminSettings = await dbGet(`SELECT pin_hash FROM admin_settings WHERE id = 1`).catch(() => null);
        
        if (!adminSettings || !adminSettings.pin_hash) {
            return res.status(400).json({ success: false, message: "No PIN is set. Use setup-pin first." });
        }
        
        const pinValid = await bcrypt.compare(String(currentPin), adminSettings.pin_hash);
        if (!pinValid) {
            return res.status(403).json({ success: false, message: "Current PIN is incorrect." });
        }
        
        const hashedPin = await bcrypt.hash(String(newPin), 10);
        await dbRun(`UPDATE admin_settings SET pin_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [hashedPin]);
        
        if (typeof global.addActivityLog === 'function') {
            global.addActivityLog(req.user.phone, 'admin_pin_change', 'Admin PIN was changed', req.ip || '', req.headers['user-agent'] || '');
        }
        
        res.json({ success: true, message: "PIN changed successfully." });
    } catch (e) {
        console.error("Change PIN error:", e);
        res.status(500).json({ success: false, message: "Failed to change PIN." });
    }
});

app.post('/api/admin/wire-funds', authenticateAdmin, async (req, res) => {
    const { amount, type } = req.body;
    const adminPhone = (await resolveAdminPhone()) || 'SYSTEM';
    try {
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount provided.' });
        }

        const wireAmount = Number(amount);
        const reference = `WIRE_${type?.toUpperCase() || 'UNKNOWN'}_${Date.now()}`;

        if (type === 'till') {
            // FIX: Automated B2C to Shortcode (4447028) is not supported by Safaricom.
            // This action now records the settlement for audit logs.
            await dbRun(
                `INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, ?, ?, 'completed', ?)`,
                [adminPhone, 'admin_wire', -wireAmount, reference]
            );
             console.log(`Ã°Å¸â€™Â° [WIRE TO TILL] sKES ${wireAmount} by admin ${adminPhone}. Ref: ${reference}`);
            console.log(`Ã¢Å¡Â Ã¯Â¸Â [MANUAL SETTLEMENT REQUIRED] Logged sKES ${wireAmount} wire to Till 4447028 by admin ${adminPhone}. Ref: ${reference}`);
            return res.json({ success: true, message: 'Wire to Till recorded. Please perform the manual transfer via your Merchant Portal.', reference });
        }

        if (type === 'metamask') {
            const recipientAddress = process.env.META_MASK_ADDRESS || getAdminWalletAddress();
            if (!recipientAddress || !isValidAddress(recipientAddress)) {
                throw new Error('MetaMask wallet address is not configured or invalid.');
            }
            const transferResult = await sendSoko(recipientAddress, wireAmount);
            if (!transferResult.success) {
                throw new Error(transferResult.error || 'MetaMask transfer failed');
            }
            await dbRun(
                `INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, ?, ?, 'completed', ?)`,
                [adminPhone, 'admin_wire', -wireAmount, `${reference}_${transferResult.hash || 'NOHASH'}`]
            );
            return res.json({ success: true, message: 'Wired to MetaMask successfully.', txHash: transferResult.hash });
        }

        throw new Error('Unknown wire type');
    } catch (e) {
        console.error('Admin wire funds failed:', e);
        res.status(500).json({ success: false, message: e.message || 'Wire failed' });
    }
});

app.post('/api/admin/approve-withdraw-fast', authenticateAdmin, async (req, res) => {
    const { txId } = req.body;

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);
        if (!tx || tx.status !== 'pending') {
            return res.status(400).json({ success: false, message: "Invalid transaction" });
        }

        const amount = Math.abs(tx.amount);
        const userPhone = tx.user_phone;

        await dbRun(`UPDATE transactions SET status='processing' WHERE id=? AND status='pending'`, [txId]);
        res.json({ success: true, message: "Withdrawal approval started" });

        (async () => {
            try {
                const mpesaResponse = await triggerMpesaB2C(userPhone, amount);
                if (mpesaResponse.ResponseCode !== "0") {
                    throw new Error(mpesaResponse.ResponseDescription || "M-Pesa rejected payout");
                }
                const mpesaReference = mpesaResponse.ConversationID || mpesaResponse.OriginatorConversationID || `B2C_${Date.now()}`;

                await dbRun(
                    `UPDATE transactions SET status='processing', reference=?, internal_id=? WHERE id=?`,
                    [mpesaReference, mpesaResponse.OriginatorConversationID || null, txId]
                );
                emitAdminEvent('mpesaLogUpdate', { phone: userPhone, amount, status: 'processing', reference: mpesaReference });

                sendSms({
                    to: [formatPhone(userPhone)],
                    message: `Your withdrawal of sKES ${amount} was approved and is being processed by M-Pesa.`,
                    from: "POLYSOKO"
                }).catch(e => console.log("SMS failed but payout succeeded.", e.message));
            } catch (err) {
                console.error("Async withdrawal approval failed:", err.message);
                await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone=?`, [amount, userPhone]);
                emitBalance(userPhone);
                emitAdminEvent('mpesaLogUpdate', { phone: userPhone, amount, status: 'failed', reference: tx.reference });
            }
        })();
    } catch (err) {
        console.error("Fast approval error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// --- APPROVE WITHDRAWAL ---
app.post('/api/admin/approve-withdraw', authenticateAdmin, async (req, res) => {
    const { txId } = req.body;

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);
        if (!tx || tx.status !== 'pending') {
            return res.status(400).json({ success: false, message: "Invalid transaction" });
        }

        const amount = Math.abs(tx.amount);
        const userPhone = tx.user_phone;

        await dbRun(`UPDATE transactions SET status='processing' WHERE id=? AND status='pending'`, [txId]);
        const mpesaResponse = await triggerMpesaB2C(userPhone, amount);

        if (mpesaResponse.ResponseCode !== "0") {
            throw new Error(`M-Pesa Payout Failed: ${mpesaResponse.ResponseDescription}`);
        }
        const mpesaReference = mpesaResponse.ConversationID || mpesaResponse.OriginatorConversationID || `B2C_${Date.now()}`;

        await dbRun(
            `UPDATE transactions SET status='processing', reference=?, internal_id=? WHERE id=?`,
            [mpesaReference, mpesaResponse.OriginatorConversationID || null, txId]
        );
        emitAdminEvent('mpesaLogUpdate', { phone: userPhone, amount, status: 'processing', reference: mpesaReference });

        const victoryMsg = `Your withdrawal of sKES ${amount} was approved and is being processed by M-Pesa.`;
        await sendSms({
            to: [formatPhone(userPhone)],
            message: victoryMsg,
            from: "POLYSOKO"
        }).catch(e => console.log("SMS failed but payout was submitted."));

        res.json({ success: true, message: "Withdrawal payout submitted to M-Pesa." });

  } catch (err) {
    // FORCE the terminal to show the error
    console.log("------------------------------------");
    console.error("Ã¢ÂÅ’ APPROVAL CRASHED AT:");
    console.error(err); 
    console.log("------------------------------------");

    const tx = await dbGet(`SELECT user_phone, amount, status FROM transactions WHERE id=?`, [txId]);
    if (tx && tx.status !== 'failed' && tx.status !== 'completed') {
         await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);
         const refund = Math.abs(tx.amount);
         await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, tx.user_phone]);
         emitBalance(tx.user_phone);
         emitAdminEvent('mpesaLogUpdate', { phone: tx.user_phone, amount: refund, status: 'failed', reference: tx.reference });
         console.log(`Ã°Å¸â€™Â° Automatic refund issued for failed withdrawal: sKES ${refund} to ${tx.user_phone}`);
    }
    
    return res.status(500).json({ 
        success: false, 
        message: "Server Error: " + err.message 
    });
    }
});

// --- REJECT WITHDRAWAL ---
app.post('/api/admin/reject-withdraw', authenticateAdmin, async (req, res) => {
    const { txId, reason } = req.body; // Added reason from admin input

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);

        if (!tx || tx.status !== 'pending') {
            return res.json({ success: false, message: "Transaction not pending" });
        }

        const refund = Math.abs(tx.amount);
        const userPhone = tx.user_phone;
        const rejectReason = reason || "Inconsistent account details";

        // 1. Refund user balance
        await dbRun(`UPDATE users SET balance = balance + ? WHERE phone=?`, [refund, userPhone]);

        // 2. Mark transaction as failed
        await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);

        // 3. SEND REJECTION SMS
        const rejectMsg = `Polysoko Update: Your withdrawal request of sKES ${refund} was declined. Reason: ${rejectReason}. Your funds have been reversed to your Polysoko wallet.`;
        sendSms({
            to: [formatPhone(userPhone)],
            message: rejectMsg,
            from: "POLYSOKO"
        }).catch(e => console.log("SMS fail:", e.message));

        emitBalance(userPhone);
        res.json({ success: true, message: "Withdrawal rejected and user notified" });

    } catch (err) {
        console.error("Reject Error:", err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/approve-market', authenticateAdmin, async (req, res) => {
    const { marketId } = req.body;
    try {
        const market = await dbGet(`SELECT * FROM markets WHERE id=? AND status='pending'`, [marketId]);
        if (!market) return res.status(404).json({ success: false, message: 'Market not found' });

        await dbRun(`UPDATE markets SET status='open' WHERE id=?`, [marketId]);

        // Send Email to Creator
        if (market.creator) {
            createNotification(market.creator, "Ã°Å¸Å¡â‚¬ Market Approved!", `Your market "${market.title}" is now LIVE.`, "success");
            
            const creator = await dbGet(`SELECT email, name FROM users WHERE phone=?`, [market.creator]);
            if (creator && creator.email) {
                const subject = `Ã°Å¸Å¡â‚¬ Your Market is LIVE: ${market.title}`;
                const html = `
                    <div style="font-family: sans-serif; padding: 20px; color: #333;">
                        <h2>Congratulations ${creator.name}!</h2>
                        <p>Your market submission has been reviewed and approved by PolySoko Admin.</p>
                        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; border-left: 4px solid #00ff88;">
                            <strong>Market:</strong> ${market.title}<br>
                            <strong>Initial Odds:</strong> ${market.oddsA} / ${market.oddsB}<br>
                            <strong>Category:</strong> ${market.category}
                        </div>
                        <p>Users can now start trading on your market. Soko ni Soko!</p>
                    </div>
                `;
                sendPolyMail(creator.email, subject, html);
            }
        }

        emitMarkets();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/bulk-approve-elite-markets', authenticateAdmin, async (req, res) => {
    try {
        // 1. Find all pending markets created by upgraded users
        const pendingEliteMarkets = await dbAll(`
            SELECT m.id, m.title, m.creator, m.category, u.name as creator_name, u.email as creator_email
            FROM markets m
            JOIN users u ON m.creator = u.phone
            WHERE m.status = 'pending' AND u.is_upgraded = 1
        `);

        if (!pendingEliteMarkets || pendingEliteMarkets.length === 0) {
            return res.json({ success: true, message: "No pending Elite markets found.", count: 0 });
        }

        let approvedCount = 0;
        const notifyCreators = [];
        await withTransaction(async () => {
            for (const market of pendingEliteMarkets) {
                await dbRun(`UPDATE markets SET status='open' WHERE id=?`, [market.id]);
                approvedCount++;
                // Notifications are dispatched after the commit below.
                notifyCreators.push(market);
            }
        });

        for (const market of notifyCreators) {
            createNotification(market.creator, "Ã°Å¸Å¡â‚¬ Market Approved!", `Your market "${market.title}" is now LIVE.`, "success");
            if (market.creator_email) {
                const subject = `Ã°Å¸Å¡â‚¬ Your Market is LIVE: ${market.title}`;
                const html = `
                    <div style="font-family: sans-serif; padding: 20px; color: #333;">
                        <h2>Congratulations ${market.creator_name || ''}!</h2>
                        <p>Your market submission has been reviewed and approved by PolySoko Admin.</p>
                        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; border-left: 4px solid #00ff88;">
                            <strong>Market:</strong> ${market.title}<br>
                            <strong>Category:</strong> ${market.category}
                        </div>
                        <p>Users can now start trading on your market. Soko ni Soko!</p>
                    </div>
                `;
                sendPolyMail(market.creator_email, subject, html);
            }
        }

        emitMarkets(); // Update all clients with the new open markets

        res.json({ success: true, message: `${approvedCount} markets approved.`, count: approvedCount });

    } catch (e) {
        console.error("Bulk approve elite markets error:", e);
        res.status(500).json({ success: false, message: "Server error during bulk approval." });
    }
});

app.post('/api/admin/reject-market', authenticateAdmin, async (req, res) => {
    const { marketId } = req.body;
    try {
        await dbRun(`DELETE FROM markets WHERE id=? AND status='pending'`, [marketId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/settle', authenticateAdmin, async (req, res) => {
    const { marketId, result } = req.body;

    if (!marketId || !result) {
        return res.status(400).json({ success: false });
    }

    try {
        const outcome = result.toUpperCase();
        const details = outcome === 'CANCEL' || outcome === 'CANCELLED'
            ? await cancelMarket(marketId, 'ADMIN_CANCELLED')
            : await settleMarket(marketId, outcome);
        res.json({ success: true, ...details });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || "Settlement failed" });
    }
});

app.post('/api/admin/cancel-market', authenticateAdmin, async (req, res) => {
    const { marketId, reason = 'ADMIN_CANCELLED' } = req.body;
    if (!marketId) return res.status(400).json({ success: false, message: "Missing market ID" });
    try {
        const details = await cancelMarket(marketId, reason);
        res.json({ success: true, ...details });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || "Cancel failed" });
    }
});

app.post('/api/admin/settle-bet', authenticateAdmin, async (req, res) => {
    const { betId, result } = req.body;
    if (!betId || !result) return res.status(400).json({ success: false, message: "Missing bet ID or result" });
    try {
        const details = await settleBetById(betId, result);
        res.json({ success: true, ...details });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || "Bet settlement failed" });
    }
});

app.post('/api/admin/cancel-bet', authenticateAdmin, async (req, res) => {
    const { betId, reason = 'ADMIN_CANCELLED' } = req.body;
    if (!betId) return res.status(400).json({ success: false, message: "Missing bet ID" });
    try {
        const details = await cancelBetById(betId, reason);
        res.json({ success: true, ...details });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message || "Bet cancel failed" });
    }
});

async function resolveFootballMarketResult(marketId) {
    const fixtureId = String(marketId || '').startsWith('fb_') ? String(marketId).slice(3) : null;
    if (!fixtureId) return null;
    if (!API_SPORTS_KEY) return null;

    const resp = await axios.get('https://v3.football.api-sports.io/fixtures', {
        params: { id: fixtureId, timezone: 'Africa/Nairobi' },
        headers: { 'x-apisports-key': API_SPORTS_KEY }
    });

    const fixture = resp.data?.response?.[0];
    if (!fixture) return null;

    const status = normalizeStatus(fixture.fixture?.status?.short);
    if (status !== 'closed') return null;

    const hg = Number(fixture.goals?.home);
    const ag = Number(fixture.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;

    if (hg > ag) return 'HOME';
    if (ag > hg) return 'AWAY';
    return 'DRAW';
}

async function settleFootballBacklog() {
    const footballToResolve = await dbAll(
        `SELECT id FROM markets WHERE (id LIKE 'fb_%' OR (category='sports' AND sport='Football') OR country='Football') AND settled=0 AND status='closed' AND (result IS NULL OR TRIM(result)='')`,
        []
    );

    let resolved = 0;
    for (const row of footballToResolve) {
        try {
            const result = await resolveFootballMarketResult(row.id);
            if (!result) continue;
            if (result === 'DRAW') await cancelMarket(row.id, 'DRAW');
            else await settleMarket(row.id, result);
            resolved++;
        } catch (e) {
            console.warn(`Football backlog resolve failed for ${row.id}:`, e.message);
        }
    }
    return { resolved, candidates: footballToResolve.length };
}

async function runSettlementEngine() {
    await closeExpiredMarkets();
    await settleResolvedMarkets();
    await settleWeatherMarkets();
    return settleFootballBacklog();
}

app.post('/api/admin/settle-backlog', authenticateAdmin, async (req, res) => {
    try {
        // 0) Repair: cancel/refund any "active" bets whose markets were deleted
        const orphanBets = await dbAll(
            `
            SELECT t.id, t.user_phone, t.amount, t.market_id
            FROM transactions t
            LEFT JOIN markets m ON m.id = t.market_id
            WHERE t.type='bet' AND t.status='active' AND (m.id IS NULL)
            `,
            []
        );
        let orphanRefunded = 0;
        if (orphanBets.length) {
            await withTransaction(async () => {
                for (const bet of orphanBets) {
                    const refund = Number(Number(bet.amount || 0).toFixed(2));
                    if (refund > 0) {
                        await dbRun(`UPDATE users SET balance = balance + ? WHERE phone=?`, [refund, bet.user_phone]);
                    }
                    await dbRun(`UPDATE transactions SET status='cancelled', settled_amount=? WHERE id=?`, [refund, bet.id]);
                    await dbRun(
                        `UPDATE bets SET status='cancelled' WHERE market_id=? AND user_phone=? AND status='active'`,
                        [bet.market_id, bet.user_phone]
                    );
                    orphanRefunded++;
                }
            });
            orphanBets.forEach(bet => emitBalance(bet.user_phone));
        }

        // 1) Settle anything that already has an explicit result
        await settleResolvedMarkets();

        // 2) Weather: calculate from history for all unsettled markets
        await settleWeatherMarkets();

        // 3) Football: backfill outcomes for already-closed fixtures
        const footballToResolve = await dbAll(
            `SELECT id FROM markets WHERE (id LIKE 'fb_%' OR (category='sports' AND sport='Football') OR country='Football') AND settled=0 AND status='closed' AND (result IS NULL OR TRIM(result)='')`,
            []
        );

        let resolved = 0;
        for (const row of footballToResolve) {
            try {
                const result = await resolveFootballMarketResult(row.id);
                if (!result) continue;
                if (result === 'DRAW') await cancelMarket(row.id, 'DRAW');
                else await settleMarket(row.id, result);
                resolved++;
            } catch (e) {
                console.warn(`Football backlog resolve failed for ${row.id}:`, e.message);
            }
        }

        res.json({
            success: true,
            orphanRefunded,
            footballResolved: resolved,
            footballCandidates: footballToResolve.length
        });
    } catch (e) {
        console.error("Backlog settlement failed:", e.message);
        res.status(500).json({ success: false, message: "Backlog settlement failed" });
    }
});

// Clean avatar upload Ã¢â‚¬â€ uses disk storage for reliability
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
        cb(null, `avatar-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        if (/^image\/(jpeg|jpg|png|webp|gif)$/.test(mime)) return cb(null, true);
        cb(new Error("Only JPEG, PNG, WebP, or GIF images are allowed"));
    }
});

app.post('/api/profile/avatar', uploadLimiter, authenticate, handleProfileAvatarUpload, persistProfileAvatar);

app.post('/api/update-avatar', uploadLimiter, authenticate, handleProfileAvatarUpload, persistProfileAvatar);

app.get('/api/admin/stats', authenticate, async (req, res) => {
    try {
        const adminPhone = await resolveAdminPhone();
        const userPhone = normalizePhone(req.user.phone);
        const isSuperAdmin = adminPhone && userPhone === adminPhone;

        if (!isSuperAdmin) {
            const user = await dbGet("SELECT is_upgraded, upgrade_expiry FROM users WHERE phone=?", [userPhone]);
            if (user?.is_upgraded === 1) {
                const expiry = new Date(user.upgrade_expiry);
                const days = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
                const boostedMarkets = await dbAll(`
                    SELECT id, title, category, oddsA, oddsB, status, home_volume, away_volume, is_boosted
                    FROM markets
                    WHERE is_boosted = 1 AND status IN ('open','upcoming','live')
                    ORDER BY startTime ASC
                    LIMIT 10
                `, []);
                return res.json({ success: true, isSuperAdmin: false, remainingDays: days > 0 ? days : 0, boostedMarkets: boostedMarkets || [] });
            }
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        let statsData = { isSuperAdmin };

            const pendingWithdrawals = await dbGet(`SELECT COUNT(*) as c FROM transactions WHERE type='withdraw' AND status='pending'`);
            const usersCount = await dbGet(`SELECT COUNT(*) as c FROM users`);
            const bonuses = await dbGet(`SELECT SUM(amount) as c FROM transactions WHERE type='referral_bonus'`);
            const subs = await dbGet(`SELECT COUNT(*) as c FROM users WHERE is_upgraded=1`);
            
            const profitData = await dbGet(`
                SELECT (SUM(CASE WHEN type='bet' THEN amount ELSE 0 END) - SUM(CASE WHEN status='won' THEN settled_amount ELSE 0 END)) as p 
                FROM transactions 
                WHERE type='bet' AND status IN ('won','lost','active')
            `);

            const totalPlatformBalance = await dbGet(`SELECT SUM(balance + crypto_balance) as total FROM users`);
            const pendingMarkets = await dbAll(`
                SELECT m.*, u.name as creator_name 
                FROM markets m 
                LEFT JOIN users u ON m.creator = u.phone 
                WHERE m.status='pending'
            `);

            Object.assign(statsData, {
                pending: pendingWithdrawals.c,
                users: usersCount.c,
                bonuses: bonuses.c || 0,
                subscriptions: subs.c || 0,
                profit: profitData.p || 0,
                platformTotal: totalPlatformBalance.total || 0,
                adminWallet: getAdminWalletAddress(),
                adminTill: ADMIN_TILL,
                mpesa: mpesaConfigStatus(),
                pendingMarkets: pendingMarkets || []
            });

        res.json({ success: true, ...statsData });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/pending-markets', authenticateAdmin, async (req, res) => {
    try {
        const markets = await dbAll(`
            SELECT m.*, m.creator as creator_phone, u.name as creator_name 
            FROM markets m 
            LEFT JOIN users u ON m.creator = u.phone 
            WHERE m.status='pending'
        `);
        res.json({ success: true, markets });
    } catch (e) {
        console.error("Ã¢ÂÅ’ Error fetching pending markets:", e);
        res.status(500).json({ success: false, message: "Database error fetching markets" });
    }
});

// Activity logs endpoint for superadmin
app.get('/api/admin/activity-logs', authenticateAdmin, async (req, res) => {
    const { phone, action, limit = 100 } = req.query;
    try {
        let sql = `SELECT id, user_phone, action, details, ip, created_at FROM activity_logs WHERE 1=1`;
        const params = [];
        if (phone) { sql += ` AND user_phone = ?`; params.push(normalizePhone(phone)); }
        if (action) { sql += ` AND action = ?`; params.push(action); }
        sql += ` ORDER BY id DESC LIMIT ?`;
        params.push(Math.min(parseInt(limit) || 100, 500));
        const logs = await dbAll(sql, params);
        const users = await dbAll(`SELECT DISTINCT user_phone FROM activity_logs ORDER BY user_phone`);
        const actionTypes = await dbAll(`SELECT DISTINCT action FROM activity_logs ORDER BY action`);
        res.json({ success: true, logs, filters: { users: users.map(u => u.user_phone), actions: actionTypes.map(a => a.action) } });
    } catch (e) {
        console.error('Activity logs error:', e);
        res.status(500).json({ success: false, message: "Failed to load activity logs" });
    }
});

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const users = await dbAll("SELECT name, phone, email, balance, is_upgraded, is_suspended FROM users ORDER BY name ASC");
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/users/manage', authenticateAdmin, async (req, res) => {
    const { phone, action, reason, violation } = req.body;
    const norm = normalizePhone(phone);
    try {
        const user = await dbGet("SELECT name, email, is_suspended, balance, referral_code FROM users WHERE phone=?", [norm]);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const adminPhone = await resolveAdminPhone();
        const effectiveReason = reason || (action === 'upgrade' ? 'Manual Admin Promotion' : 'No reason provided');
        let emailBody = "";
        let subject = "PolySoko Support Update";

        if (action === 'suspend') {
            const suspensionDaysMap = {
                scraping: 7,
                exploit: 7,
                reverse: 5,
                age: 2,
                multi: 4
            };
            const days = suspensionDaysMap[violation] || 3;
            const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            await dbRun("UPDATE users SET is_suspended = 1, suspension_expires = ? WHERE phone = ?", [expiresAt.toISOString(), norm]);
            emailBody = `Your account has been suspended for ${days} day${days === 1 ? '' : 's'} due to policy violation. It will automatically become active again on ${expiresAt.toLocaleDateString()}.`;
            subject = "Account Suspended";
        } else if (action === 'unsuspend') {
            await dbRun("UPDATE users SET is_suspended = 0, suspension_expires = NULL WHERE phone = ?", [norm]);
            emailBody = `Your account has been restored to ACTIVE status.`;
            subject = "Account Restored";
        } else if (action === 'upgrade') {
            const expiry = new Date(Date.now() + (60 * 24 * 60 * 60 * 1000));
            await dbRun("UPDATE users SET is_upgraded = 1, upgrade_expiry = ? WHERE phone = ?", [expiry.toISOString(), norm]);
            subject = "Ã°Å¸Å¡â‚¬ Congratulations: You are now ELITE!";
            emailBody = `Your account has been upgraded to the Elite Package for 60 days! Enjoy 10% boosted odds, priority withdrawals, and exclusive admin access. <br><br><b>Your Invite Code:</b> ${user.referral_code}`;
        } else if (action === 'revoke') {
            await dbRun("UPDATE users SET is_upgraded = 0, upgrade_expiry = NULL WHERE phone = ?", [norm]);
            emailBody = `Your Elite affiliation has been revoked.`;
        } else if (action === 'delete') {
            if (user.balance > 0 && adminPhone && adminPhone !== norm) {
                await dbRun("UPDATE users SET balance = balance + ? WHERE phone = ?", [user.balance, adminPhone]);
                await dbRun(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'finance_recovery', ?, 'completed', ?)`,
                    [adminPhone, user.balance, `RECOVERY_FROM_${norm}`]);
                emitBalance(adminPhone);
            }

            // The delete below must actually remove a row. Previously this branch
            // reported success unconditionally, so a delete that silently affected
            // zero rows left the account in place while the admin saw "deleted",
            // and registration then rejected the same phone/email as already taken.
            const removed = await dbRun("DELETE FROM users WHERE phone = ?", [norm]);
            if (!removed.changes) {
                return res.status(404).json({ success: false, message: "User not found. The account may already have been deleted." });
            }

            await dbRun("DELETE FROM transactions WHERE user_phone = ?", [norm]);
            await dbRun("DELETE FROM bets WHERE user_phone = ?", [norm]);
            // Clear every other table keyed by phone so a re-registration is not
            // blocked by orphan rows. Each is guarded because the table may not
            // exist yet on an older database snapshot.
            const cleanup = [
                ["DELETE FROM notifications WHERE user_phone = ?", [norm]],
                ["DELETE FROM user_devices WHERE user_phone = ?", [norm]],
                ["DELETE FROM password_resets WHERE phone = ?", [norm]],
                ["DELETE FROM activity_logs WHERE user_phone = ?", [norm]]
            ];
            for (const [sql, params] of cleanup) {
                try { await dbRun(sql, params); } catch (e) { /* table may not exist */ }
            }
            emailBody = `Your account has been permanently deleted from our records.`;
        }

        if (user.email) {
            const html = `
                <div style="font-family: sans-serif; padding: 20px; color: #333; border: 1px solid #da020e; border-radius: 12px; max-width: 500px; margin: auto;">
                    <h2 style="color: #da020e; border-bottom: 2px solid #da020e; padding-bottom: 10px;">PolySoko Update</h2>
                    <p>Hello <b>${user.name}</b>,</p>
                    <p>${emailBody}</p>
                    ${effectiveReason ? `<div style="background: #f9f9f9; padding: 15px; border-radius: 8px; border-left: 4px solid #da020e; margin: 20px 0;"><strong>Administrative Reason:</strong><br><span style="font-style: italic; color: #555;">${effectiveReason}</span></div>` : ''}
                    <p style="font-size: 0.8rem; color: #777; margin-top: 20px;">If you believe this was a mistake, please contact our support desk.</p>
                    <p><b>Soko ni Soko.</b></p>
                </div>`;
            // Isolated on purpose: the database change has already been committed at
            // this point, so a mail transport failure must not turn a successful
            // delete into a 500. That previously made admins think the delete had
            // failed and repeat it.
            try {
                await sendPolyMail(user.email, subject, html);
            } catch (mailErr) {
                console.error('Post-action notification email failed:', mailErr.message);
            }
        }

        res.json({ success: true, message: action === 'delete' ? 'Account deleted.' : 'Action completed.' });
    } catch (e) { console.error('Admin users manage error:', e); res.status(500).json({ success: false }); }
});

app.get('/api/admin/users/:phone/details', authenticateAdmin, async (req, res) => {
    const norm = normalizePhone(req.params.phone);
    try {
        const user = await dbGet("SELECT name, phone, email, balance, is_upgraded, is_suspended, suspension_expires, upgrade_expiry, referral_code FROM users WHERE phone=?", [norm]);
        const activity = await dbGet(`
            SELECT 
                (SELECT COUNT(*) FROM bets WHERE user_phone=?) as totalBets,
                (SELECT SUM(amount) FROM transactions WHERE user_phone=? AND type='deposit' AND status='completed') as deposits,
                (SELECT SUM(ABS(amount)) FROM transactions WHERE user_phone=? AND type='withdraw' AND status='completed') as withdrawals
            `, [norm, norm, norm]);
        res.json({ success: true, user, stats: activity });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/test-balance/:phone', (req, res) => {
    const phone = normalizePhone(req.params.phone);
    emitBalance(phone);
    res.send("Balance emit triggered");
});
// --- SOCKET AUTH MIDDLEWARE ---
io.use((socket, next) => {
    // The handshake can arrive while the signing secret is still being loaded
    // from the database, so verification waits for it to settle. A brand-new
    // socket is cheap to retry; a rejected one forces the client to reconnect.
    jwtSecretReady.then(() => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error("No token provided"));

            const decoded = verifyJwt(token);
            socket.user = { phone: normalizePhone(decoded.phone) };
            next();
        } catch (err) {
            console.error("Ã¢ÂÅ’ Socket Auth Failed:", err.message);
            next(new Error("Auth Error"));
        }
    }).catch(() => next(new Error("Auth Error")));
});
io.on('connection', (socket) => {
    if (!socket.user?.phone) return socket.disconnect();

    const userRoom = socket.user.phone;
    socket.join(userRoom);

    socket.on("adminJoin", () => {
        socket.join("adminRoom");
    });

    socket.on('requestInitialData', () => {
        try {
            emitBalance(userRoom);
            emitMarkets();
        } catch (e) {
            console.error("Socket init error:", e.message);
        }
    });
});

// Backend: server.js
// server.js
app.get('/api/football/details/:id', async (req, res) => {
    try {
        const fixtureId = req.params.id.replace('fb_', '');
        const apiKey = API_SPORTS_KEY; 
        if (!apiKey) return res.status(500).json({ error: "Sports API key is not configured" }); 
        const config = { headers: { 'x-apisports-key': apiKey } };

        const [stats, lineups, events, predictions] = await Promise.all([
            axios.get(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`, config),
            axios.get(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`, config).catch(() => ({ data: { response: [] } })),
            axios.get(`https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`, config),
            axios.get(`https://v3.football.api-sports.io/predictions?fixture=${fixtureId}`, config)
        ]);

        const lineupsData = lineups.data.response || [];
        const teamA = lineupsData[0]?.team?.name || '';
        const teamB = lineupsData[1]?.team?.name || '';
        const query = createMatchNewsQuery(teamA, teamB);
        let relatedNews = [];

        if (process.env.NEWS_API_KEY && query) {
            try {
                const newsRes = await axios.get(`https://newsapi.org/v2/everything`, {
                    params: {
                        q: query,
                        language: 'en',
                        pageSize: 5,
                        sortBy: 'publishedAt',
                        apiKey: process.env.NEWS_API_KEY
                    }
                });
                relatedNews = (newsRes.data.articles || []).map((article) => ({
                    title: article.title,
                    description: article.description,
                    source: article.source?.name,
                    url: article.url,
                    image: article.urlToImage
                }));
            } catch (newsError) {
                console.warn('Ã¢Å¡Â Ã¯Â¸Â Match news fetch failed:', newsError.response?.data || newsError.message);
            }
        }

        // Persist any related news from the football API into the markets table
        if (Array.isArray(relatedNews) && relatedNews.length) {
            for (const article of relatedNews) {
                try {
                    const rawHeadline = String(article.title || '').trim();
                    const hash = crypto.createHash('md5').update(rawHeadline + fixtureId).digest('hex');
                    const content = article.description || rawHeadline;

                    const newsMarket = buildNewsMarket({
                        id: `news_${hash}`,
                        title: rawHeadline,
                        description: content,
                        content,
                        media_url: article.image || null,
                        media_type: 'image',
                        category: 'news',
                        country: article.source || 'API-FOOTBALL',
                        startTime: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
                        status: 'open',
                        url: article.url || article.url || null
                    });

                    await dbRun(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'YES', 'NO', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, media_type=excluded.media_type, startTime=excluded.startTime, status=excluded.status, url=excluded.url, timestamp=CURRENT_TIMESTAMP`,
                        [newsMarket.id, newsMarket.title, newsMarket.description, newsMarket.content, newsMarket.media_url, newsMarket.media_type, newsMarket.category, newsMarket.country, newsMarket.startTime, newsMarket.status, newsMarket.url]);
                } catch (e) {
                    console.warn('Failed to persist related match news:', e.message);
                }
            }
        }

        res.json({
            stats: stats.data.response || [],
            lineups: lineupsData,
            events: events.data.response || [],
            predictions: predictions.data.response || [],
            relatedNews
        });
    } catch (error) {
        console.error("Ã¢ÂÅ’ API-Football Error:", error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: "Failed to fetch match details" });
    }
});
app.get('/api/news/everything', async (req, res) => {
    try {
        const force = req.query.refresh === '1' || req.query.refresh === 'true';
        const processedMarkets = await syncNewsApiMarkets({ force, limit: 120 });
        emitMarkets();
        res.json({ articles: processedMarkets });
    } catch (error) {
        console.error("Ã¢ÂÅ’ Aggregator Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to scrape the global grid." });
    }
});

function buildNewsMarket(market) {
    const processed = { ...market };
    processed.category = (processed.category || 'news').toLowerCase();
    const rawTitle = String(processed.title || processed.description || '').trim();
    const cleanHeadline = rawTitle.replace(/\s+-\s+[^-]+$/, '').replace(/\s+/g, ' ').trim();
    const displayHeadline = buildNewsQuestion(cleanHeadline);
    processed.displayHeadline = cleanHeadline;
    processed.title = displayHeadline;
    processed.betQuestion = displayHeadline;
    processed.persona_script = processed.persona_script || buildPersonaInsight(displayHeadline);
    processed.sideA = processed.sideA || 'YES';
    processed.sideB = processed.sideB || 'NO';
    processed.status = processed.status || 'open';
    return processed;
}

function extractContentField(content, fieldName) {
    const pattern = new RegExp(`^${fieldName}:\\s*(.+)$`, 'im');
    return String(content || '').match(pattern)?.[1]?.trim() || '';
}

function rebuildTmdbHeadlineFromRow(row) {
    if (!String(row.id || '').startsWith('tmdb_')) return '';

    const title = extractContentField(row.content, 'Title');
    if (!title) return '';

    const oldTitle = String(row.title || '');
    if (/trending/i.test(oldTitle)) return `${title} is trending on TMDB right now`;
    if (/upcoming|released as scheduled/i.test(oldTitle)) return `${title} is an upcoming TMDB release`;
    if (/most popular|TMDBs most|\bis one\b/i.test(oldTitle)) return `${title} is one of TMDB's most popular titles`;
    if (/top[- ]rated|top rated|\bis a top\b|\bis top\b/i.test(oldTitle)) return `${title} is a top rated TMDB title`;
    if (/award/i.test(oldTitle)) return `${title} is getting award attention on TMDB`;
    if (/featured/i.test(oldTitle)) return `${title} is featured on TMDB`;

    return '';
}

function rebuildGeneratedNewsHeadlineFromRow(row) {
    const id = String(row.id || '');
    if (!/^(news_|tech_|geo_)/i.test(id)) return '';

    const title = String(row.title || '').trim();
    const needsRepair = !/\?$/.test(title) ||
        /^Will it be confirmed that\b/i.test(title) ||
        /^Will the report that\b/i.test(title) ||
        /^Will this report about\b/i.test(title) ||
        /^Will this story be confirmed\?$/i.test(title);
    if (!needsRepair) return '';

    const source = String(row.description || row.content || title || '')
        .replace(/\s+-\s+[^-]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!source || source.length < 12) return '';
    return source;
}

async function repairGeneratedMarketTitles() {
    try {
        const rows = await dbAll(
            `SELECT id, title, description, content
             FROM markets
             WHERE status IN ('open','live','upcoming','pending')
               AND (
                    id LIKE 'tmdb_%'
                    OR id LIKE 'news_%'
                    OR id LIKE 'tech_%'
                    OR id LIKE 'geo_%'
                    OR title LIKE 'Will %'
                    OR (
                        title NOT LIKE '%?'
                        AND category NOT IN ('sports')
                        AND id NOT LIKE 'fb_%'
                        AND id NOT LIKE 'sp_%'
                    )
               )`
        );

        let repaired = 0;
        for (const row of rows) {
            const headline = rebuildTmdbHeadlineFromRow(row) || rebuildGeneratedNewsHeadlineFromRow(row);
            const repairedTitle = headline
                ? buildNewsQuestion(headline)
                : /^Will\b/i.test(String(row.title || ''))
                    ? polishMarketTitle(row.title)
                    : buildNewsQuestion(row.title);
            if (!repairedTitle || repairedTitle === row.title) continue;

            await dbRun(`UPDATE markets SET title=? WHERE id=?`, [repairedTitle, row.id]);
            repaired += 1;
        }

        if (repaired) console.log(`Repaired ${repaired} generated market titles.`);
    } catch (e) {
        console.error('Generated market title repair failed:', e.message);
    }
}
app.get('/api/admin/market-pnl/:id', authenticateAdmin, async (req, res) => {
    const marketId = req.params.id;

    const bets = await dbAll(
        `SELECT amount, odds, side, status, settled_amount FROM transactions WHERE market_id=? AND type='bet'`,
        [marketId]
    );

    let totalStake = 0;
    let totalPayout = 0;

    bets.forEach(bet => {
        totalStake += bet.amount;
        if (bet.status === 'won') {
            totalPayout += (bet.settled_amount || 0);
        }
    });

    res.json({
        totalStake,
        totalPayout,
        profit: totalStake - totalPayout
    });
});
app.use(express.static(publicPath, staticOptions));

app.get('/login', (req, res) => {
    res.sendFile(path.join(publicPath, 'login.html'));
});

app.get(/^\/([A-Za-z0-9_-]+)$/, (req, res, next) => {
    const page = req.params[0];
    const htmlFile = path.join(publicPath, `${page}.html`);
    if (!htmlFile.startsWith(publicPath)) return next();
    if (fs.existsSync(htmlFile)) return res.sendFile(htmlFile);
    return next();
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: "API route not found" });
});

app.use((req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});
async function sendPolysokoPush(phoneNumber, amount, mpesaId, txnId) {
    const message = `Polysoko: Confirmed! We have received sKES ${amount}. Transaction ID: ${txnId}, M-Pesa ID: ${mpesaId}. Your Soko Shilling balance has been updated.`;

    try {
        // Formats phone to +254...
        const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

        const result = await sendSms({
            to: [formattedPhone],
            message: message,
            // If you don't have a registered Sender ID yet, comment out the line below
            // from: "POLYSOKO" 
        });

        console.log(`Ã¢Å“â€¦ Real SMS Sent to ${phoneNumber}:`, result.SMSMessageData.Recipients[0].status);
    } catch (error) {
        console.error("Ã¢ÂÅ’ Africa's Talking Error:", error);
    }
}
// --- STARTUP ---
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. PolySoko is probably already running; stop that process before starting another one.`);
        process.exit(1);
    }

    throw err;
});
// --- FORCE SEND VERIFICATION FOR LEGACY USERS ---
const forceVerifyLegacyUsers = async () => {
    const legacyUsers = await dbAll("SELECT id, name, email FROM users WHERE status = 'unverified' AND verification_token IS NULL");
    if (legacyUsers.length === 0) return;
    
    console.log(`Ã°Å¸â€œÂ§ Sending legacy verification to ${legacyUsers.length} users...`);
    for (const user of legacyUsers) {
        const token = crypto.randomBytes(32).toString('hex');
        await dbRun("UPDATE users SET verification_token = ? WHERE id = ?", [token, user.id]);
        const verifyLink = `${verificationUrl(token)}`;
        sendPolyMail(user.email, "PolySoko Account Access", 
            `<p>Hello ${user.name || 'there'},</p>
             <p>Please verify your account to unlock your referral code.</p>
             <p><a href="${verifyLink}" style="display:inline-block;padding:12px 18px;background:#00ff88;color:#020405;text-decoration:none;border-radius:8px;font-weight:bold;">Verify Now</a></p>
             <p>If the button does not open, paste this link into your browser:<br><span style="word-break:break-all;">${verifyLink}</span></p>`);
    }
};

// Optional: If `AUTO_KILL_PORT` is set, attempt to free the port before starting (Windows only).
const tryAutoKillPort = async () => {
    if (!process.env.AUTO_KILL_PORT) return;
    if (process.platform !== 'win32') return;
    try {
        const cmd = `netstat -ano | findstr :${PORT}`;
        exec(cmd, (err, stdout) => {
            if (err || !stdout) return;
            const lines = stdout.trim().split(/\r?\n/);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== process.pid.toString()) {
                    console.log(`AUTO_KILL_PORT: killing PID ${pid} that listens on port ${PORT}`);
                    exec(`taskkill /PID ${pid} /F`, (killErr, killOut) => {
                        if (killErr) console.error('Failed to kill PID', pid, killErr.message);
                        else console.log('Killed PID', pid);
                    });
                }
            }
        });
    } catch (e) { console.error('AUTO_KILL_PORT failed:', e.message); }
};

// Startup housekeeping must never take the HTTP server down with it. Each step is
// isolated so a single failing query cannot crash the process (which previously
// produced an unhandled rejection and took the whole container offline).
const runSafely = (label, task) => {
    Promise.resolve()
        .then(task)
        .catch(err => console.error(`Startup task "${label}" failed (continuing):`, err.message));
};

const startServer = async () => {
    await tryAutoKillPort();

    // Bind the port FIRST, before any database work.
    // Railway (and most PaaS routers) fail the deployment with a 502 if the
    // process is not accepting connections within the startup window. The schema
    // repair below talks to Postgres, so any connection failure or slow query
    // used to reject here and kill the process *before* it ever listened.
    // Schema repairs run after the socket is open and must never be able to
    // prevent the API from coming up. Failures are logged and retried on the
    // next deploy rather than crashing the service.
    const runStartupRepairs = async () => {
        try {
            await repairSportsMarketMetadata();
            await repairGeneratedMarketTitles();
        } catch (err) {
            console.error('Startup schema repair failed (serving anyway):', err.message);
        }
    };

    server.listen(PORT, '0.0.0.0', async () => {
        console.log(`Ã°Å¸Å¡â‚¬ Terminal Online on Port ${PORT}`);
        // Socket is already accepting connections; safe to touch the DB now.
        runStartupRepairs();
        const skipStartupSync = process.env.SKIP_STARTUP_SYNC === '1' || process.env.SKIP_STARTUP_SYNC === 'true';
        // Every background/startup job is wrapped so a transient failure cannot
        // reject unhandled and terminate the Node process on Railway.
        if (!skipStartupSync) {
            runSafely('fixMissingMarketTimes', fixMissingMarketTimes);
            runSafely('cleanupOutdatedMarkets', cleanupOutdatedMarkets);
            runSafely('syncAllMarkets', syncAllMarkets);
            runSafely('syncFootballMarkets', syncFootballMarkets);
            runSafely('syncSportsMarkets', syncSportsMarkets);
            runSafely('syncFootballNews', syncFootballNews);
            runSafely('refreshBoostedMarkets', refreshBoostedMarkets);
            runSafely('runSettlementEngine', runSettlementEngine);
            runSafely('syncWeatherMarkets', syncWeatherMarkets);
            setInterval(syncAllMarkets, 3600000);
            setInterval(syncFootballMarkets, 3600000);
            setInterval(syncSportsMarkets, 3600000);
            setInterval(syncFootballNews, 7200000); // every 2 hours
            setInterval(refreshBoostedMarkets, 86400000);
            setInterval(syncWeatherMarkets, 86400000);
            setInterval(cleanupOutdatedMarkets, 3600000);
            setInterval(sendDailyMarkets, 86400000);
            setInterval(() => {
                runSettlementEngine().catch(e => console.error("Settlement engine failed:", e.message));
            }, 3600000);
        } else {
            console.log('SKIP_STARTUP_SYNC enabled; background market sync is disabled for this run.');
        }
        runSafely('forceVerifyLegacyUsers', forceVerifyLegacyUsers);
        if (process.env.EXIT_AFTER_STARTUP === '1' || process.env.EXIT_AFTER_STARTUP === 'true') {
            console.log('EXIT_AFTER_STARTUP set Ã¢â‚¬â€ exiting process so you can run in VS Code.');
            setTimeout(() => process.exit(0), 250);
        }
    });
};

// --- GRACEFUL SHUTDOWN ---
// Railway (and most container platforms) send SIGTERM before restarting or
// redeploying a service. Without a handler Node kills the process immediately,
// which can sever in-flight requests and leak the PostgreSQL connection pool.
// Close the HTTP server, Socket.io and the database cleanly, then exit.
let isShuttingDown = false;
const gracefulShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received - shutting down gracefully...`);

    // Force-exit if a hung connection prevents a clean close.
    const forceExitTimer = setTimeout(() => {
        console.error('Graceful shutdown timed out; forcing exit.');
        process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    const finish = () => {
        clearTimeout(forceExitTimer);
        console.log('Shutdown complete.');
        process.exit(0);
    };

    // Socket.io wraps the HTTP server; closing it first releases live connections.
    try {
        io.close(() => {
            try { server.close(finish); } catch (err) { console.error('server.close failed:', err.message); finish(); }
        });
    } catch (err) {
        console.error('io.close failed:', err.message);
        try { server.close(finish); } catch (e) { finish(); }
    }

    // Close the DB handle. `db.close` exists for both the sqlite3 driver and the
    // PostgreSQL compatibility wrapper (which resolves its pool via pool.end()).
    try {
        if (db && typeof db.close === 'function') {
            db.close(() => console.log('Database connection closed.'));
        }
    } catch (err) {
        console.error('db.close failed:', err.message);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer().catch(e => {
    console.error('Server startup failed:', e);
    process.exit(1);
});
