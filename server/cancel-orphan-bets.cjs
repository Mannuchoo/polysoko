const { createPool, toPg } = require('./db');

const pool = createPool();

function all(sql, params = []) {
  return pool.query(toPg(sql), params).then((r) => r.rows);
}
function run(sql, params = []) {
  return pool.query(toPg(sql), params);
}
function get(sql, params = []) {
  return pool.query(toPg(sql), params).then((r) => r.rows[0]);
}

(async () => {
  const orphans = await all(
    `
    SELECT t.id, t.user_phone, t.amount, t.market_id
    FROM transactions t
    LEFT JOIN markets m ON m.id = t.market_id
    WHERE t.type='bet' AND t.status='active' AND m.id IS NULL
    `,
    []
  );

  console.log(`Found ${orphans.length} orphan active bet transactions...`);
  if (!orphans.length) return;

  await run('BEGIN');
  try {
    for (const bet of orphans) {
      const refund = Number(Number(bet.amount || 0).toFixed(2));
      if (refund > 0) await run(`UPDATE users SET balance = balance + ? WHERE phone=?`, [refund, bet.user_phone]);
      await run(`UPDATE transactions SET status='cancelled', settled_amount=? WHERE id=?`, [refund, bet.id]);
      await run(`UPDATE bets SET status='cancelled' WHERE market_id=? AND user_phone=? AND status='active'`, [
        bet.market_id,
        bet.user_phone
      ]);
    }
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }

  const after = await get(`SELECT COUNT(*) AS c FROM transactions WHERE type='bet' AND status='active'`);
  console.log(`Remaining active bet transactions: ${after?.c || 0}`);
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
