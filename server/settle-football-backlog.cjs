const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { createPool, toPg } = require('./db');

dotenv.config({ path: path.join(__dirname, '.env') });

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
if (!FOOTBALL_API_KEY) {
  console.error('Missing FOOTBALL_API_KEY in server/.env');
  process.exit(1);
}

const pool = createPool();

function all(sql, params = []) {
  return pool.query(toPg(sql), params).then((r) => r.rows);
}
function get(sql, params = []) {
  return pool.query(toPg(sql), params).then((r) => r.rows[0]);
}
function run(sql, params = []) {
  return pool.query(toPg(sql), params);
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

// Resolves a client-supplied side to one of the three canonical side keys.
// The pick stored on a bet is the market's own label (a team name), so an
// exact string comparison against "HOME" would never match.
function resolveSideKey(rawSide, market = {}) {
  const value = String(rawSide || '').trim();
  if (!value) return null;
  const upper = value.toUpperCase();

  if (upper === 'DRAW') return 'DRAW';
  if (upper === 'HOME' || upper === 'YES') return 'HOME';
  if (upper === 'AWAY' || upper === 'NO') return 'AWAY';

  const needle = value.toLowerCase();
  const sideA = String(market.sideA || '').trim().toLowerCase();
  const sideB = String(market.sideB || '').trim().toLowerCase();
  const sideC = String(market.sideC || '').trim().toLowerCase();
  if (sideA && needle === sideA) return 'HOME';
  if (sideC && needle === sideC) return 'DRAW';
  if (sideB && needle === sideB) return 'AWAY';
  return null;
}

// A binary market settles on the label its own sides carry (YES/NO on a news
// market, LIKELY/UNLIKELY on a politics one). 'HOME'/'YES' name the first
// outcome and 'AWAY'/'NO' the second, so a bet recorded under one name still
// wins when the market settles on the other.
function isWinningBinarySide(betSide, winningSide, market = {}) {
  const bet = String(betSide || '').trim().toUpperCase();
  const winner = String(winningSide || '').trim().toUpperCase();
  if (!bet || !winner) return false;

  const sideA = String(market.sideA || 'YES').trim().toUpperCase();
  const sideB = String(market.sideB || 'NO').trim().toUpperCase();

  if (bet === winner) return true;

  const winnerIsA = winner === sideA || winner === 'HOME' || winner === 'YES';
  const winnerIsB = winner === sideB || winner === 'AWAY' || winner === 'NO';
  const betIsA = bet === sideA || bet === 'HOME' || bet === 'YES';
  const betIsB = bet === sideB || bet === 'AWAY' || bet === 'NO';

  return (winnerIsA && betIsA) || (winnerIsB && betIsB);
}

function supportsDraw(market) {
  const label = String(market?.sideC || '').trim();
  const odds = Number(market?.oddsC || 0);
  return Boolean(label) && Number.isFinite(odds) && odds > 1;
}

async function cancelMarket(marketId, reason = 'DRAW') {
  const bets = await all(
    `SELECT * FROM transactions WHERE market_id=? AND type='bet' AND status='active'`,
    [marketId]
  );
  await run('BEGIN');
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
  const market = await get(`SELECT sideA, sideB, sideC, oddsC FROM markets WHERE id=?`, [marketId]) || {};
  const bets = await all(
    `SELECT * FROM transactions WHERE market_id=? AND type='bet' AND status='active'`,
    [marketId]
  );
  const winner = String(winningSide || '').trim().toUpperCase();

  // A market that offers a draw settles the draw bets; one that does not has
  // no outcome to pay, so its stakes are refunded instead.
  if (winner === 'DRAW' && !supportsDraw(market)) {
    return cancelMarket(marketId, 'DRAW');
  }

  await run('BEGIN');
  try {
    for (const bet of bets) {
      // A three-way market settles on one of its canonical keys; a binary
      // market settles on the label its own sides carry.
      const picked = supportsDraw(market)
        ? resolveSideKey(bet.side, market)
        : (isWinningBinarySide(bet.side, winner, market) ? winner : null);
      const isWinner = Boolean(picked) && picked === winner;
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
    await run(`UPDATE markets SET status='settled', result=?, settled=1 WHERE id=?`, [winner, marketId]);
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
      AND (m.category IN ('football','sports') OR m.id LIKE 'fb\\_%' ESCAPE '\\' OR m.country='Football')
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
      // settleMarket settles the draw bets on a market that offers a draw and
      // refunds the market when it does not, so the draw needs no special case.
      const outcome = await settleMarket(market_id, result);
      if (outcome && outcome.cancelled) cancelledMarkets++;
      else settledMarkets++;
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
        remaining_active_bet_transactions: Number(after?.c || 0)
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
  .finally(() => pool.end());
