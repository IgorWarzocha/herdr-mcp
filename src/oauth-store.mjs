import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

const LIMIT = 64;
const MAX_BYTES = 128 * 1024;
const randomToken = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const validRaw = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validDate = value => Number.isSafeInteger(value) && value > 0 && !Number.isNaN(new Date(value).getTime());
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const scopes = value => value == null ? ['mcp']
  : Array.isArray(value) && value.length === 1 && value[0] === 'mcp' ? ['mcp'] : false;

function checkPrivate(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile())
    || (process.platform !== 'win32' && (stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)))) {
    throw new Error('OAuth state must be an owned private regular file in a private directory');
  }
}

async function readState(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    checkPrivate(stat);
    if (stat.size > MAX_BYTES) throw new Error('OAuth state exceeds size limit');
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

async function writeState(path, state) {
  const temporary = `${path}.${randomToken()}.tmp`;
  let file;
  try {
    checkPrivate(await lstat(dirname(path)), true);
    try { checkPrivate(await lstat(path)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(state));
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** One process owns this store. Codes are deliberately ephemeral; only token hashes survive restart. */
export async function createOAuthModel({ stateFile, resource, clientId, redirectUris }) {
  const resourceId = new URL(resource).href;
  if (typeof clientId !== 'string' || !clientId || !Array.isArray(redirectUris) || !redirectUris.length
    || redirectUris.some(uri => typeof uri !== 'string' || !URL.canParse(uri))) {
    throw new Error('Invalid fixed OAuth client configuration');
  }
  const path = resolve(stateFile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  checkPrivate(await lstat(dirname(path)), true);
  const client = () => ({ id: clientId, grants: ['authorization_code', 'refresh_token'], redirectUris: [...redirectUris] });
  let generation = 0;
  const user = () => ({ id: 'owner', oauthGeneration: generation });
  const loaded = await readState(path);
  const recordKeys = ['accessHash', 'refreshHash', 'accessExpiresAt', 'refreshExpiresAt', 'scope', 'clientId', 'resource', 'owner'];
  const binding = value => value.clientId === clientId && value.resource === resourceId;
  if (loaded !== undefined && (!keysAre(loaded, ['version', 'clientId', 'resource', 'sessions'])
    || loaded.version !== 1 || !binding(loaded) || !Array.isArray(loaded.sessions) || loaded.sessions.length > LIMIT
    || loaded.sessions.some(record => !keysAre(record, recordKeys) || !binding(record) || record.owner !== 'owner'
      || !/^[a-f0-9]{64}$/.test(record.accessHash) || !/^[a-f0-9]{64}$/.test(record.refreshHash)
      || !validDate(record.accessExpiresAt) || !validDate(record.refreshExpiresAt) || !scopes(record.scope)
      || record.scope == null))) {
    throw new Error('Invalid OAuth state or client/resource binding');
  }
  let sessions = loaded?.sessions ?? [];
  if (new Set(sessions.flatMap(record => [record.accessHash, record.refreshHash])).size !== sessions.length * 2) {
    throw new Error('Duplicate OAuth token hashes');
  }
  const codes = new Map();
  let failure;
  let writes = Promise.resolve();
  function healthy() { if (failure) throw new Error('OAuth state storage failed', { cause: failure }); }
  function prune() {
    const now = Date.now();
    sessions = sessions.filter(record => Math.max(record.accessExpiresAt, record.refreshExpiresAt) > now);
    for (const [key, code] of codes) if (code.expiresAt.getTime() <= now) codes.delete(key);
  }
  function persist() {
    healthy();
    const snapshot = JSON.stringify({ version: 1, clientId, resource: resourceId, sessions });
    writes = writes.then(() => { healthy(); return writeState(path, JSON.parse(snapshot)); })
      .catch(error => { failure = error; throw error; });
    return writes;
  }
  async function ready() { await writes; healthy(); }
  function tokenView(record, raw, refresh) {
    return {
      [refresh ? 'refreshToken' : 'accessToken']: raw,
      accessTokenExpiresAt: new Date(record.accessExpiresAt),
      refreshTokenExpiresAt: new Date(record.refreshExpiresAt),
      scope: [...record.scope], client: client(), user: user(),
    };
  }
  function remove(raw, refreshOnly = false) {
    healthy();
    if (!validRaw(raw)) return false;
    const digest = hash(raw);
    const index = sessions.findIndex(record => record.refreshHash === digest || (!refreshOnly && record.accessHash === digest));
    if (index < 0) return false;
    // Consume synchronously, before persistence yields: concurrent refreshes cannot both win.
    sessions.splice(index, 1);
    return true;
  }
  const model = {
    generateAccessToken: randomToken,
    generateRefreshToken: randomToken,
    generateAuthorizationCode: randomToken,
    getClient(id, secret) { healthy(); return id === clientId && secret == null ? client() : false; },
    validateScope(_user, _client, scope) { return scopes(scope); },
    verifyScope(token, scope) { return !!scopes(scope) && !!scopes(token.scope); },
    async saveAuthorizationCode(code, suppliedClient, suppliedUser) {
      await ready();
      prune();
      if (suppliedUser.oauthGeneration !== generation) throw new Error('OAuth grant was revoked');
      if (suppliedClient.id !== clientId || suppliedUser.id !== 'owner' || !validRaw(code.authorizationCode)
        || !scopes(code.scope) || !redirectUris.includes(code.redirectUri)
        || !(code.expiresAt instanceof Date) || !validDate(code.expiresAt.getTime())) throw new Error('Invalid OAuth code');
      if (codes.size >= LIMIT) throw new Error('OAuth authorization code limit reached');
      const stored = { ...code, scope: scopes(code.scope), expiresAt: new Date(code.expiresAt), client: client(),
        user: { id: suppliedUser.id, oauthGeneration: suppliedUser.oauthGeneration } };
      codes.set(hash(code.authorizationCode), stored);
      return structuredClone(stored);
    },
    async getAuthorizationCode(raw) {
      await ready();
      prune();
      return validRaw(raw) ? structuredClone(codes.get(hash(raw)) ?? false) : false;
    },
    revokeAuthorizationCode(code) {
      healthy();
      return validRaw(code.authorizationCode) && codes.delete(hash(code.authorizationCode));
    },
    async saveToken(token, suppliedClient, suppliedUser) {
      await ready();
      prune();
      // Native grants retain this user between consumption and issuance. A global
      // revocation must also cancel grants already consumed but not yet issued.
      if (suppliedUser.oauthGeneration !== undefined && suppliedUser.oauthGeneration !== generation) {
        throw new Error('OAuth grant was revoked');
      }
      if (suppliedClient.id !== clientId || suppliedUser.id !== 'owner' || !scopes(token.scope)
        || !validRaw(token.accessToken) || !validRaw(token.refreshToken)
        || !(token.accessTokenExpiresAt instanceof Date) || !validDate(token.accessTokenExpiresAt.getTime())
        || !(token.refreshTokenExpiresAt instanceof Date) || !validDate(token.refreshTokenExpiresAt.getTime())) {
        throw new Error('Invalid OAuth token');
      }
      if (sessions.length >= LIMIT) throw new Error('OAuth session limit reached');
      const record = { accessHash: hash(token.accessToken), refreshHash: hash(token.refreshToken),
        accessExpiresAt: token.accessTokenExpiresAt.getTime(), refreshExpiresAt: token.refreshTokenExpiresAt.getTime(),
        scope: scopes(token.scope), clientId, resource: resourceId, owner: 'owner' };
      if (record.accessHash === record.refreshHash || sessions.some(existing =>
        [existing.accessHash, existing.refreshHash].some(digest => digest === record.accessHash || digest === record.refreshHash))) {
        throw new Error('Duplicate OAuth token');
      }
      sessions.push(record);
      await persist();
      return { ...token, scope: [...record.scope], client: client(), user: user() };
    },
    async getAccessToken(raw) {
      await ready();
      const record = validRaw(raw) && sessions.find(value => value.accessHash === hash(raw) && value.accessExpiresAt > Date.now());
      return record ? tokenView(record, raw, false) : false;
    },
    async getRefreshToken(raw) {
      await ready();
      const record = validRaw(raw) && sessions.find(value => value.refreshHash === hash(raw) && value.refreshExpiresAt > Date.now());
      return record ? tokenView(record, raw, true) : false;
    },
    async revokeToken(token) {
      const removed = remove(token.refreshToken, true);
      if (removed) await persist();
      return removed;
    },
  };
  if (loaded === undefined) await persist();
  return {
    model,
    owner() { healthy(); return user(); },
    verifier: {
      async verifyAccessToken(raw) {
        const token = await model.getAccessToken(raw);
        if (!token) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired OAuth token');
        return { token: raw, clientId, scopes: token.scope,
          expiresAt: Math.floor(token.accessTokenExpiresAt.getTime() / 1000), resource: new URL(resourceId) };
      },
    },
    async revoke(raw) {
      const removed = remove(raw);
      if (removed) await persist();
      return removed;
    },
    async revokeAll() {
      healthy();
      const count = sessions.length + codes.size;
      generation++;
      sessions = [];
      codes.clear();
      await persist();
      return count;
    },
  };
}
