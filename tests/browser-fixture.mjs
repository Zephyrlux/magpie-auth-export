import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from '../lib/service.js';
const root = await mkdtemp(join(tmpdir(), 'magpie-export-browser-'));
const sourceDir = join(root, 'source'), outputDir = join(root, 'exports');
await mkdir(sourceDir);
await writeFile(join(sourceDir, 'logins.json'), JSON.stringify([
  { id: 'demo', agent: 'codex', user: 'demo@example.com', plan: 'Plus', auth: { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', account_id: 'workspace-demo' } } },
  { id: 'team', agent: 'codex', user: 'demo@example.com · Team', plan: 'Team', auth: { tokens: { access_token: 'fake-team', refresh_token: 'fake-team-refresh', account_id: 'workspace-team' } } },
  { id: 'claude', agent: 'claude', user: 'claude@example.com', plan: 'Max', auth: { claudeAiOauth: { accessToken: 'fake-claude', refreshToken: 'fake-claude-refresh', expiresAt: 1900000000000 } } },
]));
const service = await startService({ port: 34824, sourceDir, outputDir });
const wrapper = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Magpie sandbox fixture</title><h2>Codex</h2><p>账号：demo@example.com / demo@example.com · Team</p><section style="max-width:620px"><h3>认证导出</h3><iframe title="认证导出" sandbox="allow-scripts" src="http://127.0.0.1:34824/panel?provider=codex" style="border:0;width:100%;height:160px"></iframe><p><button>取消</button> <button>保存</button></p></section>');
});
await new Promise(r => wrapper.listen(34825, '127.0.0.1', r));
console.log('Synthetic UI fixture: http://127.0.0.1:34825 (sandbox), http://127.0.0.1:34824 (direct)');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await service.close(); wrapper.closeAllConnections(); await new Promise(r => wrapper.close(r)); await rm(root, { recursive: true, force: true });
});
