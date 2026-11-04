import { startService } from './lib/service.js';

// Magpie treats every exported function in this entry as an OpenCode plugin.
// The exporter contributes a download page and an explicit provider-menu
// action, with no agent/MCP tools or gateway request hooks.
export const AuthExportPlugin = async (input, options = {}) => {
  const slot = Symbol.for('magpie-auth-export.service');
  if (!globalThis[slot]) {
    const port = Number(options.port ?? 34821);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('认证导出端口无效。');
    // Cache the startup promise before yielding: multiple loads in the same
    // host must share one listener, including while its assets are being read.
    globalThis[slot] = startService({
      port,
      sourceDir: options.sourceDir ?? input?.directory,
      outputDir: options.outputDir,
    }).then(service => {
      // The RPC pipe keeps Magpie's host alive. A one-shot CLI must release
      // this listener once its pipe closes.
      service.server.unref();
      return service;
    });
  }
  const pending = globalThis[slot];
  try {
    await pending;
  } catch (error) {
    // A later load may retry after a temporary port conflict is resolved.
    if (globalThis[slot] === pending) delete globalThis[slot];
    throw error;
  }
  return {};
};
