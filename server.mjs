import http from 'node:http';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const defaultRoot = fileURLToPath(new URL('./dist/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const tag = data => `"${createHash('sha256').update(data).digest('hex').slice(0, 24)}"`;

async function loadFiles(root, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) for (const [name, file] of await loadFiles(root, relative)) files.set(name, file);
    else if (entry.isFile() && types[path.extname(entry.name)]) {
      const data = await readFile(path.join(root, relative));
      const variants = { identity: { data, etag: tag(data) } };
      for (const encoding of ['br', 'gzip']) {
        try {
          const sidecar = path.join(root, relative) + (encoding === 'gzip' ? '.gz' : '.br');
          if (!(await lstat(sidecar)).isFile()) continue;
          const compressed = await readFile(sidecar);
          variants[encoding] = { data: compressed, etag: tag(compressed) };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      files.set('/' + relative, { type: types[path.extname(entry.name)], variants });
    }
  }
  return files;
}

function chooseEncoding(header, variants) {
  const qualities = new Map();
  for (const part of String(header || '').split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    if (!token) continue;
    const qpart = params.find(value => value.trim().startsWith('q='));
    const value = qpart ? Number(qpart.trim().slice(2)) : 1;
    qualities.set(token, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0);
  }
  const quality = name => qualities.get(name) ?? (name === 'identity' ? (qualities.get('*') === 0 ? 0 : 1) : qualities.get('*') ?? 0);
  return Object.keys(variants).sort((a, b) => quality(b) - quality(a) || ['br', 'gzip', 'identity'].indexOf(a) - ['br', 'gzip', 'identity'].indexOf(b)).find(name => quality(name) > 0);
}

export async function createAppServer({ root = defaultRoot } = {}) {
  const files = await loadFiles(path.resolve(root));
  if (!files.has('/index.html')) throw new Error('dist/index.html is missing. Run npm run build before starting the server.');
  return http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
    const send = (status, text, extra = {}) => {
      const body = Buffer.from(text);
      res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
      res.end(head ? undefined : body);
    };
    if (req.method !== 'GET' && !head) return send(405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    let requested;
    try { requested = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { return send(400, 'Malformed URL\n'); }
    if (!requested.startsWith('/') || requested.includes('\\') || requested.includes('\0') || requested.split('/').some(part => part.startsWith('.'))) return send(404, 'Not found\n');
    if (requested === '/healthz') return send(200, '{"status":"ok"}\n', { 'Content-Type': 'application/json; charset=utf-8' });
    const file = files.get(requested === '/' ? '/index.html' : requested);
    if (!file) return send(404, 'Not found\n');
    const encoding = chooseEncoding(req.headers['accept-encoding'], file.variants);
    if (!encoding) return send(406, 'No acceptable representation\n', { Vary: 'Accept-Encoding' });
    const variant = file.variants[encoding];
    Object.assign(headers, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: variant.etag, Vary: 'Accept-Encoding' });
    if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
    const matches = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
    if (matches.includes('*') || matches.includes(variant.etag)) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': variant.data.length });
    res.end(head ? undefined : variant.data);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = await createAppServer();
  server.listen(port, '0.0.0.0', () => console.log(`Three-Body listening on 0.0.0.0:${server.address().port}`));
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
