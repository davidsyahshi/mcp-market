// Database for local runs and tests: DATABASE_URL if set, otherwise an embedded Postgres (PGlite)
// stored in PGLITE_DIR (or in memory). The serverless function imports pg.js directly instead,
// so PGlite never ends up in the deployed bundle.
import { openPg } from './pg.js';
import { migrate } from './schema.js';

export async function openDb({ url = process.env.DATABASE_URL, dir = process.env.PGLITE_DIR } = {}) {
  let db;
  if (url) {
    db = openPg(url);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const pgl = new PGlite(dir || undefined);
    let chain = Promise.resolve();
    // PGlite is a single connection: serialize transactions so they never interleave
    const serial = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    };
    db = {
      query: async (text, params) => (await pgl.query(text, params)).rows,
      tx: (fn) => serial(() => pgl.transaction(async (t) => fn({
        query: async (q, p) => (await t.query(q, p)).rows,
        exec: async (sql) => { await t.exec(sql); },
      }))),
      exec: async (sql) => { await pgl.exec(sql); },
      close: () => pgl.close(),
    };
  }
  await migrate(db);
  return db;
}
