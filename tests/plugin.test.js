import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthExportPlugin } from '../index.js';

const slot = Symbol.for('magpie-auth-export.service');
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'magpie-plugin-startup-'));
  t.after(async () => {
    const service = await Promise.resolve(globalThis[slot]).catch(() => null);
    if (service) await service.close();
    delete globalThis[slot];
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function accountNames(url) {
  const html = await (await fetch(url)).text();
  const token = html.match(/name="export-session" content="([0-9a-f]{64})"/)[1];
  const response = await fetch(url + '/api/accounts', { headers: { 'X-Export-Session': token } });
  assert.equal(response.status, 200);
  return (await response.json()).accounts.map(account => account.user);
}

test('simultaneous host loads share one server and read the host config directory', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'logins.json'), JSON.stringify([{ id: 'portable', agent: 'codex', user: 'portable@example.com', auth: { tokens: { access_token: 'synthetic-portable' } } }]));
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  await Promise.all(Array.from({ length: 4 }, () => AuthExportPlugin({ directory: root }, { port })));
  const service = await globalThis[slot];
  assert.deepEqual(await accountNames(service.url), ['portable@example.com']);
});

test('an explicit source directory overrides the host directory', async t => {
  const root = await fixture(t);
  const sourceDir = join(root, 'explicit');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'logins.json'), JSON.stringify([{ id: 'explicit', agent: 'codex', user: 'explicit@example.com', auth: { tokens: { access_token: 'synthetic-explicit' } } }]));
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  await AuthExportPlugin({ directory: root }, { port, sourceDir });
  assert.deepEqual(await accountNames((await globalThis[slot]).url), ['explicit@example.com']);
});

test('a failed bind can retry after the occupying process releases the port', async t => {
  const root = await fixture(t);
  const occupied = net.createServer();
  const port = await listen(occupied);
  t.after(() => occupied.listening ? close(occupied) : undefined);
  await assert.rejects(AuthExportPlugin({ directory: root }, { port }));
  assert.equal(globalThis[slot], undefined);
  await close(occupied);
  await AuthExportPlugin({ directory: root }, { port });
  assert.deepEqual(await accountNames((await globalThis[slot]).url), []);
});
