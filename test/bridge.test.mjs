import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { commandEnvironment, createRunner, normalize, splitCommand } from '../src/bridge.mjs';
import { checkHerdrVersion, config, readToken } from '../src/server.mjs';
import { createHandler } from '../src/http.mjs';
import { snapshot, snapshotResult } from './fixtures/panes.mjs';

test('startup rejects older Herdr rather than enabling compatibility branches', () => {
  for (const version of ['herdr 0.9.4', 'herdr 0.8.99', 'invalid', 'herdr 0.9']) assert.throws(() => checkHerdrVersion(version));
  for (const version of ['herdr 0.9.5', 'herdr 0.10.0', 'herdr 1.0.0']) assert.equal(checkHerdrVersion(version), version);
});

test('platform defaults match Herdr and explicit socket overrides win', () => {
  assert.equal(config({}).waitMaxMs, 90000);
  assert.equal(config({ HERDR_MCP_WAIT_MAX: '120000' }).waitMaxMs, 120000);
  for (const value of ['', '0', '-1', 'no', '1.5', '2147481648']) {
    assert.throws(() => config({ HERDR_MCP_WAIT_MAX: value }), /HERDR_MCP_WAIT_MAX/);
  }
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
  assert.deepEqual(normalize({ command: 'send "MCP bridge" hi there' }), ['send', 'MCP bridge', 'hi there']);
  assert.deepEqual(normalize({ args: ['send', 'w1:p1', '--session=other'] }), ['send', 'w1:p1', '--session=other']);
  assert.deepEqual(normalize({ args: ['read', 'w1:p1', '--lines', '20'] }), ['read', 'w1:p1', '--lines', '20']);
  assert.deepEqual(normalize({ args: ['read', 'w1R:p7'] }), ['read', 'w1R:p7']);
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

test('current MCP transport preserves auth, both tools and literal agent submission', async t => {
  const calls = [];
  let next = {exit_code: 0, stdout: 'Installed guide\nKeep this exactly.\n', stderr: '', timed_out: false, truncated: false, cancelled: false};
  const http = createServer(createHandler({ token: 'test-token', origins: [], runner: {
    async run(args) {
      calls.push(args); if (next instanceof Error) throw next;
      return args[0] === 'api' ? snapshotResult(snapshot()) : next;
    }
  }}));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  t.after(() => { http.close(); http.closeAllConnections(); });
  for (const headers of [{}, {Authorization: 'Bearer wrong-token'}]) {
    const response = await fetch(url, {method: 'POST', headers});
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'bad_token');
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch(url, {method: 'POST', headers: {Authorization: 'Bearer test-token', Origin: 'https://evil.example'}})).status, 403);
  const client = new Client({name: 'test', version: '1'}, {versionNegotiation: {mode: {pin: '2026-07-28'}}});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer test-token'}}}));
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name), ['herdr_skill', 'herdr']);
  const result = await client.callTool({name: 'herdr', arguments: {command: 'send w1:p1 "hello"'}});
  assert.equal(result.isError, false);
  assert.deepEqual(calls.at(-1), ['agent', 'prompt', 'w1:p1', 'hello']);
  for (const [args, hint] of [
    [{args: ['server', 'stop']}, /maintenance are disabled/],
    [{args: ['machine', 'list']}, /disabled/],
    [{args: ['pane', 'list', '--session', 'other']}, /routing are fixed/],
    [{args: [1]}, /array of at most 256 strings/],
    [{command: 'read "'}, /Unclosed quote/],
    [{args: [], command: ''}, /exactly one of args or command/],
    [{}, /exactly one of args or command/],
    [{args: ['agent', 'wait']}, /explicit pane ID or agent name/],
    [{args: ['agent', 'wait', 'worker', '--timeout=-1']}, /--timeout once/],
  ]) {
    const invalid = await client.callTool({name: 'herdr', arguments: args});
    assert.equal(invalid.isError, true);
    const detail = JSON.parse(invalid.content[0].text);
    assert.equal(detail.code, 'invalid_arguments');
    assert.match(detail.next, hint);
  }
  const skill = await client.callTool({name: 'herdr_skill', arguments: {}});
  assert.equal(skill.content[0].text, next.stdout);
  next = {exit_code: 1, stdout: '', stderr: JSON.stringify({error: {
    code: 'agent_not_idle', message: 'private upstream diagnostic',
  }})};
  const historyRead = await client.callTool({name: 'herdr', arguments: {args: ['agent', 'read', 'w1:p1', '--lines', '200']}});
  const historyError = JSON.parse(historyRead.content[0].text);
  assert.equal(historyRead.isError, true);
  assert.equal(historyError.code, 'agent_not_idle');
  assert.match(historyError.next, /--source visible/);
  assert.doesNotMatch(historyRead.content[0].text, /private upstream/);
  assert.deepEqual(calls.at(-1), ['agent', 'read', 'w1:p1', '--lines', '200']);
  next = {exit_code: 0, stdout: 'A reply is visible while the agent is working.', stderr: ''};
  const screenRead = await client.callTool({name: 'herdr', arguments: {args: ['agent', 'read', 'w1:p1', '--source', 'visible']}});
  assert.equal(screenRead.isError, false);
  assert.equal(JSON.parse(screenRead.content[0].text).stdout, next.stdout);
  assert.deepEqual(calls.at(-1), ['agent', 'read', 'w1:p1', '--source', 'visible']);
  next = {exit_code: 2, stdout: '', stderr: 'CLI diagnostic dump'};
  for (const args of [['pane', 'unknown'], ['pane', 'list', '--unknown']]) {
    const rejected = await client.callTool({name: 'herdr', arguments: {args}});
    const detail = JSON.parse(rejected.content[0].text);
    assert.equal(rejected.isError, true);
    assert.equal(detail.code, 'invalid_arguments');
    assert.match(detail.next, /subcommand, flags and required values/);
    assert.doesNotMatch(detail.next, /exactly one/);
    assert.deepEqual(calls.at(-1), args);
  }
  for (const name of ['herdr', 'herdr_skill']) {
    next = Object.assign(new Error('sensitive path\nstack backtrace: secret'), {code: 'ENOENT'});
    const failed = await client.callTool({name, arguments: name === 'herdr' ? {args: ['list']} : {}});
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).code, 'herdr_unavailable');
    assert.doesNotMatch(failed.content[0].text, /sensitive|stack|secret/);
  }
  next = {exit_code: 0, stdout: 'partial guide', stderr: '', truncated: true};
  const truncated = await client.callTool({name: 'herdr_skill', arguments: {}});
  assert.equal(truncated.isError, true);
  assert.equal(JSON.parse(truncated.content[0].text).code, 'truncated');
  assert.match(JSON.parse(truncated.content[0].text).next, /subcommand --help/);
});
