import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import http from 'node:http';
import { startService, defaultOutputDir } from '../lib/service.js';

const secret = 'synthetic-secret-never-returned-to-browser';

test('default export destination is Downloads itself', () => {
  assert.equal(defaultOutputDir(), join(homedir(), 'Downloads'));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magpie-export-http-'));
  const sourceDir = join(root, 'source'), outputDir = join(root, 'output');
  await mkdir(sourceDir);
  const source = JSON.stringify([{ id: 'example', agent: 'codex', user: 'demo@example.com', auth: { tokens: { access_token: secret, refresh_token: 'fake-refresh' } } }]);
  await writeFile(join(sourceDir, 'logins.json'), source);
  const service = await startService({ port: 0, sourceDir, outputDir });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const home = await fetch(service.url);
  const html = await home.text();
  const token = html.match(/name="export-session" content="([0-9a-f]{64})"/)[1];
  return { ...service, token, source, sourceDir, outputDir, headers: { 'X-Export-Session': token, 'Content-Type': 'application/json' } };
}

test('HTTP serves UI and metadata with no credentials; export saves only to disk', async t => {
  const f = await fixture(t);
  const listed = await fetch(`${f.url}/api/accounts`, { headers: f.headers });
  const metadata = await listed.text();
  assert.equal(listed.status, 200);
  assert.ok(!metadata.includes(secret));
  assert.ok(!metadata.includes('fake-refresh'));
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const accounts = JSON.parse(metadata).accounts;
  const exported = await fetch(`${f.url}/api/export`, { method: 'POST', headers: f.headers, body: JSON.stringify({ ids: [accounts[0].id], format: 'codex' }) });
  const result = await exported.text();
  assert.equal(exported.status, 200);
  assert.ok(!result.includes(secret));
  const data = JSON.parse(result);
  assert.equal(data.count, 1);
  assert.equal(data.directory, f.outputDir);
  assert.equal(data.files[0].name, 'demo@example.com.json');
  assert.equal(dirname(data.files[0].path), f.outputDir);
  assert.equal(JSON.parse(await readFile(data.files[0].path, 'utf8')).tokens.access_token, secret);
  const repeated = await fetch(`${f.url}/api/export`, { method: 'POST', headers: f.headers, body: JSON.stringify({ ids: [accounts[0].id], format: 'codex' }) });
  assert.equal(repeated.status, 200);
  const second = await repeated.json();
  assert.equal(second.directory, f.outputDir);
  assert.equal(second.files[0].name, 'demo@example.com (2).json');
  assert.equal(dirname(second.files[0].path), f.outputDir);
  const entries = await readdir(f.outputDir, { withFileTypes: true });
  assert.ok(entries.every(entry => entry.isFile()), 'export must not create account or batch subdirectories');
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['demo@example.com (2).json', 'demo@example.com.json']);
  assert.equal(JSON.parse(await readFile(data.files[0].path, 'utf8')).tokens.access_token, secret, 'repeated export preserves the first file');
  assert.equal(await readFile(join(f.sourceDir, 'logins.json'), 'utf8'), f.source);
  for (const path of ['/logins.json', '/../lib/exporter.js', '/api/unknown']) assert.notEqual((await fetch(f.url + path)).status, 200);
});

test('requires session, blocks foreign origins and DNS rebinding, malformed headers cannot crash service', async t => {
  const f = await fixture(t);
  for (const token of ['', 'wrong', 'é'.repeat(64), '0'.repeat(64)]) {
    const response = await fetch(`${f.url}/api/accounts`, { headers: { 'X-Export-Session': token } });
    assert.equal(response.status, 401);
  }
  assert.equal((await fetch(`${f.url}/api/accounts`, { headers: { ...f.headers, Origin: 'https://untrusted.example' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.url, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const preflight = await fetch(`${f.url}/api/export`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'x-export-session,content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  const opaque = await fetch(`${f.url}/api/accounts`, { headers: { ...f.headers, Origin: 'null' } });
  assert.equal(opaque.status, 200);
  assert.equal(opaque.headers.get('access-control-allow-origin'), 'null');
  const html = await fetch(f.url, { headers: { Origin: 'null' } });
  assert.equal(html.headers.get('access-control-allow-origin'), null);
});

test('browser cannot override directories and invalid input produces no export files', async t => {
  const f = await fixture(t);
  for (const body of ['not-json', JSON.stringify({ ids: ['login:example'], format: 'codex', outputDir: '/' }), JSON.stringify({ ids: ['missing'], format: 'codex' })]) {
    const response = await fetch(`${f.url}/api/export`, { method: 'POST', headers: f.headers, body });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(secret));
  }
  const tooLarge = await fetch(`${f.url}/api/export`, { method: 'POST', headers: f.headers, body: 'x'.repeat(65537) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await readdir(f.outputDir).catch(() => []), []);
});
