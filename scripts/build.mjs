import { readFile, writeFile, mkdir, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
const compressible = /\.(html|js|css|json|svg)$/;
const publicTypes = new Set(['.html', '.webp', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.css', '.js', '.json', '.woff2', '.txt']);
/* Third-party files a page may reference as vendor/<name>. They are copied from the installed package, never from the repository. */
const vendorFiles = {
  'three.module.js': ['three', 'build/three.module.js', ['three.core.js']],   // the module build imports ./three.core.js
  'three.core.js': ['three', 'build/three.core.js'],
  'LineSegments2.js': ['three', 'examples/jsm/lines/LineSegments2.js', ['LineSegmentsGeometry.js', 'LineMaterial.js']],
  'LineSegmentsGeometry.js': ['three', 'examples/jsm/lines/LineSegmentsGeometry.js'],
  'LineMaterial.js': ['three', 'examples/jsm/lines/LineMaterial.js'],
};

async function readTree(directory, allowed, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to publish a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await readTree(absolute, allowed, relative));
    else if (entry.isFile() && allowed.has(path.extname(entry.name))) files.push({ path: relative, data: await readFile(absolute) });
  }
  return files;
}

/* The installed package's directory, found from its entry point: a package's exports may not expose package.json itself. */
function packageRootOf(entry, name) {
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (path.basename(dir) === name && path.basename(path.dirname(dir)) === 'node_modules') return dir;
  }
  throw new Error(`Cannot locate the installed package ${name}`);
}

/* Pages and scripts may reference vendor/<name>.js; each referenced file and what it imports is copied from node_modules. */
async function vendored(sources) {
  const wanted = new Set();
  for (const text of sources) for (const m of text.matchAll(/\bvendor\/([\w.-]+\.js)\b/g)) wanted.add(m[1]);
  const require = createRequire(import.meta.url), files = [];
  for (const name of wanted) {
    const spec = vendorFiles[name];
    if (!spec) throw new Error(`HTML references an unknown vendor file: vendor/${name}`);
    for (const extra of spec[2] || []) wanted.add(extra);
    const packageRoot = packageRootOf(require.resolve(spec[0]), spec[0]);
    files.push({ path: `vendor/${name}`, data: await readFile(path.join(packageRoot, spec[1])) });
  }
  return files;
}

export async function build({ root = projectRoot, outDir = path.join(root, 'dist') } = {}) {
  root = path.resolve(root); outDir = path.resolve(outDir);
  if (outDir === root || root.startsWith(outDir + path.sep)) throw new Error('Build output must not contain the source directory.');
  const source = await readFile(path.join(root, 'Three-Body Problem.html'), 'utf8');
  const files = await readTree(path.join(root, 'public'), publicTypes);
  const sourceDirectory = path.join(root, 'src');
  try {
    if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error('Refusing a symlinked source directory.');
    files.push(...(await readTree(sourceDirectory, new Set(['.js', '.css']))).map(file => ({ ...file, path: `src/${file.path}` })));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pages = files.filter(file => file.path.endsWith('.html'));
  files.push(...await vendored([source, ...files.filter(file => /\.(html|js)$/.test(file.path)).map(file => file.data.toString())]));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Public, source and vendor file names overlap.');
  const lookup = new Map(files.map(file => [file.path, file]));
  const version = hash(source + files.map(file => `${file.path}:${hash(file.data)}`).join('\n')).slice(0, 16);
  const stamp = html => html.replace(/(<script\b[^>]*\bsrc=)(["'])(src\/[^"'?]+)(?:\?[^"']*)?\2/g, (match, before, quote, filename) => {
    const file = lookup.get(filename);
    if (!file) throw new Error(`HTML references a missing script: ${filename}`);
    return `${before}${quote}${filename}?v=${hash(file.data).slice(0, 16)}${quote}`;
  });
  for (const page of pages) page.data = Buffer.from(stamp(page.data.toString()));
  let html = stamp(source);
  html = html.replace('</head>', `<meta name="app-build" content="${version}">\n</head>`);
  files.unshift({ path: 'index.html', data: Buffer.from(html) });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const manifest = { version, files: [] };
  for (const file of files) {
    const destination = path.join(outDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
    const item = { path: file.path, bytes: file.data.length, sha256: hash(file.data) };
    if (compressible.test(file.path) && file.data.length >= 512) {
      const br = brotliCompressSync(file.data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
      const gz = gzipSync(file.data, { level: 9 });
      await writeFile(destination + '.br', br); await writeFile(destination + '.gz', gz);
      item.brotliBytes = br.length; item.gzipBytes = gz.length;
    }
    manifest.files.push(item);
  }
  await writeFile(path.join(outDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built ${files.length} files into ${path.relative(root, outDir) || outDir}; version ${version}.`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
