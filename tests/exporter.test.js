import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, mkdir, readFile, writeFile, readdir, stat, lstat, symlink, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listAccounts, exportAccounts, defaultConfigDir } from '../lib/exporter.js';

const token = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const codexAuth = () => ({
  auth_mode: 'chatgpt', OPENAI_API_KEY: null, custom_future_field: { preserve: true },
  last_refresh: '2026-10-29T02:03:04Z',
  tokens: {
    access_token: token({ exp: 1800000000 }), refresh_token: 'synthetic-refresh-secret',
    id_token: token({ email: 'alice@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-a', chatgpt_plan_type: 'team' } }),
  },
});

async function fixture(t, logins = [], plugins = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'magpie-export-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceDir = path.join(base, 'source');
  const outputDir = path.join(base, 'output');
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, 'logins.json'), JSON.stringify(logins));
  await writeFile(path.join(sourceDir, 'plugin-auth.json'), JSON.stringify(plugins));
  return { base, sourceDir, outputDir };
}

test('lists account metadata without exposing credentials and advertises supported formats', async t => {
  const f = await fixture(t, [
    { id: 'a', agent: 'codex', user: 'alice@example.com · Team · workspace-a', plan: 'team', auth: codexAuth() },
    { id: 'token', agent: 'claude', user: 'Setup token', auth: { setupToken: 'secret-setup' } },
    { agent: 'plugin:empty', user: 'placeholder', auth: {} }, null,
  ], { 'vendor#2': { type: 'oauth', access: 'secret-plugin-access', refresh: 'secret-plugin-refresh', accountId: 'vendor-person' } });
  const list = await listAccounts(f);
  assert.equal(list.accounts.length, 3);
  assert.deepEqual(list.accounts[0].formats, ['raw', 'codex', 'cliproxyapi']);
  assert.deepEqual(list.accounts[1].formats, ['raw']);
  assert.equal(list.accounts[2].id, 'plugin:vendor#2');
  assert.deepEqual(list.accounts[2].formats, ['raw']);
  assert.equal(list.accounts[2].hasRefreshToken, true);
  assert.doesNotMatch(JSON.stringify(list), /synthetic-refresh-secret|secret-setup|secret-plugin/);
});

test('native Codex export preserves every field and source files stay byte-for-byte unchanged', async t => {
  const auth = codexAuth();
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice', auth }]);
  const before = await readFile(path.join(f.sourceDir, 'logins.json'));
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'codex' });
  assert.equal(result.directory, f.outputDir);
  assert.equal(result.files[0].name, 'alice@example.com.json');
  assert.equal(path.dirname(result.files[0].path), f.outputDir);
  assert.deepEqual(await readdir(f.outputDir), ['alice@example.com.json']);
  assert.deepEqual(JSON.parse(await readFile(result.files[0].path, 'utf8')), auth);
  assert.deepEqual(await readFile(path.join(f.sourceDir, 'logins.json')), before);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o600);
});

test('CLIProxyAPI Codex export flattens tokens, derives real identity and expiry without pretending to refresh', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice@example.com · Team · workspace-a', plan: 'display-plan', auth: codexAuth() }]);
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'cliproxyapi' });
  const data = JSON.parse(await readFile(result.files[0].path));
  assert.equal(data.type, 'codex');
  assert.equal(data.account_id, 'workspace-a');
  assert.equal(data.email, 'alice@example.com');
  assert.equal(data.plan_type, 'team');
  assert.equal(data.expired, new Date(1800000000 * 1000).toISOString());
  assert.equal(data.last_refresh, '2026-10-29T02:03:04.000Z');
  assert.equal(data.refresh_token, 'synthetic-refresh-secret');
  assert.equal(data.tokens, undefined);
  assert.equal(result.files[0].name, 'alice@example.com.json');
});

