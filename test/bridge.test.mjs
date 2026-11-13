import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRunner, normalize } from '../src/bridge.mjs';
import { createHandler } from '../src/http.mjs';
import { latestReply } from '../src/reply.mjs';
import { createRuntimes } from '../src/runtimes.mjs';
import { serviceCheckArguments } from '../scripts/restart.mjs';

const ok = { exit_code: 0, stdout: '', stderr: '', timed_out: false, truncated: false, cancelled: false };
const json = value => ({ ...ok, stdout: JSON.stringify(value) });

test('HTTP rejects unauthorised callers and still accepts the Grok MCP revision', async t => {
  let calls = 0;
  const handler = createHandler({ token: 'private-test-token', origins: [], runner: {
    async run() { calls++; return { ...ok, stdout: 'guide' }; },
  } });
  const http = createServer(handler);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const client = new Client({ name: 'grok-regression', version: '1' }, {
    supportedProtocolVersions: ['2025-03-26'], versionNegotiation: { mode: 'legacy' },
  });
  t.after(async () => {
    try { await client.close(); await handler.close(); }
    finally { http.close(); http.closeAllConnections(); }
  });
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: {
    Authorization: 'Bearer private-test-token', Origin: 'https://untrusted.example',
  } })).status, 403);
  assert.equal(calls, 0);
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer private-test-token' } },
  }));
  assert.equal(client.getNegotiatedProtocolVersion(), '2025-03-26');
  assert.equal((await client.callTool({ name: 'herdr_skill', arguments: {} })).content[0].text, 'guide');
});

test('routing rejects ambiguous identities and never retries a Core mutation on TUI', async () => {
  const mutations = [];
  const runtimes = createRuntimes({
    tui: { async run(args) {
      if (args[0] === 'api') return json({ result: { snapshot: {
        workspaces: [{ workspace_id: 'w1' }], tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1' }],
        panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' }],
        agents: [{ pane_id: 'w1:p1', name: 'reviewer', agent: 'pi' }],
      } } });
      mutations.push(['tui', ...args]); return ok;
    } },
    core: { async run(args) {
      if (args[1] === 'ls') return json({ terminals: [{ address: 't1', name: 'reviewer',
        agent: 'pi', status: 'idle', turn: 0, state: 'live', cwd: '/project' }] });
      mutations.push(['core', ...args]);
      return { ...ok, exit_code: 1, stderr: 'private diagnostic' };
    } },
  });
  assert.equal((await runtimes.execute(['send', 'reviewer', 'hello'])).code, 'ambiguous_target');
  assert.equal((await runtimes.execute(['send', 'core:tester', 'hello'])).code, 'invalid_arguments');
  assert.deepEqual(mutations, []);
  assert.equal((await runtimes.execute(['spawn', '--', 'pi'])).code, 'command_failed');
  assert.deepEqual(mutations, [['core', '--json', 'run', '--bg', '--no-parent', '--', 'pi']]);
  mutations.length = 0;
  const args = ['agent', 'prompt', 'w1:p1', 'hello', '--wait'];
  assert.equal((await runtimes.execute(normalize({ args }))).code, 'ok');
  assert.deepEqual(mutations, [['tui', ...args]], 'raw flags must not become prompt text');
});

test('machine routing scopes duplicate IDs, preserves payloads and never falls back locally', async () => {
  const id = 'a'.repeat(32), offline = 'b'.repeat(32), calls = [];
  let name = 'desktop';
  const machines = () => [{ id, name, state: 'connected' }, { id: offline, name: 'offline', state: 'unreachable' }];
  const row = address => ({ address, name: 'worker', agent: 'pi', status: 'idle', turn: 0, state: 'live', cwd: '/project' });
  const runtimes = createRuntimes({ core: { async run(args) {
    if (args[1] === 'machine') return json({ machines: machines() });
    if (args[1] === 'ls') return json({ terminals: [row('t1'), row(`${name}/t1`)], machines: machines() });
    calls.push(args);
    if (args[1] === 'send') return json({ status: 'idle', turn: 0, started: false });
    if (args[1] === 'run') return json(row(`${name}/t2`));
    if (args[1] === 'get') return json({ ...row(`${name}/t1`), status: { state: 'idle', app: 'pi' } });
    return { ...ok, exit_code: 1, stderr: JSON.stringify({ error: { kind: 'unavailable' } }) };
  } } });
  const inventory = JSON.parse((await runtimes.execute(['list'])).stdout);
  assert.deepEqual(inventory.panes.map(pane => pane.pane_id).sort(), [`core:${id}/t1`, 'core:t1'].sort());
  assert.equal(inventory.machines.find(machine => machine.id === offline).state, 'unreachable');
  const scoped = normalize({ command: '--machine desktop send worker "--machine offline"' });
  assert.equal((await runtimes.execute(scoped)).code, 'ok');
  assert.deepEqual(calls.pop(), ['--json', 'send', `${id}/t1`, '--', '--machine offline']);
  assert.equal((await runtimes.execute(['send', 'worker', 'local task'])).code, 'ok');
  assert.deepEqual(calls.pop(), ['--json', 'send', 't1', '--', 'local task']);
  assert.equal((await runtimes.execute(['--machine', 'desktop', 'spawn', '--', 'node'])).pane_id, `core:${id}/t2`);
  assert.deepEqual(calls.pop(), ['--json', 'run', '--bg', '--no-parent', '--on', id, '--', 'node']);
  name = 'renamed';
  assert.equal((await runtimes.execute(['get', `core:${id}/t1`])).pane_id, `core:${id}/t1`);
  calls.length = 0;
  assert.equal((await runtimes.execute(['--machine', 'offline', 'send', 't1', 'hello'])).code, 'runtime_unavailable');
  assert.equal((await runtimes.execute(['--machine', 'missing', 'spawn', '--', 'node'])).code, 'invalid_arguments');
  assert.equal((await runtimes.execute(['--machine', 'renamed', 'close', 'core:t1'])).code, 'invalid_arguments');
  assert.equal((await runtimes.execute(['close', `core:${offline}/t1`])).code, 'runtime_unavailable');
  assert.deepEqual(calls, []);
});

