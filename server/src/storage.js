// Pictures of launchpad collections (the market's own collection ships with the site, see assets.js).
// On Netlify: Netlify Blobs, store "nft-pictures" (the function connects to it per request, lambda.js).
// Locally: a folder (BLOB_DIR, default ./data/blobs). In tests: memory.
// Keys: c<collection id>/img/<edition> and c<collection id>/thumb/<edition>; the picture's type is kept as metadata.
import fs from 'node:fs';
import path from 'node:path';

const STORE = 'nft-pictures';
const KEY = /^c\d{1,9}\/(img|thumb|cover)\/\d{1,9}$/;
const checkKey = (key) => {
  if (!KEY.test(key)) throw new Error(`bad storage key "${key}"`);
  return key;
};

export function memoryStorage() {
  const m = new Map();
  return {
    kind: 'memory',
    async put(key, data, type) { m.set(checkKey(key), { data: Buffer.from(data), type }); },
    async get(key) { return m.get(checkKey(key)) || null; },
    async remove(prefix) { for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k); },
    size: () => m.size,
  };
}

export function folderStorage(dir) {
  const file = (key) => path.join(dir, checkKey(key));
  return {
    kind: 'folder',
    async put(key, data, type) {
      fs.mkdirSync(path.dirname(file(key)), { recursive: true });
      fs.writeFileSync(file(key), Buffer.from(data));
      fs.writeFileSync(file(key) + '.type', type);
    },
    async get(key) {
      try {
        return { data: fs.readFileSync(file(key)), type: fs.readFileSync(file(key) + '.type', 'utf8') };
      } catch {
        return null;
      }
    },
    async remove(prefix) {
      if (!/^c\d{1,9}\/$/.test(prefix)) throw new Error('bad prefix');
      fs.rmSync(path.join(dir, prefix), { recursive: true, force: true });
    },
  };
}

export async function netlifyStorage() {
  const { getStore } = await import('@netlify/blobs');
  // the default (eventual) consistency: strong needs an endpoint connectLambda() doesn't provide
  const store = () => getStore({ name: STORE });
  return {
    kind: 'netlify',
    async put(key, data, type) {
      const buf = Buffer.from(data);
      await store().set(checkKey(key), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { metadata: { type } });
    },
    async get(key) {
      const r = await store().getWithMetadata(checkKey(key), { type: 'arrayBuffer' });
      return r ? { data: Buffer.from(r.data), type: String(r.metadata?.type || 'application/octet-stream') } : null;
    },
    async remove(prefix) {
      if (!/^c\d{1,9}\/$/.test(prefix)) throw new Error('bad prefix');
      const s = store();
      const { blobs } = await s.list({ prefix });
      for (const b of blobs) await s.delete(b.key);
    },
  };
}

// Netlify sets NETLIFY_BLOBS_CONTEXT for each request once lambda.js connects; elsewhere a folder
export async function defaultStorage() {
  if (process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.LAMBDA_TASK_ROOT) return netlifyStorage();
  return folderStorage(process.env.BLOB_DIR || path.join(process.cwd(), 'data', 'blobs'));
}

// What a stored picture really is, from its first bytes. Only these four; never SVG or HTML.
export function sniffImage(buf) {
  const b = Buffer.from(buf);
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