test('missing optional claims and refresh timestamps remain unknown', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'A display name · Team', auth: { tokens: { access_token: 'opaque-access' } } }]);
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'cliproxyapi' });
  const data = JSON.parse(await readFile(result.files[0].path));
  assert.equal(data.email, '');
  assert.equal(data.expired, '');
  assert.equal(data.last_refresh, '');
  assert.equal(data.refresh_token, '');
  assert.equal(data.plan_type, 'free');
});

test('Claude CLIProxyAPI export maps OAuth milliseconds and profile identity', async t => {
  const f = await fixture(t, [{ id: 'c', agent: 'claude', user: 'display', renewed: '2026-10-29T01:02:03Z',
    profile: { emailAddress: 'claude@example.com', accountUuid: 'acct', organizationUuid: 'org' },
    auth: { claudeAiOauth: { accessToken: 'claude-access', refreshToken: 'claude-refresh', expiresAt: 1800000000123 } },
  }]);
  const result = await exportAccounts({ ...f, ids: ['login:c'], format: 'cliproxyapi' });
  const data = JSON.parse(await readFile(result.files[0].path));
  assert.equal(data.type, 'claude');
  assert.equal(data.email, 'claude@example.com');
  assert.equal(data.account_uuid, 'acct');
  assert.equal(data.organization_uuid, 'org');
  assert.equal(data.expired, new Date(1800000000123).toISOString());
  assert.equal(data.last_refresh, '2026-10-29T01:02:03.000Z');
  assert.equal(result.files[0].name, 'claude@example.com.json');
});

test('raw plugin export preserves map key and all unknown auth fields', async t => {
  const auth = { type: 'oauth', refresh: 'refresh-secret', access: 'access-secret', expires: 1234, custom: { odd: true } };
  const f = await fixture(t, [], { 'vendor#9': auth });
  const result = await exportAccounts({ ...f, ids: ['plugin:vendor#9'], format: 'raw' });
  assert.deepEqual(JSON.parse(await readFile(result.files[0].path)), { 'vendor#9': auth });
});

test('export rereads credential state after listing, using the newest refresh token', async t => {
  const auth = codexAuth();
  const rows = [{ id: 'a', agent: 'codex', user: 'alice', auth }];
  const f = await fixture(t, rows);
  await listAccounts(f);
  rows[0].auth.tokens.refresh_token = 'new-current-refresh';
  await writeFile(path.join(f.sourceDir, 'logins.json'), JSON.stringify(rows));
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'codex' });
  assert.equal(JSON.parse(await readFile(result.files[0].path)).tokens.refresh_token, 'new-current-refresh');
});

test('prevalidates the entire batch and creates no exports for unsupported or stale selections', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice', auth: codexAuth() }], { vendor: { type: 'api', key: 'private-key' } });
  await assert.rejects(exportAccounts({ ...f, ids: ['login:a', 'plugin:vendor'], format: 'codex' }), /not supported/);
  await assert.rejects(exportAccounts({ ...f, ids: ['login:a', 'unknown'], format: 'raw' }), /no longer available/);
  await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('output cannot overlap the source through direct paths or symlinks', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice', auth: codexAuth() }]);
  const options = { ...f, ids: ['login:a'], format: 'raw' };
  for (const outputDir of [f.sourceDir, path.join(f.sourceDir, 'nested'), f.base]) {
    await assert.rejects(exportAccounts({ ...options, outputDir }), /separate/);
  }
  const alias = path.join(f.base, 'alias');
  await symlink(f.sourceDir, alias, 'dir');
  await assert.rejects(exportAccounts({ ...options, outputDir: alias }), /separate/);
});

