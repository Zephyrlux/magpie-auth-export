#!/usr/bin/env node
import { listAccounts, exportAccounts } from './lib/exporter.js';
import { startService, defaultOutputDir } from './lib/service.js';

const usage = `用法：
  node cli.js list [--source-dir <Magpie配置目录>]
  node cli.js export --format codex|cliproxyapi|raw --all|--account <ID> [--output-dir <目录>]
  node cli.js serve [--port 34821] [--source-dir <目录>] [--output-dir <目录>]
导出不刷新令牌、不切换账号、不改动 Magpie 登录文件。`;

async function main(args) {
  const command = args.shift();
  if (!command || ['--help', '-h', 'help'].includes(command)) return console.log(usage);
  if (!['list', 'export', 'serve'].includes(command)) throw new Error(usage);
  const options = {}, ids = [];
  let all = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--all') { all = true; continue; }
    const names = { '--source-dir': 'sourceDir', '--output-dir': 'outputDir', '--format': 'format', '--port': 'port', '--account': 'account' };
    const key = names[flag];
    if (!key || !args[0] || args[0].startsWith('--')) throw new Error('选项无效。\n' + usage);
    const value = args.shift();
    if (key === 'account') ids.push(value); else options[key] = value;
  }
  if (command === 'list') return console.log(JSON.stringify(await listAccounts(options), null, 2));
  if (command === 'serve') {
    const service = await startService({ ...options, ...(options.port === undefined ? {} : { port: Number(options.port) }) });
    console.log(`认证导出：${service.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
    return;
  }
  if (!['raw', 'codex', 'cliproxyapi'].includes(options.format)) throw new Error('请用 --format 选择导出格式。');
  if (all === (ids.length > 0)) throw new Error('请选择 --all 或至少一个 --account。');
  if (all) {
    const { accounts } = await listAccounts(options);
    ids.push(...accounts.filter(a => a.formats.includes(options.format)).map(a => a.id));
  }
  console.log(JSON.stringify(await exportAccounts({ ...options, ids, outputDir: options.outputDir ?? defaultOutputDir() }), null, 2));
}

main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : '操作失败。'); process.exitCode = 1; });
