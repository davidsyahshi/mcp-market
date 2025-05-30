// Finds the project root (the folder with collection/collection.json) both when running from the repo
// and inside a serverless bundle. Netlify may bundle this file to CommonJS, where import.meta is empty,
// so the module's own location is optional and the task root / cwd are tried too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function moduleDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

export function findRoot() {
  const here = moduleDir();
  const candidates = [
    process.env.MCP_ROOT,
    here && path.resolve(here, '..', '..'),
    process.env.LAMBDA_TASK_ROOT,
    process.cwd(),
    '/var/task',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'collection', 'collection.json'))) return c;
  }
  throw new Error(`collection/collection.json not found (looked in ${candidates.join(', ')})`);
}
