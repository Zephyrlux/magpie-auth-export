import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, mkdir, open, link, readFile, realpath, unlink } from 'node:fs/promises';

const FORMATS = new Set(['raw', 'codex', 'cliproxyapi']);
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function defaultConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.config'), 'magpie');
}

function directory(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a directory path.`);
  }
  return path.resolve(value);
}

async function readOptional(sourceDir, name, expected) {
  let data;
  try {
    const info = await lstat(path.join(sourceDir, name));
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error('not a file');
    if (info.size > MAX_SOURCE_BYTES) throw new Error('too large');
    data = await readFile(path.join(sourceDir, name), 'utf8');
    if (Buffer.byteLength(data) > MAX_SOURCE_BYTES) throw new Error('too large');
  } catch (error) {
    if (error?.code === 'ENOENT') return expected === 'array' ? [] : {};
    throw new Error(`Cannot read ${name}. Check its file permissions and size.`);
  }
  let parsed;
  try { parsed = JSON.parse(data.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON in ${name}. The source file was left unchanged.`); }
  if (expected === 'array' ? !Array.isArray(parsed) : !object(parsed)) {
    throw new Error(`Invalid structure in ${name}. Expected a JSON ${expected}.`);
  }
  return parsed;
}

function jwtClaims(token) {
  if (typeof token !== 'string' || token.length > 1024 * 1024) return {};
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return {};
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return object(parsed) ? parsed : {};
  } catch { return {}; }
}

