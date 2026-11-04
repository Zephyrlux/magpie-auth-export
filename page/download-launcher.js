'use strict';

// Delay hello until the local document is ready, so a provider-menu action
// reaches the account picker instead of the document navigating away.
(() => {
  const status = document.getElementById('download-status');
  const pending = new Map();
  let next = 0;
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.magpie !== 1) return;
    const reply = pending.get(event.data.id);
    if (!reply) return;
    pending.delete(event.data.id);
    clearTimeout(reply.timeout);
    if (event.data.error) reply.reject(new Error(String(event.data.error)));
    else reply.resolve(event.data.result);
  });
  function call(method) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('连接 Magpie 超时，请重新打开插件。')); }, 5000);
      pending.set(id, { resolve, reject, timeout });
      parent.postMessage({ magpie: 1, id, method }, '*');
    });
  }
  void (async () => {
    try {
      if (parent === window) throw new Error('请从 Magpie 的插件页面打开。');
      const [options, theme] = await Promise.all([call('options.get'), call('theme')]);
      const port = Number(options?.port ?? 34821);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('导出服务端口无效。');
      const destination = new URL(`http://127.0.0.1:${port}/download`);
      destination.searchParams.set('theme', theme?.dark ? 'dark' : 'light');
      location.replace(destination.href);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '无法读取账号，请重新打开插件。';
      status.hidden = false;
      status.dataset.state = 'error';
      status.setAttribute('role', 'alert');
    }
  })();
})();