test('hostile names cannot traverse directories and repeated exports add short numbered filenames', async t => {
  const f = await fixture(t, [
    { id: 'a', agent: 'vendor', user: '../../same/name', auth: { key: 'first' } },
    { id: 'b', agent: 'vendor', user: '..\\same/name', auth: { key: 'second' } },
  ]);
  const options = { ...f, ids: ['login:a', 'login:b'], format: 'raw' };
  const a = await exportAccounts(options);
  const before = await Promise.all(a.files.map(file => readFile(file.path)));
  const b = await exportAccounts(options);
  assert.equal(a.directory, f.outputDir);
  assert.equal(b.directory, f.outputDir);
  assert.deepEqual(a.files.map(file => file.name), ['same_name.json', 'same_name (2).json']);
  assert.deepEqual(b.files.map(file => file.name), ['same_name (3).json', 'same_name (4).json']);
  assert.equal(new Set(a.files.map(file => file.name)).size, 2);
  for (const file of a.files) {
    assert.equal(path.dirname(file.path), f.outputDir);
    assert.doesNotMatch(file.name, /[\\/]/);
  }
  assert.deepEqual(await Promise.all(a.files.map(file => readFile(file.path))), before);
  assert.ok((await readdir(f.outputDir, { withFileTypes: true })).every(entry => entry.isFile()));
});

test('every format uses the email filename and preserves prior exports and existing directory permissions', async t => {
  const auth = codexAuth();
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice@example.com · Team · workspace', auth }]);
  await mkdir(f.outputDir, { mode: 0o755 });
  const beforeMode = (await stat(f.outputDir)).mode & 0o777;
  const first = await exportAccounts({ ...f, ids: ['login:a'], format: 'raw' });
  const firstBytes = await readFile(first.files[0].path);
  const second = await exportAccounts({ ...f, ids: ['login:a'], format: 'codex' });
  const third = await exportAccounts({ ...f, ids: ['login:a'], format: 'cliproxyapi' });
  assert.deepEqual([first, second, third].map(result => result.files[0].name), [
    'alice@example.com.json', 'alice@example.com (2).json', 'alice@example.com (3).json',
  ]);
  assert.equal((await stat(f.outputDir)).mode & 0o777, beforeMode);
  assert.deepEqual(await readFile(first.files[0].path), firstBytes);
  assert.deepEqual(JSON.parse(await readFile(second.files[0].path)), auth);
  assert.equal(JSON.parse(await readFile(third.files[0].path)).type, 'codex');
  for (const result of [first, second, third]) assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o600);
});

test('same-email workspaces export independently using numbered filenames', async t => {
  const second = codexAuth();
  second.tokens.account_id = 'workspace-b';
  const f = await fixture(t, [
    { id: 'a', agent: 'codex', user: 'alice@example.com', auth: codexAuth() },
    { id: 'b', agent: 'codex', user: 'alice@example.com', auth: second },
  ]);
  const result = await exportAccounts({ ...f, ids: ['login:a', 'login:b'], format: 'cliproxyapi' });
  assert.deepEqual(result.files.map(file => file.name), ['alice@example.com.json', 'alice@example.com (2).json']);
  assert.deepEqual(await Promise.all(result.files.map(async file => JSON.parse(await readFile(file.path)).account_id)), ['workspace-a', 'workspace-b']);
});

test('email aliases keep their plus sign in the short filename', async t => {
  const auth = codexAuth();
  auth.tokens.id_token = token({ email: 'alice+work@example.com' });
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'display name', auth }]);
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'raw' });
  assert.equal(result.files[0].name, 'alice+work@example.com.json');
});

test('existing files, directories and symlinks are skipped without following or overwriting them', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice', auth: codexAuth() }]);
  await mkdir(f.outputDir);
  const target = path.join(f.base, 'existing-target.json');
  await writeFile(target, 'keep target bytes');
  await symlink(target, path.join(f.outputDir, 'alice@example.com.json'));
  await writeFile(path.join(f.outputDir, 'alice@example.com (2).json'), 'keep export bytes');
  await mkdir(path.join(f.outputDir, 'alice@example.com (3).json'));
  await symlink(path.join(f.base, 'does-not-exist'), path.join(f.outputDir, 'alice@example.com (4).json'));
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'raw' });
  assert.equal(result.files[0].name, 'alice@example.com (5).json');
  assert.equal(await readFile(target, 'utf8'), 'keep target bytes');
  assert.equal(await readFile(path.join(f.outputDir, 'alice@example.com (2).json'), 'utf8'), 'keep export bytes');
  assert.equal((await lstat(path.join(f.outputDir, 'alice@example.com.json'))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(f.outputDir, 'alice@example.com (4).json'))).isSymbolicLink(), true);
  assert.equal((await stat(path.join(f.outputDir, 'alice@example.com (3).json'))).isDirectory(), true);
});

