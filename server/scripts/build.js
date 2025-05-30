// Builds the static part of the site into dist/: the preview page plus NFT images, served by the CDN.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(ROOT, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), out, { recursive: true });
fs.cpSync(path.join(ROOT, 'collection', 'images'), path.join(out, 'img'), { recursive: true });
fs.cpSync(path.join(ROOT, 'collection', 'thumbs'), path.join(out, 'thumb'), { recursive: true });
const count = fs.readdirSync(path.join(out, 'img')).length;
console.log(`dist/ ready: site + ${count} images`);