function dateString(value, milliseconds = false) {
  if (milliseconds && typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || value.startsWith('0001-')) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function codexData(record) {
  const auth = record.auth;
  if (record.provider !== 'codex' || !object(auth.tokens) || !string(auth.tokens.access_token) || auth.auth_mode === 'apikey') return null;
  const tokens = auth.tokens;
  const identity = jwtClaims(tokens.id_token);
  const access = jwtClaims(tokens.access_token);
  const claim = object(identity['https://api.openai.com/auth']) ? identity['https://api.openai.com/auth'] : {};
  const accessClaim = object(access['https://api.openai.com/auth']) ? access['https://api.openai.com/auth'] : {};
  const email = string(identity.email) || string(access.email) || (/^[^\s@]+@[^\s@]+$/.test(record.user) ? record.user : '');
  const exp = typeof access.exp === 'number' && Number.isFinite(access.exp) && access.exp > 0 ? access.exp : 0;
  return {
    id_token: string(tokens.id_token),
    access_token: tokens.access_token,
    refresh_token: string(tokens.refresh_token),
    account_id: string(tokens.account_id) || string(claim.chatgpt_account_id) || string(accessClaim.chatgpt_account_id),
    last_refresh: dateString(auth.last_refresh) || dateString(record.renewed),
    email,
    type: 'codex',
    expired: exp ? dateString(exp * 1000, true) : '',
    plan_type: string(claim.chatgpt_plan_type) || string(accessClaim.chatgpt_plan_type) || record.plan || 'free',
  };
}

function claudeData(record) {
  const oauth = record.auth.claudeAiOauth;
  if (record.provider !== 'claude' || !object(oauth) || !string(oauth.accessToken)) return null;
  const profile = object(record.profile) ? record.profile : {};
  const data = {
    id_token: '',
    access_token: oauth.accessToken,
    refresh_token: string(oauth.refreshToken),
    last_refresh: dateString(record.auth.last_refresh) || dateString(record.renewed),
    email: string(profile.emailAddress) || (/^[^\s@]+@[^\s@]+$/.test(record.user) ? record.user : ''),
    type: 'claude',
    expired: dateString(oauth.expiresAt, true),
  };
  const account = string(profile.accountUuid) || string(oauth.accountUuid);
  const organization = string(profile.organizationUuid) || string(oauth.organizationUuid);
  if (account) data.account_uuid = account;
  if (organization) data.organization_uuid = organization;
  if (string(profile.organizationName)) data.organization_name = profile.organizationName;
  return data;
}

function metadata(record) {
  const formats = ['raw'];
  const codex = codexData(record);
  if (codex) formats.push('codex', 'cliproxyapi');
  else if (claudeData(record)) formats.push('cliproxyapi');
  const refresh = codex?.refresh_token || record.auth.claudeAiOauth?.refreshToken || record.auth.refresh;
  const result = {
    id: record.id,
    provider: record.provider,
    user: record.user,
    plan: record.plan,
    formats,
    hasRefreshToken: typeof refresh === 'string' && refresh.length > 0,
  };
  if (record.disabled) result.disabled = true;
  return result;
}

function fallbackLoginID(entry, provider, user) {
  const tokens = object(entry.auth.tokens) ? entry.auth.tokens : {};
  const identity = jwtClaims(tokens.id_token);
  const access = jwtClaims(tokens.access_token);
  const identityClaim = object(identity['https://api.openai.com/auth']) ? identity['https://api.openai.com/auth'] : {};
  const accessClaim = object(access['https://api.openai.com/auth']) ? access['https://api.openai.com/auth'] : {};
  const profile = object(entry.profile) ? entry.profile : {};
  const oauth = object(entry.auth.claudeAiOauth) ? entry.auth.claudeAiOauth : {};
  // Credentials rotate and source rows can move. Only stable account identity
  // participates; duplicate identities are rejected by snapshot below.
  return hash(JSON.stringify([
    provider, user, string(entry.home),
    string(tokens.account_id) || string(identityClaim.chatgpt_account_id) || string(accessClaim.chatgpt_account_id),
    string(profile.accountUuid) || string(oauth.accountUuid),
    string(profile.organizationUuid) || string(oauth.organizationUuid),
  ]));
}

async function snapshot(sourceDir) {
  const [logins, plugins] = await Promise.all([
    readOptional(sourceDir, 'logins.json', 'array'),
    readOptional(sourceDir, 'plugin-auth.json', 'object'),
  ]);
  const records = [];
  for (const entry of logins) {
    if (!object(entry) || !string(entry.agent) || !object(entry.auth) || !Object.keys(entry.auth).length) continue;
    const provider = entry.agent;
    const user = string(entry.user) || provider;
    const id = `login:${string(entry.id) || fallbackLoginID(entry, provider, user)}`;
    records.push({
      id, provider, user, plan: string(entry.plan), auth: entry.auth,
      profile: entry.profile, renewed: entry.renewed,
      disabled: Boolean(entry.hidden || entry.lapsed || entry.paused),
    });
  }
  for (const [key, auth] of Object.entries(plugins)) {
    if (!key || !object(auth) || !Object.keys(auth).length) continue;
    const provider = key.split('#')[0];
    const user = string(auth.accountId) || string(auth.metadata?.email) || string(auth.email) || key;
    records.push({ id: `plugin:${key}`, provider, user, plan: '', auth, pluginKey: key });
  }
  if (new Set(records.map(record => record.id)).size !== records.length) {
    throw new Error('Duplicate account IDs in the source files. Repair the account IDs before exporting.');
  }
  return records;
}

export async function listAccounts({ sourceDir = defaultConfigDir() } = {}) {
  sourceDir = directory(sourceDir, 'Source');
  return { accounts: (await snapshot(sourceDir)).map(metadata), sourceDir };
}

async function canonicalPath(value) {
  try { return await realpath(value); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Cannot resolve the source or output directory.');
    const parent = path.dirname(value);
    if (parent === value) throw new Error('Cannot resolve the source or output directory.');
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeName(value) {
  const cleaned = value.normalize('NFKC').replace(/[^\p{L}\p{N}@._+-]+/gu, '_').replace(/^[._-]+|[._-]+$/g, '');
  let result = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(result + character) > 70) break;
    result += character;
  }
  return result || 'account';
}

async function removeOwned(file) {
  try {
    const current = await lstat(file.path);
    if (current.dev === file.dev && current.ino === file.ino) await unlink(file.path);
  } catch { /* A missing or replaced path is never ours to remove. */ }
}

async function prepareFile(outputDir, body) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tempPath = path.join(outputDir, `.magpie-export-${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try { handle = await open(tempPath, 'wx', 0o600); }
    catch (error) { if (error?.code === 'EEXIST') continue; throw error; }
    let owned;
    try {
      const info = await handle.stat();
      owned = { path: tempPath, dev: info.dev, ino: info.ino };
      await handle.chmod(0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      return owned;
    } catch (error) {
      // Close before unlinking, including on Windows where an open handle can
      // prevent the removal. A close error still gets a final cleanup attempt.
      await handle.close().catch(() => {});
      handle = null;
      if (owned) await removeOwned(owned);
      throw error;
    } finally { if (handle) await handle.close().catch(() => {}); }
  }
  throw new Error('Could not reserve an export file.');
}

async function publishFile(outputDir, stem, temp) {
  for (let number = 1; number <= 10000; number++) {
    const name = `${stem}${number === 1 ? '' : ` (${number})`}.json`;
    const filePath = path.join(outputDir, name);
    try {
      // A hard link publishes a complete private file atomically and refuses
      // every existing path, including symlinks and another concurrent export.
      await link(temp.path, filePath);
      return { name, path: filePath, dev: temp.dev, ino: temp.ino };
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  throw new Error('Too many export files have the same account name.');
}

export async function exportAccounts({ sourceDir = defaultConfigDir(), outputDir, ids, format } = {}) {
  sourceDir = directory(sourceDir, 'Source');
  outputDir = directory(outputDir, 'Output');
  if (!FORMATS.has(format)) throw new Error('Choose raw, codex, or cliproxyapi format.');
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Select one or more distinct account IDs.');
  }
  const records = await snapshot(sourceDir);
  const byID = new Map(records.map(record => [record.id, record]));
  const selected = ids.map(id => {
    const record = byID.get(id);
    if (!record) throw new Error('An account selection is no longer available. Refresh the account list.');
    if (!metadata(record).formats.includes(format)) throw new Error('The selected format is not supported by every selected account.');
    let data;
    if (format === 'raw') data = record.pluginKey ? { [record.pluginKey]: record.auth } : record.auth;
    else if (format === 'codex') data = record.auth;
    else data = codexData(record) || claudeData(record);
    const email = codexData(record)?.email || claudeData(record)?.email;
    return { record, stem: safeName(email || record.user), body: `${JSON.stringify(data, null, 2)}\n` };
  });
  const [realSource, realOutput] = await Promise.all([canonicalPath(sourceDir), canonicalPath(outputDir)]);
  if (contains(realSource, realOutput) || contains(realOutput, realSource)) {
    throw new Error('The output directory must be separate from the Magpie source directory and its parents.');
  }
  const prepared = [], published = [];
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    // Finish every body before exposing any final filename. Existing output
    // directory permissions are left as they are (Downloads may be shared).
    for (const item of selected) prepared.push(await prepareFile(outputDir, item.body));
    const files = [];
    for (const [index, item] of selected.entries()) {
      const file = await publishFile(outputDir, item.stem, prepared[index]);
      published.push(file);
      files.push({ name: file.name, path: file.path, account: metadata(item.record) });
    }
    return { directory: outputDir, files, count: files.length };
  } catch {
    for (const file of published) await removeOwned(file);
    throw new Error('Could not write the export files. Check the output directory permissions and free space.');
  } finally {
    for (const file of prepared) await removeOwned(file);
  }
}
