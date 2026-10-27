/* Resizes and compresses the asset set v5 masters (generated surface maps, ground tiles and the night sky) into the
 * WebPs the 3D view loads. The masters are not in the repository: pass their folder, or keep them in
 * output/body-assets-v5/images/. Records sizes and checksums in scripts/surface-asset-build-report.json and copies the
 * generation prompts to scripts/surface-asset-prompts.json, so every shipped image can be traced to how it was made.
 *
 *   node scripts/optimize-surface-assets.mjs [masters folder]
 */
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.resolve(process.argv[2] || path.join(root, 'output/body-assets-v5/images'));
const out = path.join(root, 'public/assets/bodies/v5');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/* name → [width, height, WebP quality, grayscale] — maps are 2:1 for wrapping a sphere, ground tiles are square and
 * repeat, masks and star maps are single-channel */
const MAP = [1024, 512, 80, false], GRAY = [1024, 512, 82, true], TILE = [512, 512, 78, false];
const SPEC = {
  'planet-terran-b': MAP, 'planet-ocean': MAP, 'planet-arid': MAP, 'planet-eyeball': MAP, 'planet-barren': MAP, 'planet-lava': MAP,
  'planet-lava-glow': GRAY, 'giant-jovian': MAP, 'giant-neptunian': MAP, 'star-m-dwarf': GRAY, 'star-k-dwarf': GRAY, 'moon-icy': [512, 256, 82, false],
  'ground-grassland': TILE, 'ground-snow': TILE, 'ground-desert': TILE, 'ground-scorched': TILE, 'ground-scorched-glow': [512, 512, 80, true],
  'ground-regolith': TILE, 'ground-cloudtops': TILE, 'sky-milkyway': [2048, 1024, 74, false],
};

await mkdir(out, { recursive: true });
const assets = [];
for (const [name, [width, height, quality, gray]] of Object.entries(SPEC)) {
  const source = path.join(from, `${name}.png`), original = await readFile(source);
  let img = sharp(original).resize({ width, height, fit: 'fill', kernel: 'lanczos3' });
  if (gray) img = img.grayscale();
  const { data, info } = await img.webp({ quality, effort: 6 }).toBuffer({ resolveWithObject: true });
  const file = `public/assets/bodies/v5/${name}.webp`;
  await writeFile(path.join(root, file), data);
  assets.push({ name, source: path.relative(path.dirname(path.dirname(from)), source).split(path.sep).join('/'), sourceSha256: hash(original), sourceBytes: original.length,
    file, width: info.width, height: info.height, sizeBytes: data.length, sha256: hash(data) });
}
const report = { tool: `sharp ${sharp.versions.sharp}`, masters: 'sources are relative to the folder holding the asset set (output/, kept outside the repository)', note: 'Resizing and compression of the asset set v5 masters. The masters stay outside the repository; lighting, climate, seams and blending are the renderer\'s.',
  assets, totalBytes: assets.reduce((sum, a) => sum + a.sizeBytes, 0) };
await writeFile(path.join(root, 'scripts/surface-asset-build-report.json'), JSON.stringify(report, null, 2) + '\n');
try { await writeFile(path.join(root, 'scripts/surface-asset-prompts.json'), await readFile(path.join(from, '..', 'prompts.json'))); }
catch { console.warn('No prompts.json beside the masters: the prompt record was not updated.'); }
console.log(`Optimized ${assets.length} images: ${(report.totalBytes / 1024).toFixed(1)} KiB.`);
