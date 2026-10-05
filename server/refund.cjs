const { createPool, toPg } = require('./db');

const pool = createPool();

console.log('Connected to Postgres.');

(async () => {
  const userPhone = '254740650864';
  const totalRefund = 100000;

  // Check if the table actually exists first
  const table = await pool.query(`SELECT to_regclass('public.users') AS name`).then((r) => r.rows[0]);
  if (!table || !table.name) {
    console.error("ERROR: Could not find 'users' table in Postgres.");
    process.exit(1);
  }

  // Update the balance
  await pool.query(toPg(`UPDATE users SET balance = balance + ? WHERE phone = ?`), [totalRefund, userPhone]);
  console.log(`Success: ${totalRefund} SokoShillings restored to ${userPhone}.`);

  // Log the refund
  const refundNote = 'REFUND_MAIL_FAIL';
  await pool.query(
    toPg(`INSERT INTO transactions (user_phone, type, amount, status, reference)
                VALUES (?, 'refund', 200, 'completed', ?)`),
    [userPhone, `${refundNote}_1_${Date.now()}`]
  );

  await pool.query(
    toPg(`INSERT INTO transactions (user_phone, type, amount, status, reference)
                VALUES (?, 'refund', 200, 'completed', ?)`),
    [userPhone, `${refundNote}_2_${Date.now()}`]
  );
  console.log('Two refund entries added to history.');
})()
  .catch((err) => {
    console.error('Refund failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
