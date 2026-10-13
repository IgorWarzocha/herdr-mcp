import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { commandEnvironment, createRunner, normalize, splitCommand } from '../src/bridge.mjs';
import { config, createHandler, readToken } from '../src/server.mjs';

test('platform defaults match Herdr and explicit socket overrides win', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(config({ HOME: '/Users/operator' }, platform).socket, '/Users/operator/.config/herdr/herdr.sock');
    assert.equal(config({ HOME: '/home/operator', XDG_CONFIG_HOME: '/custom' }, platform).tokenFile, '/custom/herdr-mcp/token');
  }
  const env = { USERPROFILE: 'C:\\Users\\operator', APPDATA: 'C:\\Users\\operator\\AppData\\Roaming', Path: 'C:\\tools' };
  const windows = config(env, 'win32');
  assert.equal(windows.socket, 'C:\\Users\\operator\\AppData\\Roaming\\herdr\\herdr.sock');
  assert.equal(windows.tokenFile, 'C:\\Users\\operator\\AppData\\Roaming\\herdr-mcp\\token');
  assert.equal(windows.path, 'C:\\tools');
  assert.equal(config({ USERPROFILE: env.USERPROFILE, HOME: 'D:\\other' }, 'win32').socket, windows.socket);
  assert.equal(config({ HOME: 'D:\\home' }, 'win32').socket, 'D:\\home\\.config\\herdr\\herdr.sock');
  assert.equal(config({ ...env, XDG_CONFIG_HOME: 'D:\\config' }, 'win32').socket, 'D:\\config\\herdr\\herdr.sock');
  assert.equal(config({ ...env, HERDR_SOCKET_PATH: 'D:\\inherited', HERDR_MCP_SOCKET: 'D:\\pinned' }, 'win32').socket, 'D:\\pinned');
});

