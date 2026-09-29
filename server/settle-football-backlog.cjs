const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
if (!FOOTBALL_API_KEY) {
  console.error('Missing FOOTBALL_API_KEY in PS/server/.env');
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, 'terminal.db'));

function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}
function run(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    })
  );
}

async function resolveFixtureResult(marketId) {
  const fixtureId = String(marketId).startsWith('fb_') ? String(marketId).slice(3) : null;
  if (!fixtureId) return null;

  const resp = await axios.get('https://v3.football.api-sports.io/fixtures', {
    params: { id: fixtureId, timezone: 'Africa/Nairobi' },
    headers: { 'x-apisports-key': FOOTBALL_API_KEY },
    timeout: 20000
  });
  const fixture = resp.data?.response?.[0];
  if (!fixture) return null;

  const short = String(fixture.fixture?.status?.short || '').toUpperCase();
  if (!['FT', 'AET', 'PEN'].includes(short)) return null;

  const hg = Number(fixture.goals?.home);
  const ag = Number(fixture.goals?.away);
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;

  if (hg > ag) return 'HOME';
  if (ag > hg) return 'AWAY';
  return 'DRAW';
}

async function cancelMarket(marketId, reason = 'DRAW') {
  const bets = await all(
    `SELECT * FROM transactions WHERE market_id=? AND type='bet' AND status='active'`,
    [marketId]
  );
  await run('BEGIN TRANSACTION');
  try {
    for (const bet of bets) {
      const refund = Number(Number(bet.amount || 0).toFixed(2));
      if (refund > 0) await run(`UPDATE users SET balance = balance + ? WHERE phone=?`, [refund, bet.user_phone]);
      await run(`UPDATE transactions SET status='cancelled', settled_amount=? WHERE id=?`, [refund, bet.id]);
      await run(
        `UPDATE bets SET status='cancelled' WHERE market_id=? AND user_phone=? AND status='active'`,
        [marketId, bet.user_phone]
      );
    }
    await run(`UPDATE markets SET status='cancelled', result=?, settled=1 WHERE id=?`, [String(reason).toUpperCase(), marketId]);
    await run('COMMIT');
    return { cancelled: bets.length };
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

async function settleMarket(marketId, winningSide) {
  const bets = await all(
    `SELECT * FROM transactions WHERE market_id=? AND type='bet' AND status='active'`,
    [marketId]
  );
  await run('BEGIN TRANSACTION');
  try {
    for (const bet of bets) {
      const isWinner = String(bet.side || '').toUpperCase() === String(winningSide || '').toUpperCase();
      if (isWinner) {
        const payout = Number((Number(bet.amount || 0) * Number(bet.odds || 0)).toFixed(2));
        await run(`UPDATE users SET balance = balance + ? WHERE phone=?`, [payout, bet.user_phone]);
        await run(`UPDATE transactions SET status='won', settled_amount=? WHERE id=?`, [payout, bet.id]);
        await run(
          `UPDATE bets SET status='won' WHERE market_id=? AND user_phone=? AND status='active'`,
          [marketId, bet.user_phone]
        );
      } else {
        await run(`UPDATE transactions SET status='lost', settled_amount=0 WHERE id=?`, [bet.id]);
        await run(
          `UPDATE bets SET status='lost' WHERE market_id=? AND user_phone=? AND status='active'`,
          [marketId, bet.user_phone]
        );
      }
    }
    await run(`UPDATE markets SET status='settled', result=?, settled=1 WHERE id=?`, [String(winningSide).toUpperCase(), marketId]);
    await run('COMMIT');
    return { settled: bets.length };
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

(async () => {
  const candidates = await all(
    `
    SELECT DISTINCT t.market_id AS market_id
    FROM transactions t
    JOIN markets m ON m.id = t.market_id
    WHERE t.type='bet'
      AND t.status='active'
      AND m.category='football'
      AND m.status='closed'
      AND m.settled=0
    `,
    []
  );

  console.log(`Found ${candidates.length} football markets with active bets to settle...`);

  let settledMarkets = 0;
  let cancelledMarkets = 0;

  for (const { market_id } of candidates) {
    try {
      const result = await resolveFixtureResult(market_id);
      if (!result) continue;
      if (result === 'DRAW') {
        await cancelMarket(market_id, 'DRAW');
        cancelledMarkets++;
      } else {
        await settleMarket(market_id, result);
        settledMarkets++;
      }
    } catch (e) {
      console.warn(`Failed settling ${market_id}:`, e.message);
    }
  }

  const after = await get(`SELECT COUNT(*) AS c FROM transactions WHERE type='bet' AND status='active'`);
  console.log(
    JSON.stringify(
      {
        settled_markets: settledMarkets,
        cancelled_markets: cancelledMarkets,
        remaining_active_bet_transactions: after?.c || 0
      },
      null,
      2
    )
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.close());

