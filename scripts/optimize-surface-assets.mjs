/* Resizes and compresses an asset set's masters (generated surface maps, ground tiles and the night sky) into the WebPs
 * the 3D view loads. The masters are not in the repository: pass their folder, or keep them in
 * output/body-assets-<set>/images/. Records sizes and checksums in a build report and copies the generation prompts
 * beside it, so every shipped image can be traced to how it was made.
 *
 *   node scripts/optimize-surface-assets.mjs [set] [masters folder]      set: v5 (the default) or v6
 */
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = /^v\d+$/.test(process.argv[2] || '') ? process.argv[2] : 'v5';
const from = path.resolve((set === process.argv[2] ? process.argv[3] : process.argv[2]) || path.join(root, `output/body-assets-${set}/images`));
const out = path.join(root, `public/assets/bodies/${set}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/* name → [width, height, WebP quality, grayscale] — maps are 2:1 for wrapping a sphere, ground tiles are square and
 * repeat, masks and star maps are single-channel */
const MAP = [1024, 512, 80, false], GRAY = [1024, 512, 82, true], TILE = [512, 512, 78, false];
const SETS = {
  v5: {
    report: 'surface-asset-build-report.json', prompts: 'surface-asset-prompts.json',
    spec: {
      'planet-terran-b': MAP, 'planet-ocean': MAP, 'planet-arid': MAP, 'planet-eyeball': MAP, 'planet-barren': MAP, 'planet-lava': MAP,
      'planet-lava-glow': GRAY, 'giant-jovian': MAP, 'giant-neptunian': MAP, 'star-m-dwarf': GRAY, 'star-k-dwarf': GRAY, 'moon-icy': [512, 256, 82, false],
      'ground-grassland': TILE, 'ground-snow': TILE, 'ground-desert': TILE, 'ground-scorched': TILE, 'ground-scorched-glow': [512, 512, 80, true],
      'ground-regolith': TILE, 'ground-cloudtops': TILE, 'sky-milkyway': [2048, 1024, 74, false],
    },
  },
  /* ground tiles for each kind of world; qualities from the set's own size estimates, about 410 KB in all */
  v6: {
    report: 'surface-asset-build-report-v6.json', prompts: 'surface-asset-prompts-v6.json',
    spec: {
      'ground-ice-margin': [512, 512, 70, false], 'ground-shore': [512, 512, 76, false], 'ground-blue-ice': [512, 512, 76, false],
      'ground-ice-lineae': [512, 512, 76, false], 'ground-hardpan': [512, 512, 76, false], 'ground-lava': [512, 512, 76, false],
      'ground-lava-glow': [512, 512, 78, true],
    },
  },
};
const { spec, report: reportName, prompts } = SETS[set];

await mkdir(out, { recursive: true });
const assets = [];
for (const [name, [width, height, quality, gray]] of Object.entries(spec)) {
  const source = path.join(from, `${name}.png`), original = await readFile(source);
  let img = sharp(original).resize({ width, height, fit: 'fill', kernel: 'lanczos3' });
  if (gray) img = img.grayscale();
  const { data, info } = await img.webp({ quality, effort: 6 }).toBuffer({ resolveWithObject: true });
  const file = `public/assets/bodies/${set}/${name}.webp`;
  await writeFile(path.join(root, file), data);
  assets.push({ name, source: path.relative(path.dirname(path.dirname(from)), source).split(path.sep).join('/'), sourceSha256: hash(original), sourceBytes: original.length,
    file, width: info.width, height: info.height, sizeBytes: data.length, sha256: hash(data) });
}
const report = { tool: `sharp ${sharp.versions.sharp}`, masters: 'sources are relative to the folder holding the asset set (output/, kept outside the repository)', note: `Resizing and compression of the asset set ${set} masters. The masters stay outside the repository; lighting, climate, seams and blending are the renderer's.`,
  assets, totalBytes: assets.reduce((sum, a) => sum + a.sizeBytes, 0) };
await writeFile(path.join(root, 'scripts', reportName), JSON.stringify(report, null, 2) + '\n');
try { await writeFile(path.join(root, 'scripts', prompts), await readFile(path.join(from, '..', 'prompts.json'))); }
catch { console.warn('No prompts.json beside the masters: the prompt record was not updated.'); }
console.log(`Optimized ${assets.length} images: ${(report.totalBytes / 1024).toFixed(1)} KiB.`);
