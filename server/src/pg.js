// Postgres over the network (Supabase in production). On serverless hosts use Supabase's transaction
// pooler (port 6543): each function instance keeps only a few connections.
import pg from 'pg';

export function openPg(url, { max = Number(process.env.PG_POOL_MAX || 5) } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // an idle connection dropped by the pooler must not crash the process
  pool.on('error', (e) => console.error('pg pool error:', e.message));

  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    // every money-moving operation runs inside one transaction on one connection
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const out = await fn({
          query: async (t, p) => (await c.query(t, p)).rows,
          exec: async (sql) => { await c.query(sql); },
        });
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    exec: async (sql) => { await pool.query(sql); },
    close: () => pool.end(),
  };
}
