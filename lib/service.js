import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir, listAccounts, exportAccounts } from './exporter.js';

const pageDir = fileURLToPath(new URL('../page/', import.meta.url));
const assets = new Map([
  ['/download-service.js', ['download-service.js', 'text/javascript; charset=utf-8']],
  ['/download.css', ['download.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
export const defaultOutputDir = () => join(homedir(), 'Downloads');

export async function startService({ port = 34821, sourceDir = defaultConfigDir(), outputDir = defaultOutputDir() } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('插件端口必须是 1–65535 的整数。');
  const token = randomBytes(32).toString('hex');
  const html = (await readFile(join(pageDir, 'download-service.html'), 'utf8')).replace('__SESSION_TOKEN__', token);
  const resources = new Map(await Promise.all([...assets].map(async ([route, [name, type]]) => [route, { data: await readFile(join(pageDir, name)), type }])));
  let origin;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // WebKit keeps Magpie's plugin frame opaque after its self-navigation.
    // Spell out the one loopback origin instead of relying on 'self'.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' ${origin}; style-src 'self' ${origin}; img-src 'self' ${origin}; connect-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' wails://localhost http://127.0.0.1:* http://localhost:*`);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const remote = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || req.headers.host !== new URL(origin).host) return json(403, { error: '只接受本机插件请求。' });
    let path;
    try { path = new URL(req.url, origin).pathname; } catch { return json(400, { error: '请求地址无效。' }); }
    if (path.startsWith('/api/')) {
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== 'null' && requestOrigin !== origin) return json(403, { error: '请求来源无效。' });
      // Magpie's sandboxed frame has an opaque origin. Only authenticated API
      // responses receive CORS headers; HTML never does, so another frame cannot
      // fetch the page to discover this per-process capability.
      if (requestOrigin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Export-Session', 'Access-Control-Max-Age': '60' });
        return res.end();
      }
      const supplied = req.headers['x-export-session'];
      if (typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return json(401, { error: '页面会话已失效，请重新打开认证导出。' });
      try {
        if (req.method === 'GET' && path === '/api/accounts') return json(200, { ...await listAccounts({ sourceDir }), outputDir });
        if (req.method === 'POST' && path === '/api/export') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: '请求必须使用 JSON。' });
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 65536) return json(413, { error: '请求过大。' });
          }
          let body;
          try { body = JSON.parse(raw); } catch { return json(400, { error: '请求 JSON 无效。' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['ids', 'format'].includes(k))) return json(400, { error: '请求只接受账号和导出格式。' });
          return json(200, await exportAccounts({ sourceDir, outputDir, ids: body.ids, format: body.format }));
        }
        return json(404, { error: '没有这个接口。' });
      } catch (error) {
        // Core errors are intentionally safe for the UI and never contain auth.
        return json(400, { error: error instanceof Error ? error.message : '导出失败。' });
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: '请求方法无效。' });
    if (path === '/' || path === '/download') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? '' : html);
    }
    const asset = resources.get(path);
    if (asset) { res.writeHead(200, { 'Content-Type': asset.type }); return res.end(req.method === 'HEAD' ? '' : asset.data); }
    return json(404, { error: '文件不存在。' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; server.removeListener('error', reject); resolve(); });
  });
  return { server, url: origin, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }) };
}
