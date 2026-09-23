import sharp from 'sharp';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public/assets/bodies');
const sets = [
  { folder: 'output/body-assets-v2', names: ['star-amber', 'star-cyan', 'star-coral', 'planet-frozen', 'planet-temperate', 'planet-hot', 'moon'] },
  { folder: 'output/body-motion-v3', names: ['planet-thawing', 'planet-warming', 'planet-stripped', 'stellar-granulation', 'debris-fragment'] },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(target, { recursive: true });
const assets = [];
for (const set of sets) {
  const manifest = JSON.parse(await readFile(path.join(root, set.folder, 'asset-manifest.json'), 'utf8'));
  const entries = Array.isArray(manifest) ? manifest : manifest.assets;
  for (const name of set.names) {
    const relative = `${set.folder}/images/${name}.png`;
    const input = path.join(root, relative);
    const entry = entries.find(item => item.file === `images/${name}.png`);
    const metadata = await sharp(input).metadata();
    let crop;
    if (name.startsWith('planet-')) {
      // Every climate state shares this crop: cross-fading must not change the disc footprint.
      crop = { left: 88, top: 94, width: 1080, height: 1080 };
    } else if (name !== 'stellar-granulation') {
      let bounds = entry?.alpha128Bounds ?? entry?.opaqueBounds;
      if (!bounds) {
        // Metadata fallback uses meaningful alpha, ignoring near-transparent stray pixels.
        const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let left = info.width, top = info.height, right = 0, bottom = 0;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * info.channels + 3] < 128) continue;
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        }
        if (!right || !bottom) throw new Error(`No opaque object found in ${relative}`);
        bounds = [left, top, right, bottom];
      }
      const [left, top, right, bottom] = bounds;
      if (name === 'debris-fragment') {
        crop = { left: Math.max(0, left - 2), top: Math.max(0, top - 2), width: Math.min(metadata.width, right + 2) - Math.max(0, left - 2), height: Math.min(metadata.height, bottom + 2) - Math.max(0, top - 2) };
      } else {
        const side = Math.min(Math.max(right - left, bottom - top) + 4, metadata.width, metadata.height);
        crop = { left: Math.max(0, Math.min(metadata.width - side, Math.floor((left + right - side) / 2))), top: Math.max(0, Math.min(metadata.height - side, Math.floor((top + bottom - side) / 2))), width: side, height: side };
      }
    }
    const size = name === 'stellar-granulation' ? 128 : name === 'debris-fragment' ? 64 : 256;
    let pipeline = sharp(input);
    if (crop) pipeline = pipeline.extract(crop);
    const { data, info } = await pipeline.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer({ resolveWithObject: true });
    const filename = `${name}.webp`;
    await writeFile(path.join(target, filename), data);
    const original = await readFile(input);
    assets.push({ name, source: relative, sourceSha256: hash(original), sourceBytes: (await stat(input)).size, crop: crop ?? null, file: `public/assets/bodies/${filename}`, width: info.width, height: info.height, sizeBytes: info.size, sha256: hash(data) });
  }
}
const report = { tool: `sharp ${sharp.versions.sharp}`, webp: { quality: 82, alphaQuality: 100, effort: 6 }, note: 'Authorized crop, resample, and compression only. Original master PNGs are unchanged and are not required for builds or deployment.', assets, totalSourceBytes: assets.reduce((sum, item) => sum + item.sourceBytes, 0), totalBytes: assets.reduce((sum, item) => sum + item.sizeBytes, 0) };
await writeFile(path.join(root, 'scripts/asset-build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Optimized ${assets.length} approved assets: ${(report.totalBytes / 1024).toFixed(1)} KiB (${(report.totalSourceBytes / 1024 / 1024).toFixed(1)} MiB of masters).`);
