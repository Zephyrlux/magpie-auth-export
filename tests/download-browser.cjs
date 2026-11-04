// Isolated browser integration check. Requires Playwright on NODE_PATH.
// Only synthetic credentials and temporary export directories are used. The
// parent implements Magpie's documented bridge and waits for service hello
// before delivering the first provider-menu action, as native open() does.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const jwt = value => `e30.${Buffer.from(JSON.stringify(value)).toString('base64url')}.fixture`;

async function fixture({ sameEmail = false, dark = true } = {}) {
  const base = await fs.mkdtemp('/private/tmp/magpie-download-browser-');
  const sourceDir = path.join(base, 'source');
  const outputDir = path.join(base, 'exports');
  await fs.mkdir(sourceDir);
  const rows = [1, 2].map(number => {
    const email = sameEmail ? 'shared@example.com' : `synthetic${number}@example.com`;
    return {
      id: `codex-${number}`, agent: 'codex', user: email, plan: 'team',
      auth: { auth_mode: 'chatgpt', tokens: {
        access_token: jwt({ exp: 1800000000 }), refresh_token: `synthetic-codex-refresh-${number}`,
        id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: `synthetic-workspace-${number}`, chatgpt_plan_type: 'team' } }),
      } },
    };
  });
  rows.push({ id: 'claude-1', agent: 'claude', user: 'synthetic-claude@example.com',
    profile: { emailAddress: 'synthetic-claude@example.com' },
    auth: { claudeAiOauth: { accessToken: 'synthetic-claude-access', refreshToken: 'synthetic-claude-refresh', expiresAt: 1800000000000 } },
  });
  rows.push({ id: 'legacy-1', agent: 'legacy', user: 'synthetic-legacy@example.com', auth: { key: 'synthetic-raw-only' } });
  const writeRows = next => fs.writeFile(path.join(sourceDir, 'logins.json'), JSON.stringify(next));
  await writeRows(rows);
  const before = await fs.readFile(path.join(sourceDir, 'logins.json'));
  const { startService } = await import(pathToFileURL(path.join(root, 'lib/service.js')));
  const service = await startService({ port: 0, sourceDir, outputDir });
  const port = new URL(service.url).port;
  let exportRequests = 0;
  service.server.on('request', request => { if(request.method === 'POST' && request.url === '/api/export') exportRequests++; });
  const parentHTML = `<!doctype html><meta charset="utf-8"><title>Isolated Magpie plugin bridge</title>
    <style>body{margin:0;background:${dark ? '#1a1a1e' : '#f4f4f6'};font:14px sans-serif}header{padding:8px}iframe{border:0;width:100%;height:650px}</style>
    <header><button id="menu-codex">Codex action</button> <button id="menu-claude">Claude action</button></header>
    <iframe id="plugin" sandbox="allow-scripts" allow="local-network-access" src="/launcher"></iframe>
    <script>
      const frame=document.getElementById('plugin');
      let ready=false, queued=[];
      window.bridgeEvents=[];
      function postAction(provider){frame.contentWindow.postMessage({magpie:1,event:'action',data:{id:'export-auth',provider:{id:provider,name:provider}}},'*');}
      function sendAction(provider){if(ready)postAction(provider);else queued.push(provider);}
      window.openFreshAction=provider=>{ready=false;queued=[provider];frame.src='/launcher?fresh='+Date.now();};
      document.getElementById('menu-codex').onclick=()=>sendAction('codex');
      document.getElementById('menu-claude').onclick=()=>sendAction('claude');
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.data?.magpie!==1||!event.data.id)return;
        const message=event.data;
        bridgeEvents.push({method:message.method,id:message.id});
        const theme={dark:${dark},lang:'zh',tokens:{},context:{},service:''};
        const result=message.method==='hello'||message.method==='theme'?theme:message.method==='options.get'?{port:${port}}:null;
        event.source.postMessage({magpie:1,id:message.id,result},'*');
        if(message.method==='hello'){ready=true;for(const provider of queued.splice(0))postAction(provider);}
      });
    </script>`;
  let wrapperOrigin;
  const wrapper = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if(route === '/') { response.setHeader('Content-Type', 'text/html'); return response.end(parentHTML); }
    const file = { '/launcher': 'download.html', '/download.css': 'download.css', '/download-launcher.js': 'download-launcher.js', '/icon.svg': 'icon.svg' }[route];
    if(!file) { response.statusCode=404; return response.end(); }
    response.setHeader('Content-Type', { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' }[path.extname(file)]);
    response.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src ${wrapperOrigin}; style-src ${wrapperOrigin} 'unsafe-inline'; img-src ${wrapperOrigin}; connect-src 'none'`);
    try { response.end(await fs.readFile(path.join(root, 'page', file))); }
    catch { response.statusCode=500; response.end(); }
  });
  await new Promise(resolve => wrapper.listen(0, '127.0.0.1', () => { wrapperOrigin=`http://127.0.0.1:${wrapper.address().port}`; resolve(); }));
  return {
    base, sourceDir, outputDir, before, rows, writeRows, service, wrapperOrigin,
    requests: () => exportRequests,
    files: async () => {
      const entries = await fs.readdir(outputDir, {withFileTypes:true}).catch(error => {if(error.code==='ENOENT')return [];throw error;});
      assert.ok(entries.every(entry=>entry.isFile()), 'exports must leave only files directly in the output directory');
      return entries.map(entry=>entry.name).sort();
    },
    close: async () => { await service.close(); await new Promise(resolve=>{wrapper.closeAllConnections();wrapper.close(resolve);}); await fs.rm(base,{recursive:true,force:true}); },
  };
}

const accountChecks = child => child.locator('#download-accounts input[type="checkbox"]');
const account = (child, id) => child.locator('#download-accounts input').filter({ visible: true }).and(child.locator(`input[value="${id}"]`));

async function readyPicker(page, expectedCount) {
  const child = page.frameLocator('#plugin');
  await child.locator('#download-accounts[data-state="ready"]').waitFor();
  await child.locator('#accounts-refresh:enabled').waitFor();
  assert.equal(await accountChecks(child).count(), expectedCount);
  return child;
}

async function openBrowser(engine, f, width = 920) {
  const browser = await (engine==='webkit' ? webkit.launch() : chromium.launch({channel:'chromium'}));
  const context = await browser.newContext({viewport:{width,height:760},reducedMotion:'reduce',colorScheme:'dark'});
  if(engine==='chromium') await context.grantPermissions(['local-network-access']);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const failures = [], posts = [];
  page.on('pageerror',error=>failures.push(error.message));
  page.on('request',request=>{if(request.url()===`${f.service.url}/api/export`&&request.method()==='POST')posts.push(request.postDataJSON());});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(f.wrapperOrigin);
  return {browser,context,page,failures,posts};
}

async function downloadSelected(page, f, previous, count) {
  const completed = page.waitForResponse(response=>response.url()===`${f.service.url}/api/export`&&response.request().method()==='POST');
  await page.frameLocator('#plugin').locator('#download-export').click();
  const response = await completed;
  assert.equal(response.status(),200);
  const exported = await response.json();
  assert.equal(exported.directory,f.outputDir);
  assert.equal(exported.count,count);
  assert.ok(exported.files.every(file=>path.dirname(file.path)===f.outputDir), 'each result path must be directly in the output directory');
  await page.frameLocator('#plugin').locator('#download-status').filter({hasText:`已导出 ${count} 个文件`}).waitFor();
  const statusPath=page.frameLocator('#plugin').locator('#download-status .status-path');
  assert.equal(await statusPath.textContent(),exported.files.map(file=>file.name).join('\n'), 'UI shows short filenames without a batch folder or full path');
  assert.equal(await statusPath.getAttribute('title'),exported.files.map(file=>file.path).join('\n'), 'full direct file paths are available in the tooltip');
  const after=await f.files();
  assert.equal(after.length,previous.length+count);
  const directory=f.outputDir;
  const files=after.filter(name=>!previous.includes(name));
  assert.equal(files.length,count);
  assert.deepEqual(new Set(files),new Set(exported.files.map(file=>file.name)));
  assert.ok(files.every(name=>/^[^/\\]+@[^/\\]+(?: \(\d+\))?\.json$/.test(name)), 'export names use email.json with a sequence suffix only when needed');
  return {after,files,directory,data:await Promise.all(files.map(name=>fs.readFile(path.join(directory,name),'utf8').then(JSON.parse)))};
}

async function screenshot(page, engine, width, state) {
  if(!process.env.ARTIFACT_DIR)return;
  const frame=page.frames().find(frame=>frame.url().includes('/download'));
  const metrics=await frame.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,bg:getComputedStyle(document.documentElement).backgroundColor}));
  assert.equal(metrics.overflow,false);
  assert.equal(metrics.bg,'rgb(26, 26, 30)');
  await fs.mkdir(process.env.ARTIFACT_DIR,{recursive:true});
  await page.frameLocator('#plugin').locator('body').screenshot({path:path.join(process.env.ARTIFACT_DIR,`${engine}-dark-${width}-${state}.png`)});
}

