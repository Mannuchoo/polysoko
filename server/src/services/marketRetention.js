const RETENTION_DAYS = 10;

export async function deleteSettledMarketsOlderThan(dbRun) {
  if (typeof dbRun !== 'function') throw new Error('Market database writer is required.');
  return dbRun(
    `DELETE FROM markets
     WHERE COALESCE(settled,0)=1
       AND COALESCE(settled_at, timestamp) < NOW() - (? * INTERVAL '1 day')`,
    [RETENTION_DAYS]
  );
}

export { RETENTION_DAYS };
