'use strict';

(() => {
  const token = document.querySelector('meta[name="export-session"]')?.content || '';
  const provider = document.getElementById('download-provider');
  const format = document.getElementById('download-format');
  const button = document.getElementById('download-export');
  const status = document.getElementById('download-status');
  const list = document.getElementById('download-accounts');
  const count = document.getElementById('account-selection-count');
  const selectAll = document.getElementById('account-select-all');
  const refresh = document.getElementById('accounts-refresh');
  const section = document.querySelector('.account-section');
  const query = new URLSearchParams(location.search);
  const selected = new Set();
  let accounts = [];
  let loaded = false;
  let loading = false;
  let busy = false;
  let pendingProvider = null;
  const helloID = 9001;
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  // A URL kept from an older version must never export on load or restore.
  if (location.hash) { try { location.hash = ''; } catch { /* no export */ } }

  function setProvider(id, label = id) {
    if (typeof id !== 'string' || !id) return;
    if (![...provider.options].some(option => option.value === id)) {
      const option = document.createElement('option');
      option.value = id; option.textContent = label; provider.append(option);
    }
    provider.value = id;
  }
  setProvider(query.get('provider') || 'codex');
  if (['cliproxyapi', 'codex', 'raw'].includes(query.get('format'))) format.value = query.get('format');
  else if (!['codex', 'claude'].includes(provider.value)) format.value = 'raw';

  function message(text = '', error = false, detail = '', fullPaths = '') {
    status.replaceChildren();
    if (text) {
      const title = document.createElement('span');
      title.className = 'status-title'; title.textContent = text; status.append(title);
    }
    if (detail) {
      const path = document.createElement('span');
      path.className = 'status-path'; path.textContent = detail; path.title = fullPaths || detail; status.append(path);
    }
    status.classList.toggle('error', error);
    status.dataset.state = error ? 'error' : detail ? 'success' : 'busy';
    status.hidden = !text;
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function currentAccounts() { return accounts.filter(account => account.provider === provider.value); }
  function supports(account) { return Array.isArray(account.formats) && account.formats.includes(format.value); }
  function compatible() { return currentAccounts().filter(supports); }
  function pruneSelection() {
    const eligible = new Set(compatible().map(account => account.id));
    for (const id of selected) if (!eligible.has(id)) selected.delete(id);
  }
  function updateControls() {
    const eligible = compatible();
    const chosen = eligible.filter(account => selected.has(account.id));
    button.disabled = busy || loading || !loaded || chosen.length === 0;
    button.setAttribute('aria-busy', String(busy));
    const label = button.querySelector('.button-label');
    if (label) label.textContent = busy ? '正在下载…' : '下载认证文件';
    provider.disabled = format.disabled = busy || loading;
    refresh.disabled = busy || loading;
    selectAll.disabled = busy || loading || !loaded || eligible.length === 0;
    selectAll.checked = eligible.length > 0 && chosen.length === eligible.length;
    selectAll.indeterminate = chosen.length > 0 && chosen.length < eligible.length;
    count.textContent = `已选 ${chosen.length} / ${eligible.length} 个`;
    section.setAttribute('aria-busy', String(loading || busy));
    for (const input of list.querySelectorAll('input[type="checkbox"]')) {
      const account = accounts.find(item => item.id === input.value);
      input.checked = selected.has(input.value);
      input.disabled = busy || loading || !account || !supports(account);
    }
  }
  function renderAccounts() {
    pruneSelection();
    list.replaceChildren();
    const visible = currentAccounts();
    if (loading || !loaded || visible.length === 0) {
      list.dataset.state = loading ? 'loading' : loaded ? 'empty' : 'error';
      const empty = document.createElement('p');
      empty.className = 'accounts-empty';
      empty.textContent = loading ? '正在读取账号…' : loaded ? '此提供商暂无已保存的账号。' : '账号读取失败，请点击刷新重试。';
      list.append(empty);
    } else {
      list.dataset.state = 'ready';
      for (const account of visible) {
        const row = document.createElement('label');
        row.className = `account-row${supports(account) ? '' : ' unsupported'}`;
        const input = document.createElement('input');
        input.type = 'checkbox'; input.value = account.id;
        input.setAttribute('aria-label', account.user || account.id);
        input.addEventListener('change', () => {
          if (input.checked) selected.add(account.id); else selected.delete(account.id);
          message(); updateControls();
        });
        const details = document.createElement('span');
        details.className = 'account-details';
        const user = document.createElement('span');
        user.className = 'account-user'; user.textContent = account.user || account.id;
        const plan = document.createElement('span');
        plan.className = 'account-plan';
        const notes = [account.plan];
        if (visible.some(other => other.id !== account.id && other.user === account.user)) notes.push(`账号 ${account.id.split(':').pop().slice(-12)}`);
        if (account.disabled) notes.push('已停用');
        if (!supports(account)) notes.push('此格式不支持');
        plan.textContent = notes.filter(Boolean).join(' · ');
        plan.hidden = !plan.textContent;
        details.append(user, plan); row.append(input, details); list.append(row);
      }
    }
    updateControls();
  }
  async function api(route, body) {
    const response = await fetch(`api/${route}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'X-Export-Session': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('导出服务返回异常，请重新打开插件。'); }
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '操作失败，请重试。');
    return result;
  }
  async function loadAccounts() {
    if (busy || loading) return;
    loading = true;
    message(); renderAccounts();
    try {
      const result = await api('accounts');
      if (!Array.isArray(result.accounts)) throw new Error('账号列表格式异常。');
      if (typeof result.outputDir === 'string') {
        const destination = result.outputDir.split(/[\\/]/).filter(Boolean).pop() || result.outputDir;
        const note = document.querySelector('.download-note');
        note.textContent = destination.toLowerCase() === 'downloads' ? '保存到下载文件夹' : `保存到 ${destination}`;
        note.title = result.outputDir;
      }
      accounts = result.accounts;
      for (const account of accounts) {
        if (typeof account.provider !== 'string' || !account.provider || [...provider.options].some(option => option.value === account.provider)) continue;
        const option = document.createElement('option');
        option.value = account.provider; option.textContent = account.provider; provider.append(option);
      }
      loaded = true;
    } catch (error) {
      loaded = false; selected.clear();
      message(error instanceof Error ? error.message : '读取账号失败。', true);
    } finally {
      loading = false; renderAccounts();
    }
  }
  function chooseProvider(id, name) {
    if (busy) { pendingProvider = { id, name }; return; }
    setProvider(id, name);
    if (id === 'claude' && format.value === 'codex') format.value = 'cliproxyapi';
    else if (!['codex', 'claude'].includes(id)) format.value = 'raw';
    selected.clear(); message(); renderAccounts();
  }
  async function exportSelected() {
    if (busy || loading || !loaded) return;
    const ids = compatible().filter(account => selected.has(account.id)).map(account => account.id);
    if (!ids.length) return;
    busy = true; updateControls(); message('正在导出所选账号…');
    try {
      const exported = await api('export', { ids, format: format.value });
      if (exported.count !== ids.length) throw new Error('导出数量与所选账号不一致，请检查保存目录。');
      message(`已导出 ${exported.count} 个文件`, false,
        exported.files.map(file => file.name).join('\n'), exported.files.map(file => file.path).join('\n'));
    } catch (error) {
      message(error instanceof Error ? error.message : '导出失败，请重试。', true);
    } finally {
      busy = false; updateControls();
      if (pendingProvider) {
        const next = pendingProvider; pendingProvider = null; chooseProvider(next.id, next.name);
      }
    }
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const data = event.data;
    const paint = value => {
      if (!value) return;
      document.documentElement.dataset.theme = value.dark ? 'dark' : 'light';
      document.documentElement.lang = value.lang || 'zh-CN';
      for (const [key, color] of Object.entries(value.tokens || {})) {
        if (/^[a-zA-Z0-9-]+$/.test(key) && typeof color === 'string') document.documentElement.style.setProperty(`--magpie-${key}`, color);
      }
    };
    if (data.id === helloID && !data.error) paint(data.result);
    if (data.event === 'theme') paint(data.data);
    const action = data.event === 'action' ? data.data : null;
    if (action?.id === 'export-auth' && typeof action.provider?.id === 'string') chooseProvider(action.provider.id, action.provider.name);
  });
  provider.addEventListener('change', () => chooseProvider(provider.value));
  format.addEventListener('change', () => { message(); renderAccounts(); });
  refresh.addEventListener('click', () => void loadAccounts());
  selectAll.addEventListener('change', () => {
    for (const account of compatible()) {
      if (selectAll.checked) selected.add(account.id); else selected.delete(account.id);
    }
    message(); updateControls();
  });
  button.addEventListener('click', () => void exportSelected());
  if (parent !== window) parent.postMessage({ magpie: 1, id: helloID, method: 'hello' }, '*');
  void loadAccounts();
})();