test('Windows subprocess environment keeps loader variables without leaking identity or secrets', () => {
  const env = commandEnvironment({ home: 'C:\\Users\\operator', path: 'C:\\tools', socket: 'C:\\pinned' }, {
    SYSTEMROOT: 'C:\\Windows', APPDATA: 'C:\\profile', PATH: 'wrong', HERDR_SESSION: 'wrong',
    HERDR_SOCKET_PATH: 'wrong', HERDR_PANE_ID: 'wrong', HERDR_MCP_TOKEN: 'secret',
  }, 'win32');
  assert.deepEqual(env, { HOME: 'C:\\Users\\operator', PATH: 'C:\\tools', LANG: 'C.UTF-8',
    HERDR_SOCKET_PATH: 'C:\\pinned', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\profile' });
});

test('token validation preserves POSIX ownership policy and validates content on Windows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-mcp-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'token');
  await writeFile(file, 'a'.repeat(64) + '\n', { mode: 0o600 });
  assert.equal(await readToken(file), 'a'.repeat(64));
  if (process.platform !== 'win32') {
    await assert.rejects(readToken(file, process.platform, process.getuid() + 1), /owned by/);
    await chmod(file, 0o644);
    await assert.rejects(readToken(file), /mode 0600/);
  }
  assert.equal(await readToken(file, 'win32'), 'a'.repeat(64));
  await writeFile(file, 'not-a-token');
  await assert.rejects(readToken(file, 'win32'), /64 hex/);
});

test('quote parser preserves literal payloads without shell expansion', () => {
  assert.deepEqual(splitCommand(`send w1:p1 "Hello '$HOME' $(whoami)"`), ['send', 'w1:p1', "Hello '$HOME' $(whoami)"]);
  assert.deepEqual(splitCommand(`pane send-text w1:p1 ''`), ['pane', 'send-text', 'w1:p1', '']);
  assert.deepEqual(splitCommand('read "a\\qb"'), ['read', 'a\\qb']);
  for (const text of ['read "bad', 'read a\\', 'read a; ls', 'read a | sh']) assert.throws(() => splitCommand(text));
});

test('aliases and raw commands share routing and explicit-input policy', () => {
  assert.deepEqual(normalize({ command: 'send w1:p1 "hi there"' }), ['agent', 'prompt', 'w1:p1', '--', 'hi there']);
  assert.deepEqual(normalize({ args: ['send', 'w1:p1', '--session=other'] }), ['agent', 'prompt', 'w1:p1', '--', '--session=other']);
  assert.deepEqual(normalize({ args: ['read', 'w1:p1', '--lines', '20'] }), ['pane', 'read', 'w1:p1', '--lines', '20']);
  assert.deepEqual(normalize({ args: ['read', 'w1R:p7'] }), ['pane', 'read', 'w1R:p7']);
  assert.deepEqual(normalize({ args: ['pane', 'send-text', 'w1:p1', '--', '--session'] }), ['pane', 'send-text', 'w1:p1', '--', '--session']);
  for (const input of [{}, {args: [], command: ''}, {args: ['--session', 'other', 'pane', 'list']},
    {args: ['pane', 'list', '--session', 'other']}, {args: ['pane', 'list', '--session=other']},
    {args: ['server', 'stop']}, {args: ['pane', 'run', '--current', 'ls']},
    {args: ['api', 'schema', '--output=/tmp/x']}, {args: ['send', 'w1:p1']}, {args: ['pane', '\0']}]) {
    assert.throws(() => normalize(input));
  }
});

function runner(options = {}) {
  return createRunner({ binary: process.execPath, home: tmpdir(), path: process.env.PATH, socket: join(tmpdir(), 'test-herdr.sock'), ...options });
}

test('subprocess output is bounded, environment isolated, exit code preserved', async () => {
  const run = runner({ outputBytes: 32 });
  const result = await run.run(['-e', 'process.stdout.write("x".repeat(1000));process.exitCode=7']);
  assert.equal(result.exit_code, 7);
  assert.equal(result.stdout.length, 32);
  assert.equal(result.truncated, true);
  const env = await runner().run(['-e', 'console.log(JSON.stringify(process.env))']);
  assert.equal(JSON.parse(env.stdout).HERDR_SOCKET_PATH, join(tmpdir(), 'test-herdr.sock'));
  assert.equal(JSON.parse(env.stdout).HERDR_PANE_ID, undefined);
  const args = ['C:\\Users\\a b\\file', '$(whoami)', 'a&b'];
  const literal = await runner().run(['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.deepEqual(JSON.parse(literal.stdout), args);
});

test('timeout, cancellation and concurrency release the process slot', async () => {
  const run = runner({ timeoutMs: 1000, concurrency: 1 });
  const first = run.run(['-e', 'setInterval(()=>{},1000)']);
  await assert.rejects(run.run(['-e', '']), /busy/);
  assert.equal((await first).timed_out, true);
  const controller = new AbortController();
  const second = run.run(['-e', 'setInterval(()=>{},1000)'], controller.signal);
  controller.abort();
  assert.equal((await second).cancelled, true);
  assert.equal((await run.run(['-e', ''])).exit_code, 0);
});

test('real MCP transport requires auth, validates origin, discovers and executes two tools', async t => {
  const calls = [];
  const http = createServer(createHandler({ token: 'test-token', origins: [], runner: {
    async run(args) { calls.push(args); return {exit_code: 0, stdout: 'ok', stderr: '', timed_out: false, truncated: false, cancelled: false}; }
  }}));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  t.after(() => { http.close(); http.closeAllConnections(); });
  assert.equal((await fetch(url, {method: 'POST'})).status, 401);
  assert.equal((await fetch(url, {method: 'POST', headers: {Authorization: 'Bearer test-token', Origin: 'https://evil.example'}})).status, 403);
  const client = new Client({name: 'test', version: '1'});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer test-token'}}}));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['herdr_skill', 'herdr']);
  const result = await client.callTool({name: 'herdr', arguments: {command: 'send w1:p1 "hello"'}});
  assert.equal(result.isError, false);
  assert.deepEqual(calls.at(-1), ['agent', 'prompt', 'w1:p1', '--', 'hello']);
  assert.equal((await client.callTool({name: 'herdr', arguments: {args: ['server', 'stop']}})).isError, true);
  const skill = await client.callTool({name: 'herdr_skill', arguments: {}});
  assert.match(skill.content[0].text, /external client/);
});