test('subprocesses bound output and release shared capacity after cancellation', async t => {
  const budget = { active: 0 };
  const options = { binary: process.execPath, home: tmpdir(), path: process.env.PATH, budget, concurrency: 1, outputBytes: 32 };
  const first = createRunner(options), second = createRunner(options);
  t.after(() => { first.stop(); second.stop(); });
  const controller = new AbortController();
  const pending = first.run(['-e', 'setInterval(()=>{},1000)'], controller.signal);
  await assert.rejects(second.run(['-e', '']), { code: 'busy' });
  controller.abort();
  assert.equal((await pending).cancelled, true);
  const result = await second.run(['-e', 'process.stdout.write("x".repeat(1000))']);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 32);
  assert.equal(budget.active, 0);
});

test('clean replies follow the saved branch without exposing reasoning or unfinished turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-mcp-reply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  const message = (id, parentId, content, stopReason = 'stop') => ({
    type: 'message', id, parentId, message: { role: 'assistant', content, stopReason },
  });
  await writeFile(path, [
    { type: 'session', version: 3, id: 'session' },
    message('answer', null, [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Answer' }]),
    message('abandoned', null, [{ type: 'text', text: 'Wrong branch' }]),
    message('unfinished', 'answer', [{ type: 'text', text: 'Incomplete' }], 'aborted'),
  ].map(record => JSON.stringify(record) + '\n').join(''));
  const reply = await latestReply(path);
  assert.equal(reply.text, 'Answer');
  assert.equal(reply.message_id, 'answer');
  assert.equal(reply.newer_activity, true);
  const machineId = 'a'.repeat(32);
  const runtimes = createRuntimes({ core: { async run(args) {
    if (args[1] === 'machine') return json({ machines: [{ id: machineId, name: 'remote', state: 'connected' }] });
    if (args[1] === 'get') return json({ address: 'remote/t1', state: 'live', turn: 0, cwd: dir,
      status: { app: 'pi', state: 'idle' }, labels: { 'pi.session_file': path } });
    assert.equal(args[1], 'exec');
    assert.equal(args[3], machineId);
    return json({ code: 1, timed_out: false, truncated: false, stdout: '', stderr: '' });
  } } });
  assert.equal((await runtimes.execute(['reply', `core:${machineId}/t1`])).code, 'reply_unavailable',
    'a failed remote reader must not open the same path on the bridge host');
});

test('restart checks use the service environment and refuse another checkout', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const definition = {
    ExecStart: [['/usr/bin/mise', ['/usr/bin/mise', 'exec', 'node@latest', '--', 'node', 'src/server.mjs'], false]],
    WorkingDirectory: root, Environment: [], EnvironmentFiles: [['/service config/service.env', false]],
    UnsetEnvironment: [], RootDirectory: '', RootImage: '',
  };
  const args = await serviceCheckArguments(definition, root, 'check-live.mjs');
  assert.ok(args.includes('--property=EnvironmentFile=/service config/service.env'));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/usr/bin/mise', 'exec', 'node@latest', '--', 'node', join(root, 'scripts/check-live.mjs')]);
  await assert.rejects(serviceCheckArguments({ ...definition, WorkingDirectory: dirname(root) }, root, 'check-live.mjs'), /different checkout/);
});
