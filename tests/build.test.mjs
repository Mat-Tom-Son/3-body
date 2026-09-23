import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build } from '../scripts/build.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'three-body-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public/assets/bodies'), { recursive: true }); await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'Three-Body Problem.html'), '<!doctype html><head></head><body>' + 'content '.repeat(100) + '<script src="src/body-renderer.js"></script></body>');
  await writeFile(path.join(root, 'src/body-renderer.js'), 'window.renderer = true;');
  await writeFile(path.join(root, 'public/assets/bodies/planet.webp'), 'asset bytes');
  return root;
}

test('build publishes a repeatable, isolated site with versioned scripts and compressed HTML', async t => {
  const root = await fixture(t); const out = path.join(root, 'dist');
  await writeFile(path.join(root, 'public/.env'), 'SECRET=true');
  await writeFile(path.join(root, 'public/notes.md'), 'not a web asset');
  await mkdir(path.join(root, 'output')); await writeFile(path.join(root, 'output/private.png'), 'not published');
  const first = await build({ root });
  const html = await readFile(path.join(out, 'index.html'));
  assert.match(html.toString(), /src\/body-renderer\.js\?v=[a-f0-9]{16}/);
  assert.match(html.toString(), /name="app-build" content="[a-f0-9]{16}"/);
  assert.deepEqual(brotliDecompressSync(await readFile(path.join(out, 'index.html.br'))), html);
  assert.deepEqual(gunzipSync(await readFile(path.join(out, 'index.html.gz'))), html);
  assert.deepEqual((await readdir(out)).sort(), ['assets', 'build-manifest.json', 'index.html', 'index.html.br', 'index.html.gz', 'src']);
  assert.equal((await readFile(path.join(out, 'assets/bodies/planet.webp'))).toString(), 'asset bytes');
  assert.deepEqual(await build({ root }), first);
  await writeFile(path.join(root, 'public/assets/bodies/planet.webp'), 'changed asset');
  assert.notEqual((await build({ root })).version, first.version);
});

test('build catches missing scripts and refuses publishing symlinks', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'src/body-renderer.js'));
  await assert.rejects(build({ root }), /missing script/);
  await writeFile(path.join(root, 'src/body-renderer.js'), 'window.renderer = true;');
  await symlink(path.join(root, 'Three-Body Problem.html'), path.join(root, 'public/unsafe.html'));
  await assert.rejects(build({ root }), /symlink/);
});
