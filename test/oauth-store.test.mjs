import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, chmod, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createOAuthModel } from '../src/oauth-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-oauth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { stateFile: join(directory, 'state.json'), resource: 'https://bridge.example/mcp',
    clientId: 'chatgpt', redirectUris: ['https://chatgpt.com/connector/oauth/callback'] };
  return { options, store: await createOAuthModel(options) };
}

async function issue(store, expires = Date.now() + 60_000) {
  const { model } = store;
  const client = model.getClient('chatgpt');
  const token = { accessToken: model.generateAccessToken(), refreshToken: model.generateRefreshToken(),
    accessTokenExpiresAt: new Date(expires), refreshTokenExpiresAt: new Date(Date.now() + 120_000), scope: ['mcp'] };
  await model.saveToken(token, client, { id: 'owner' });
  return token;
}

const invalidToken = error => error instanceof OAuthError && error.code === OAuthErrorCode.InvalidToken;

test('tokens persist only as hashes, survive restart, and revoke durably by either token', async t => {
  const { options, store } = await fixture(t);
  const token = await issue(store);
  const contents = await readFile(options.stateFile, 'utf8');
  assert.ok(!contents.includes(token.accessToken));
  assert.ok(!contents.includes(token.refreshToken));
  if (process.platform !== 'win32') assert.equal((await stat(options.stateFile)).mode & 0o777, 0o600);
  const restored = await createOAuthModel(options);
  const auth = await restored.verifier.verifyAccessToken(token.accessToken);
  assert.equal(auth.token, token.accessToken);
  assert.equal(auth.clientId, options.clientId);
  assert.equal(auth.resource.href, options.resource);
  assert.deepEqual(auth.scopes, ['mcp']);
  assert.equal(auth.expiresAt, Math.floor(token.accessTokenExpiresAt.getTime() / 1000));
  assert.equal(await restored.revoke(token.refreshToken), true);
  assert.equal(await restored.revoke(token.accessToken), false);
  const revoked = await createOAuthModel(options);
  await assert.rejects(revoked.verifier.verifyAccessToken(token.accessToken), invalidToken);
  assert.equal(await revoked.model.getRefreshToken(token.refreshToken), false);
  const next = await issue(revoked);
  assert.equal(await revoked.revoke(next.accessToken), true);
  assert.equal(await revoked.model.getRefreshToken(next.refreshToken), false);
});

test('refresh and code consumption are single-use even after concurrent reads; old access is revoked', async t => {
  const { options, store } = await fixture(t);
  const token = await issue(store);
  const [first, second] = await Promise.all([
    store.model.getRefreshToken(token.refreshToken), store.model.getRefreshToken(token.refreshToken),
  ]);
  assert.deepEqual(await Promise.all([store.model.revokeToken(first), store.model.revokeToken(second)]), [true, false]);
  await assert.rejects(store.verifier.verifyAccessToken(token.accessToken), invalidToken);
  const replacement = await issue(store);
  assert.equal(await store.model.revokeToken(first), false);
  assert.ok(await store.verifier.verifyAccessToken(replacement.accessToken));
  const code = { authorizationCode: store.model.generateAuthorizationCode(),
    expiresAt: new Date(Date.now() + 300_000), redirectUri: options.redirectUris[0], scope: ['mcp'],
    codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' };
  await store.model.saveAuthorizationCode(code, store.model.getClient('chatgpt'), store.owner());
  const copies = await Promise.all([store.model.getAuthorizationCode(code.authorizationCode),
    store.model.getAuthorizationCode(code.authorizationCode)]);
  assert.deepEqual(copies.map(value => store.model.revokeAuthorizationCode(value)), [true, false]);
  assert.equal(await store.model.getAuthorizationCode(code.authorizationCode), false);
  await store.model.saveAuthorizationCode({ ...code, authorizationCode: store.model.generateAuthorizationCode() },
    store.model.getClient('chatgpt'), store.owner());
  const capturedOwner = store.owner();
  assert.equal(await store.revokeAll(), 2);
  await assert.rejects(store.model.saveAuthorizationCode(code, store.model.getClient('chatgpt'), capturedOwner), /grant was revoked/);
  assert.equal(await store.model.getAuthorizationCode(code.authorizationCode), false);
  await assert.rejects(store.model.saveToken(replacement, first.client, first.user), /grant was revoked/);
  await assert.rejects(store.model.saveToken(replacement, copies[0].client, copies[0].user), /grant was revoked/);
  const restored = await createOAuthModel(options);
  await assert.rejects(restored.verifier.verifyAccessToken(replacement.accessToken), invalidToken);
  assert.equal(await store.revokeAll(), 0);
  const currentOwner = store.owner();
  const saved = await store.model.saveAuthorizationCode(code, store.model.getClient('chatgpt'), currentOwner);
  assert.deepEqual(saved.user, currentOwner);
});

test('expiry, fixed client/scopes, persisted binding, and schema fail closed', async t => {
  const { options, store } = await fixture(t);
  assert.equal(store.model.getClient('other'), false);
  assert.equal(store.model.getClient('chatgpt', null).id, 'chatgpt');
  assert.equal(store.model.getClient('chatgpt', ''), false);
  assert.equal(store.model.getClient('chatgpt', 'secret'), false);
  assert.deepEqual(store.model.validateScope(null, null, undefined), ['mcp']);
  assert.equal(store.model.validateScope(null, null, ['admin']), false);
  const token = await issue(store, Date.now() - 1000);
  await assert.rejects(store.verifier.verifyAccessToken(token.accessToken), invalidToken);
  await assert.rejects(store.verifier.verifyAccessToken('invalid'), invalidToken);
  await assert.rejects(createOAuthModel({ ...options, resource: 'https://other.example/mcp' }), /binding/);
  await assert.rejects(createOAuthModel({ ...options, clientId: 'different' }), /binding/);
  const state = JSON.parse(await readFile(options.stateFile, 'utf8'));
  state.sessions[0].refreshExpiresAt = Date.now() - 1000;
  await writeFile(options.stateFile, JSON.stringify(state));
  const expired = await createOAuthModel(options);
  assert.equal(await expired.model.getRefreshToken(token.refreshToken), false);
  state.sessions[0].refreshExpiresAt = 'tomorrow';
  await writeFile(options.stateFile, JSON.stringify(state));
  await assert.rejects(createOAuthModel(options), /Invalid OAuth state/);
  await writeFile(options.stateFile, '{');
  await assert.rejects(createOAuthModel(options), SyntaxError);
});

test('insecure files, directories, symlinks, and write failures are not silently repaired', {
  skip: process.platform === 'win32' && 'POSIX permissions',
}, async t => {
  const { options, store } = await fixture(t);
  const token = await issue(store);
  await chmod(options.stateFile, 0o644);
  await assert.rejects(createOAuthModel(options), /private/);
  await assert.rejects(issue(store), /private/);
  await chmod(options.stateFile, 0o600);
  // A later successful filesystem operation must not reopen an uncertain in-memory store.
  await assert.rejects(store.verifier.verifyAccessToken(token.accessToken));
  const link = `${options.stateFile}.link`;
  await symlink(options.stateFile, link);
  await assert.rejects(createOAuthModel({ ...options, stateFile: link }));
  await chmod(join(options.stateFile, '..'), 0o755);
  await assert.rejects(createOAuthModel(options), /private/);
});