for(const engine of process.env.BROWSER ? [process.env.BROWSER] : ['webkit','chromium']) {
  for(const width of [920,420]) {
    test(`${engine} ${width}: only checked accounts export; navigation and provider actions never export`, {timeout:120000}, async t=>{
      const f=await fixture();t.after(()=>f.close());
      const b=await openBrowser(engine,f,width);t.after(()=>b.browser.close());
      const {page,posts,failures}=b;
      const child=await readyPicker(page,2);
      assert.equal(await page.locator('#plugin').getAttribute('sandbox'),'allow-scripts');
      assert.equal(await child.locator('#download-export').isDisabled(),true);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(await child.locator('#account-selection-count').textContent(),'已选 0 / 2 个');
      assert.equal(f.requests(),0);
      const bridge=await page.evaluate(()=>bridgeEvents);
      assert.deepEqual(bridge.slice(0,2).map(event=>event.method).sort(),['options.get','theme']);
      assert.deepEqual(bridge.filter(event=>event.method==='hello').map(event=>event.id),[9001]);
      await screenshot(page,engine,width,'unchecked');

      await account(child,'login:codex-2').check();
      assert.equal(await child.locator('#account-select-all').evaluate(input=>input.indeterminate),true);
      await screenshot(page,engine,width,'one-selected');
      let result=await downloadSelected(page,f,[],1);
      assert.deepEqual(posts.at(-1),{ids:['login:codex-2'],format:'cliproxyapi'});
      assert.equal(result.data[0].account_id,'synthetic-workspace-2');
      assert.equal(result.data[0].email,'synthetic2@example.com');
      assert.deepEqual(result.files,['synthetic2@example.com.json']);
      await screenshot(page,engine,width,'success');
      await child.locator('#account-select-all').check();
      result=await downloadSelected(page,f,result.after,2);
      assert.deepEqual(posts.at(-1).ids,['login:codex-1','login:codex-2']);
      assert.deepEqual(new Set(result.data.map(data=>data.account_id)),new Set(['synthetic-workspace-1','synthetic-workspace-2']));
      assert.deepEqual(result.files,['synthetic1@example.com.json','synthetic2@example.com (2).json']);
      await child.locator('#account-select-all').uncheck();
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(await child.locator('#download-export').isDisabled(),true);

      await account(child,'login:codex-1').check();
      await child.locator('#download-provider').selectOption('claude');
      await readyPicker(page,1);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0,'provider changes clear selection');
      assert.equal(await child.locator('#download-export').isDisabled(),true);
      await child.locator('#download-provider').selectOption('codex');
      await readyPicker(page,2);
      await account(child,'login:codex-1').check();
      await f.writeRows(f.rows.filter(row=>row.id!=='codex-1'));
      await child.locator('#accounts-refresh').click();
      await child.locator('#download-accounts input[value="login:codex-1"]').waitFor({state:'detached'});
      await readyPicker(page,1);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0,'removed selected account is pruned without selecting another');
      assert.equal(await child.locator('#download-export').isDisabled(),true);
      assert.equal(f.requests(),2);

      await child.locator('#download-provider').selectOption('legacy');
      await readyPicker(page,1);
      assert.equal(await child.locator('#download-format').inputValue(),'raw');
      await account(child,'login:legacy-1').check();
      await child.locator('#download-format').selectOption('codex');
      assert.equal(await account(child,'login:legacy-1').isDisabled(),true,'unsupported format disables row');
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(await child.locator('#download-export').isDisabled(),true);
      await child.locator('#download-format').selectOption('raw');
      assert.equal(await account(child,'login:legacy-1').isChecked(),false);

      await f.writeRows(f.rows);
      await page.evaluate(()=>openFreshAction('claude'));
      await child.locator('#download-provider option:checked[value="claude"]').waitFor({state:'attached'});
      await readyPicker(page,1);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(f.requests(),2,'the first non-default provider action waits for service hello and never exports');
      await page.evaluate(()=>openFreshAction('codex'));
      await child.locator('#download-provider option:checked[value="codex"]').waitFor({state:'attached'});
      await readyPicker(page,2);
      assert.equal(await child.locator('#download-provider').inputValue(),'codex');
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(f.requests(),2,'first context action only opens selection');
      await account(child,'login:codex-1').check();
      await page.locator('#menu-codex').click();
      await child.locator('#download-export:disabled').waitFor();
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(f.requests(),2,'repeated context action only opens selection');
      await page.locator('#menu-claude').click();
      await child.locator('#download-provider').filter({has:child.locator('option:checked[value="claude"]')}).waitFor();
      await readyPicker(page,1);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(f.requests(),2);
      await account(child,'login:claude-1').check();
      result=await downloadSelected(page,f,result.after,1);
      assert.deepEqual(posts.at(-1),{ids:['login:claude-1'],format:'cliproxyapi'});
      assert.equal(result.data[0].type,'claude');
      assert.equal(result.data[0].email,'synthetic-claude@example.com');
      assert.deepEqual(result.files,['synthetic-claude@example.com.json']);

      const frame=page.frames().find(frame=>frame.url().startsWith(`${f.service.url}/download`));
      await frame.evaluate(()=>{location.hash='auto=1';location.reload();});
      await readyPicker(page,2);
      assert.equal(await child.locator('#download-accounts input:checked').count(),0);
      assert.equal(await child.locator('#download-export').isDisabled(),true);
      assert.equal(f.requests(),3,'refresh and legacy auto intent do not export');
      assert.equal(await frame.evaluate(()=>location.hash),'');
      assert.deepEqual(await f.files(),result.after);
      assert.deepEqual(await fs.readFile(path.join(f.sourceDir,'logins.json')),f.before,'the app never changes source credentials');
      assert.deepEqual(failures,[]);
      await b.context.close();
    });
  }

  test(`${engine}: equal display emails keep separate workspace checkboxes`, {timeout:60000}, async t=>{
    const f=await fixture({sameEmail:true});t.after(()=>f.close());
    const b=await openBrowser(engine,f,420);t.after(()=>b.browser.close());
    const child=await readyPicker(b.page,2);
    assert.deepEqual(await child.locator('.account-user').allTextContents(),['shared@example.com','shared@example.com']);
    const hints=await child.locator('.account-plan').allTextContents();
    assert.notEqual(hints[0],hints[1],'duplicate emails have distinct account hints');
    assert.equal(await child.locator('#download-accounts input:checked').count(),0);
    await account(child,'login:codex-2').check();
    const result=await downloadSelected(b.page,f,[],1);
    assert.equal(result.data[0].account_id,'synthetic-workspace-2');
    assert.equal(result.data[0].email,'shared@example.com');
    assert.deepEqual(result.files,['shared@example.com.json']);
    assert.deepEqual(b.posts,[{ids:['login:codex-2'],format:'cliproxyapi'}]);
    assert.deepEqual(b.failures,[]);
    await b.context.close();
  });
}
