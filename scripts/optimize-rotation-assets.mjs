import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = [];
await mkdir(path.join(root, 'public/assets/bodies'), { recursive: true });
for (const name of ['planet-surface', 'moon-surface', 'star-surface']) {
  const source = `output/body-rotation-v4/images/${name}.png`;
  const original = await readFile(path.join(root, source));
  const { data, info } = await sharp(original)
    .resize({ width: 512, height: 256, fit: 'fill' })
    .webp({ quality: 86, effort: 6 }).toBuffer({ resolveWithObject: true });
  const file = `public/assets/bodies/${name}.webp`;
  await writeFile(path.join(root, file), data);
  assets.push({ name, source, sourceSha256: hash(original), sourceBytes: original.length,
    file, width: info.width, height: info.height, sizeBytes: data.length, sha256: hash(data) });
}
const report = { tool: `sharp ${sharp.versions.sharp}`, webp: { quality: 86, effort: 6 },
  note: 'Resizing and compression of three generated 2:1 surface maps. Original masters remain unchanged; globe projection, climate, seam blending, and lighting are handled by the renderer.',
  assets, totalBytes: assets.reduce((sum, item) => sum + item.sizeBytes, 0) };
await writeFile(path.join(root, 'scripts/rotation-asset-build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Optimized ${assets.length} rotating surface maps: ${(report.totalBytes / 1024).toFixed(1)} KiB.`);
