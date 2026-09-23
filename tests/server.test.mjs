import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createAppServer } from '../server.mjs';

function request(server, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('production server serves only built files, negotiates compression, and revalidates caches', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'three-body-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'dist'); await mkdir(path.join(root, 'assets/bodies'), { recursive: true });
  const html = Buffer.from('<!doctype html><title>Three-Body</title>' + 'Hello gravity. '.repeat(80));
  await writeFile(path.join(root, 'index.html'), html);
  await writeFile(path.join(root, 'index.html.br'), brotliCompressSync(html));
  await writeFile(path.join(root, 'index.html.gz'), gzipSync(html));
  await writeFile(path.join(root, 'assets/bodies/planet.webp'), Buffer.from('RIFF test WEBP'));
  await writeFile(path.join(directory, 'secret.txt'), 'do not serve');
  await symlink(path.join(directory, 'secret.txt'), path.join(root, 'leak.txt'));
  const server = await createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const page = await request(server, '/');
  assert.equal(page.status, 200); assert.deepEqual(page.body, html);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const cached = await request(server, '/', { headers: { 'If-None-Match': page.headers.etag } });
  assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  const head = await request(server, '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), html.length);
  const br = await request(server, '/', { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(br.headers['content-encoding'], 'br'); assert.deepEqual(brotliDecompressSync(br.body), html);
  assert.equal(br.headers.vary, 'Accept-Encoding'); assert.notEqual(br.headers.etag, page.headers.etag);
  const gzip = await request(server, '/', { headers: { 'Accept-Encoding': 'br;q=0, gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(gzip.body), html);
  assert.equal((await request(server, '/', { headers: { 'Accept-Encoding': '*;q=0' } })).status, 406);
  assert.equal((await request(server, '/', { method: 'POST' })).status, 405);
  assert.equal((await request(server, '/', { method: 'POST' })).headers.allow, 'GET, HEAD');
  const health = await request(server, '/healthz');
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).status, 'ok'); assert.equal(health.headers['cache-control'], 'no-store');
  const asset = await request(server, '/assets/bodies/planet.webp?v=123');
  assert.equal(asset.status, 200); assert.equal(asset.headers['content-type'], 'image/webp');
  for (const target of ['/missing', '/package.json', '/output/art.png', '/.env', '/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/%2e%2e%5csecret.txt', '/leak.txt', '/index.html.br']) {
    assert.equal((await request(server, target)).status, 404, target);
  }
  assert.equal((await request(server, '/%invalid')).status, 400);
});

test('server refuses to start without a built index', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'three-body-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createAppServer({ root }), /npm run build/);
});
