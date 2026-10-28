// Serverless entry (Netlify Functions, AWS Lambda): the same Express app behind serverless-http.
// The app and its database pool are created once per warm instance and reused across requests.
import serverless from 'serverless-http';
import { connectLambda } from '@netlify/blobs';
import { createApp } from './app.js';
import { openPg } from './pg.js';
import { migrate } from './schema.js';

export function createHandler(opts = {}) {
  let ready = null;
  const init = async () => {
    const db = opts.db || openPg(process.env.DATABASE_URL, { max: Number(process.env.PG_POOL_MAX || 3) });
    await migrate(db);
    const { app } = await createApp({ serveStatic: false, ...opts, db });
    return serverless(app, {
      binary: ['image/*', 'application/gzip'], // pictures and database backups (/admin)
      // serverless-http fills req.headers but not req.rawHeaders; the MCP SDK builds its Web Request
      // from rawHeaders, so without this every MCP call loses its Content-Type and gets a 415
      request(req) {
        if (!req.rawHeaders?.length) {
          req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x) => [k, String(x)]) : [k, String(v)]));
        }
      },
    });
  };
  return async (event, context) => {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    // launchpad pictures live in Netlify Blobs: each invocation brings its access
    if (event?.blobs) connectLambda(event);
    ready ??= init().catch((e) => { ready = null; throw e; });
    const handle = await ready;
    return handle(event, context);
  };
}
