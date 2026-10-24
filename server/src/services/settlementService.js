/**
 * Start a guarded periodic settlement sweep. The caller owns settlement rules
 * and database access; this service schedules sweeps and prevents overlap.
 */
export function startSettlementWorker(worker, { intervalMs = 10 * 60 * 1000 } = {}) {
    if (typeof worker !== 'function') throw new TypeError('Settlement worker must be a function');
    let running = false;

    const run = async () => {
        if (running) {
            console.warn('[settlement worker] Previous sweep is still running; skipping this tick.');
            return;
        }
        running = true;
        console.log('\u{1F504} Checking pending market settlements...');
        try {
            await worker();
        } catch (error) {
            console.error('[settlement worker] Sweep failed:', error?.stack || error);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => { void run(); }, intervalMs);
    timer.unref?.();
    void run();
    return () => clearInterval(timer);
}