test('concurrent exports publish complete unique numbered files without temporary leftovers', async t => {
  const f = await fixture(t, [{ id: 'a', agent: 'codex', user: 'alice', auth: codexAuth() }]);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => exportAccounts({ ...f, ids: ['login:a'], format: ['raw', 'codex', 'cliproxyapi'][index % 3] })));
  const files = results.map(result => result.files[0]);
  assert.equal(new Set(files.map(file => file.name)).size, 12);
  assert.deepEqual(new Set(files.map(file => file.name)), new Set(Array.from({ length: 12 }, (_, index) => `alice@example.com${index ? ` (${index + 1})` : ''}.json`)));
  const names = await readdir(f.outputDir);
  assert.equal(names.length, 12);
  assert.ok(names.every(name => !name.startsWith('.')));
  for (const [index, file] of files.entries()) {
    assert.equal(path.dirname(file.path), f.outputDir);
    const data = JSON.parse(await readFile(file.path));
    assert.equal(index % 3 === 2 ? data.type : data.auth_mode, index % 3 === 2 ? 'codex' : 'chatgpt');
  }
});

test('a publication failure rolls back only files created by this batch', async t => {
  const second = codexAuth();
  second.tokens.id_token = token({ email: 'bob@example.com' });
  const f = await fixture(t, [
    { id: 'a', agent: 'codex', user: 'alice', auth: codexAuth() },
    { id: 'b', agent: 'codex', user: 'bob', auth: second },
  ]);
  await mkdir(f.outputDir);
  const sentinel = path.join(f.outputDir, 'alice@example.com.json');
  await writeFile(sentinel, 'existing export');
  const original = fsPromises.link;
  let published = 0;
  fsPromises.link = async (from, to) => {
    if (path.basename(to) === 'bob@example.com.json') throw new Error('synthetic-refresh-secret must not leak');
    await original(from, to);
    published++;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(exportAccounts({ ...f, ids: ['login:a', 'login:b'], format: 'raw' }), error => /Could not write/.test(error.message) && !error.message.includes('synthetic-refresh-secret'));
  } finally { fsPromises.link = original; syncBuiltinESMExports(); }
  assert.equal(published, 1, 'failure is injected after one successful publication');
  assert.deepEqual(await readdir(f.outputDir), ['alice@example.com.json']);
  assert.equal(await readFile(sentinel, 'utf8'), 'existing export');
});

test('a failed temporary write closes its handles and leaves existing output untouched', async t => {
  const f = await fixture(t, [
    { id: 'a', agent: 'vendor', user: 'first', auth: { key: 'one' } },
    { id: 'b', agent: 'vendor', user: 'second', auth: { key: 'two' } },
  ]);
  await mkdir(f.outputDir);
  await writeFile(path.join(f.outputDir, 'unrelated.txt'), 'preserve');
  const original = fsPromises.open;
  const handles = [];
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    handles.push(handle);
    if (handles.length === 2) handle.writeFile = async () => { throw new Error('synthetic private write failure'); };
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(exportAccounts({ ...f, ids: ['login:a', 'login:b'], format: 'raw' }), /Could not write/); }
  finally { fsPromises.open = original; syncBuiltinESMExports(); }
  assert.equal(handles.length, 2);
  assert.ok(handles.every(handle => handle.fd === -1));
  assert.deepEqual(await readdir(f.outputDir), ['unrelated.txt']);
});

test('long Unicode identity names stay within filesystem filename byte limits', async t => {
  const f = await fixture(t, [{ id: 'a', agent: '供应商'.repeat(30), user: '中文用户名'.repeat(40), auth: { key: 'synthetic' } }]);
  const result = await exportAccounts({ ...f, ids: ['login:a'], format: 'raw' });
  assert.ok(Buffer.byteLength(result.files[0].name) < 255);
  assert.equal(result.count, 1);
});

