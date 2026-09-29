const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./terminal.db');

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

(async () => {
  try {
    const activeTx = await get(`SELECT COUNT(*) AS c FROM transactions WHERE type='bet' AND status='active'`);
    const activeBets = await get(`SELECT COUNT(*) AS c FROM bets WHERE status='active'`);
    const unsettledMarkets = await get(`SELECT COUNT(*) AS c FROM markets WHERE settled=0`);
    const footballClosedUnresolved = await get(
      `SELECT COUNT(*) AS c FROM markets WHERE category='football' AND status='closed' AND settled=0 AND (result IS NULL OR TRIM(result)='')`
    );
    console.log(JSON.stringify({
      active_transactions_bets: activeTx?.c || 0,
      active_bets: activeBets?.c || 0,
      unsettled_markets: unsettledMarkets?.c || 0,
      football_closed_unresolved: footballClosedUnresolved?.c || 0
    }, null, 2));

    const activeSample = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          t.id AS tx_id,
          t.user_phone,
          t.market_id,
          t.side,
          t.amount,
          t.odds,
          m.category,
          m.status AS market_status,
          m.result,
          m.settled
        FROM transactions t
        LEFT JOIN markets m ON m.id = t.market_id
        WHERE t.type='bet' AND t.status='active'
        ORDER BY t.id DESC
        LIMIT 20
        `,
        [],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    console.log('active_bets_sample', JSON.stringify(activeSample, null, 2));
  } finally {
    db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

