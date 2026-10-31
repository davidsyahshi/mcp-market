// Builds the static part of the site into dist/: the preview page plus NFT images (and 1008 px copies of the pixel
// ones, dist/big), served by the CDN.
// The images come out of collection/*.tar.gz (see src/assets.js); the thumbnails are also unpacked into
// collection/thumbs, which the function bundles to show NFTs inside the chat.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackCollection, makeBigImages } from '../src/assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(ROOT, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), out, { recursive: true });
const counts = unpackCollection(ROOT, { dist: out });
// every NFT of collection.json needs its picture and thumbnail
const supply = JSON.parse(fs.readFileSync(path.join(ROOT, 'collection', 'collection.json'), 'utf8')).items.length;
if (counts.images !== supply || counts.thumbs !== supply) throw new Error(`the archives have ${counts.images} pictures and ${counts.thumbs} thumbnails for ${supply} NFTs`);
// the pixel ones also at 1008 px, for downloading (dist/big)
const pixel = JSON.parse(fs.readFileSync(path.join(ROOT, 'collection', 'collection.json'), 'utf8')).items.filter((it) => it.px).length;
const big = makeBigImages(ROOT, path.join(out, 'big'));
if (big !== pixel) throw new Error(`made ${big} big pictures for ${pixel} pixel NFTs`);
console.log(`dist/ ready: site + ${counts.images} images + ${counts.thumbs} thumbnails + ${big} big pictures`);