test('missing optional source files produce an empty list and invalid source content never leaks into errors', async t => {
  const f = await fixture(t);
  await rm(path.join(f.sourceDir, 'logins.json'));
  await rm(path.join(f.sourceDir, 'plugin-auth.json'));
  assert.deepEqual((await listAccounts(f)).accounts, []);
  await writeFile(path.join(f.sourceDir, 'logins.json'), '[{"auth":"private-secret"');
  await assert.rejects(listAccounts(f), error => /Invalid JSON in logins.json/.test(error.message) && !error.message.includes('private-secret'));
  await writeFile(path.join(f.sourceDir, 'logins.json'), '{"auth":"private-secret"}');
  await assert.rejects(listAccounts(f), /Expected a JSON array/);
});

test('missing record IDs remain stable across credential refreshes and malformed token types stay out of metadata', async t => {
  const rows = [{ agent: 'codex', user: 'alice', auth: { tokens: { access_token: { token: 'never-show-this' } } } }];
  const f = await fixture(t, rows);
  const before = (await listAccounts(f)).accounts[0];
  assert.deepEqual(before.formats, ['raw']);
  rows[0].auth.tokens.access_token = 'new-access';
  await writeFile(path.join(f.sourceDir, 'logins.json'), JSON.stringify(rows));
  assert.equal((await listAccounts(f)).accounts[0].id, before.id);
  assert.doesNotMatch(JSON.stringify(before), /never-show-this/);
});

test('fallback IDs follow the same workspace when equal-label source accounts reorder', async t => {
  const firstAuth = codexAuth();
  const secondAuth = codexAuth();
  secondAuth.tokens.id_token = token({ email: 'alice@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-b' } });
  const rows = [
    { agent: 'codex', user: 'alice@example.com', auth: firstAuth },
    { agent: 'codex', user: 'alice@example.com', auth: secondAuth },
  ];
  const f = await fixture(t, rows);
  const before = await listAccounts(f);
  const selectedID = before.accounts[0].id;
  assert.notEqual(selectedID, before.accounts[1].id);
  await writeFile(path.join(f.sourceDir, 'logins.json'), JSON.stringify([...rows].reverse()));
  const after = await listAccounts(f);
  assert.equal(after.accounts[1].id, selectedID);
  const exported = await exportAccounts({ ...f, ids: [selectedID], format: 'cliproxyapi' });
  assert.equal(JSON.parse(await readFile(exported.files[0].path)).account_id, 'workspace-a');
});

test('ambiguous accounts without saved IDs fail instead of using a source row index', async t => {
  const f = await fixture(t, [
    { agent: 'codex', user: 'alice', auth: { tokens: { access_token: 'opaque-first' } } },
    { agent: 'codex', user: 'alice', auth: { tokens: { access_token: 'opaque-second' } } },
  ]);
  await assert.rejects(listAccounts(f), /Duplicate account IDs/);
  await assert.rejects(exportAccounts({ ...f, ids: ['stale-selection'], format: 'raw' }), /Duplicate account IDs/);
  await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('default config honors only absolute XDG_CONFIG_HOME', () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = '/private/tmp/isolated-xdg';
    assert.equal(defaultConfigDir(), '/private/tmp/isolated-xdg/magpie');
    process.env.XDG_CONFIG_HOME = 'relative-value';
    assert.notEqual(defaultConfigDir(), 'relative-value/magpie');
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test('duplicate stable source IDs fail before an export can select the wrong credentials', async t => {
  const f = await fixture(t, [
    { id: 'duplicate', agent: 'codex', user: 'a', auth: codexAuth() },
    { id: 'duplicate', agent: 'codex', user: 'b', auth: codexAuth() },
  ]);
  await assert.rejects(listAccounts(f), /Duplicate account IDs/);
  assert.deepEqual(await readdir(f.base), ['source']);
});
