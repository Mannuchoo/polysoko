const { createPool, toPg } = require('./db');

const pool = createPool();

console.log('Connected to Postgres.');

// CONFIGURATION
const myPhone = "254748022271"; // <--- Replace with your actual phone number
const refundAmount = 300000;     // <--- Amount to add back (e.g., 3 bets * 100 KES)

(async () => {
  // Update the balance by adding the refund amount to the current balance
  const res = await pool.query(toPg('UPDATE users SET balance = balance + ? WHERE phone = ?'), [refundAmount, myPhone]);
  if (res.rowCount === 0) {
    console.log("No user found with that phone number. Check your Postgres user table.");
  } else {
    console.log(`Success! KES ${refundAmount} has been added back to ${myPhone}.`);

    // Verify the new balance
    const row = await pool.query(toPg('SELECT phone, balance FROM users WHERE phone = ?'), [myPhone]).then((r) => r.rows[0]);
    if (row) console.log(`New Balance: KES ${row.balance}`);
  }
})()
  .catch((err) => console.error('Refund failed:', err.message))
  .finally(() => pool.end());
