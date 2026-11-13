import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOAuth } from '../src/oauth.mjs';
import { createHandler } from '../src/http.mjs';

test('OAuth requires operator consent, exact callback, resource and single-use S256 codes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-mcp-oauth-'));
  let handler;
  const http = createServer((req, res) => handler(req, res));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const base = `http://127.0.0.1:${http.address().port}`, resource = `${base}/mcp`;
  const callback = 'https://client.example/callback', clientId = 'test-client', legacy = 'private-test-token';
  const options = { resource, clientId, redirectUris: [callback], stateFile: join(root, 'oauth.json') };
  let oauth = await createOAuth(options);
  const runner = { async run() { return { exit_code: 0, stdout: 'guide', stderr: '' }; } };
  const makeHandler = () => createHandler({ token: legacy, origins: [], runner, oauth });
  handler = makeHandler();
  t.after(async () => { await handler.close(); http.close(); http.closeAllConnections(); await rm(root, { recursive: true, force: true }); });
  const post = (path, input, bearer) => fetch(`${base}/mcp/oauth/${path}`, {
    method: 'POST', headers: { 'Content-Type': bearer ? 'application/json' : 'application/x-www-form-urlencoded',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: bearer ? JSON.stringify(input) : new URLSearchParams(input),
  });
  const verifier = randomBytes(32).toString('base64url');
  const query = { client_id: clientId, redirect_uri: callback, response_type: 'code', resource, scope: 'mcp',
    state: 'private-csrf-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
  const authorize = input => fetch(`${resource}/oauth/authorize?${new URLSearchParams(input)}`, { redirect: 'manual' });
  const challenge = await fetch(resource, { method: 'POST' });
  assert.equal(challenge.status, 401);
  assert.ok(challenge.headers.get('www-authenticate').includes(`${resource}/oauth/resource`));
  assert.equal((await (await fetch(`${resource}/oauth/resource`)).json()).resource, resource);
  assert.deepEqual((await (await fetch(`${resource}/oauth/metadata`)).json()).code_challenge_methods_supported, ['S256']);
  assert.equal((await authorize({ ...query, redirect_uri: 'https://attacker.example/callback' })).status, 400);
  assert.equal((await authorize({ ...query, resource: 'https://another-resource.example/mcp' })).status, 400);
  assert.equal((await authorize({ ...query, code_challenge_method: 'plain' })).status, 400);
  assert.equal((await authorize({ ...query, scope: 'admin' })).status, 400);

  async function code() {
    const begin = await authorize(query);
    assert.equal(begin.status, 303);
    const location = begin.headers.get('location');
    const requestId = new URL(location).searchParams.get('request');
    const cookie = begin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(location, { redirect: 'manual' })).status, 404, 'another browser cannot claim this approval');
    assert.equal((await post('approve', { request_id: requestId })).status, 401);
    assert.equal((await fetch(location, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200);
    assert.equal((await post('approve', { request_id: requestId }, legacy)).status, 200);
    const approved = await fetch(location, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(approved.status, 302, await approved.text());
    const redirect = new URL(approved.headers.get('location'));
    assert.equal(redirect.origin + redirect.pathname, callback);
    assert.equal(redirect.searchParams.get('state'), query.state);
    assert.equal(redirect.searchParams.get('iss'), resource);
    assert.ok(redirect.searchParams.get('code'));
    return redirect.searchParams.get('code');
  }
  const grant = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, resource, code_verifier: verifier };
  const burned = await code();
  assert.equal((await post('token', { ...grant, code: burned, code_verifier: randomBytes(32).toString('base64url') })).status, 400);
  assert.equal((await post('token', { ...grant, code: burned })).status, 400, 'failed PKCE consumes the code');
  const valid = await code();
  assert.equal((await post('token', { ...grant, code: valid, resource: 'https://attacker.example' })).status, 400);
  assert.equal((await post('token', { ...grant, code: valid, client_secret: '' })).status, 400);
  const tokenResponse = await post('token', { ...grant, code: valid });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.expires_in >= 3595 && tokens.expires_in <= 3600);
  assert.ok(tokens.refresh_token);
  assert.equal((await post('token', { ...grant, code: valid })).status, 400);

  async function connect(token) {
    const client = new Client({ name: 'oauth-boundary', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      assert.equal((await client.callTool({ name: 'herdr_skill', arguments: {} })).content[0].text, 'guide');
    } finally { await client.close(); }
  }
  await connect(legacy);
  await connect(tokens.access_token);
  const refreshed = await post('token', { grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  assert.equal((await post('token', { grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: tokens.refresh_token })).status, 400);
  await handler.close();
  oauth = await createOAuth(options); handler = makeHandler();
  await connect(next.access_token);
  assert.equal((await post('revoke', { client_id: clientId, token: next.refresh_token })).status, 200);
  assert.equal((await fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${next.access_token}` } })).status, 401);
  await connect(legacy);

  const slow = [];
  try {
    for (let i = 0; i < 4; i++) {
      const accepted = once(http, 'request');
      const request = httpRequest(`${resource}/oauth/token`, { method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '1024',
      } });
      request.on('error', () => {}); // Deliberately abandoned bodies are destroyed below.
      request.write('grant_type=');
      const [, response] = await accepted;
      slow.push({ request, response });
    }
    assert.equal((await fetch(`${resource}/oauth/resource`)).status, 503, 'public OAuth admission is bounded');
    await connect(legacy);
    assert.equal((await post('approve', { request_id: 'missing' }, legacy)).status, 404,
      'anonymous OAuth bodies must not block an authenticated operator');
  } finally {
    await Promise.all(slow.map(({ request, response }) => new Promise(resolve => {
      response.once('close', resolve); request.destroy();
    })));
  }
});
