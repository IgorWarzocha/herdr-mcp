import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, executeCommand, normalize, prepareWait } from '../src/bridge.mjs';
import { toolResult } from '../src/errors.mjs';
import { tmpdir } from 'node:os';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { createHandler } from '../src/server.mjs';

const ok = { exit_code: 0, stdout: '', stderr: '', timed_out: false, truncated: false, cancelled: false };
const expired = { ...ok, exit_code: 1, stderr: '{"id":"cli:wait","error":{"code":"timeout","message":"timed out waiting for agent status"}}' };

test('only read-only waits get a long budget and explicit durations cannot exceed the ceiling', () => {
  const friendly = normalize({args: ['wait', 'w1:p1']});
  assert.deepEqual(prepareWait(friendly).args, ['agent', 'wait', 'w1:p1', '--timeout', '90000']);
  assert.equal(prepareWait(['agent', 'wait', 'worker', '--timeout', '900000']).timeout_ms, 90000);
  assert.equal(prepareWait(['agent', 'wait', 'worker', '--timeout=20000']).timeout_ms, 20000);
  assert.equal(prepareWait(['agent', 'wait', 'worker'], 120000).timeout_ms, 120000);
  assert.equal(prepareWait(['agent', 'wait', 'worker', '--timeout=600000'], 600000).timeout_ms, 600000);
  assert.deepEqual(prepareWait(['pane', 'wait-output', 'w1:p1', '--contains', 'done']).args,
    ['pane', 'wait-output', 'w1:p1', '--contains', 'done', '--timeout', '90000']);
  for (const args of [['agent', 'prompt', 'worker', 'work', '--wait'], ['pane', 'run', 'w1:p1', 'wait'],
    ['agent', 'wait', '--help'], ['api', 'call', 'agent.wait']]) assert.equal(prepareWait(args), null);
  for (const args of [['agent', 'wait'], ['agent', 'wait', 'worker', '--timeout'],
    ['agent', 'wait', 'worker', '--timeout=-1'], ['agent', 'wait', 'worker', '--timeout', '20', '--timeout=30']]) {
    assert.throws(() => prepareWait(args), {code: 'invalid_arguments'});
  }
});

test('wait_timeout reports actual state and elapsed time, not assumed completion or working', async () => {
  for (const state of ['working', 'idle', 'blocked', 'done', 'unknown']) {
    const calls = [];
    const run = { async run(args, signal, options) {
      calls.push({args, options});
      return calls.length === 1 ? expired : { ...ok, stdout: JSON.stringify({result: {agent: {agent_status: state}}}) };
    }};
    const result = await executeCommand(run, ['agent', 'wait', 'worker']);
    assert.equal(result.code, 'wait_timeout');
    assert.equal(result.state, state);
    assert.equal(result.wait_timeout_ms, 90000);
    assert.ok(result.elapsed_ms >= 0);
    assert.equal(toolResult(result).isError, false);
    assert.deepEqual(calls[0].options, { timeoutMs: 92000 });
    assert.deepEqual(calls[1], {args: ['agent', 'get', 'worker'], options: {timeoutMs: 2000}});
  }
});

test('watchdog expiry is a wait outcome, but other failures do not become waits', async () => {
  const watchdog = { ...ok, exit_code: null, timed_out: true };
  const failedProbe = { ...ok, exit_code: 1, stderr: '{"error":{"code":"pane_not_found"}}' };
  const run = { async run(args) { return args[1] === 'get' ? failedProbe : watchdog; } };
  const wait = await executeCommand(run, ['pane', 'wait-output', 'w1:p1', '--contains', 'done']);
  assert.equal(wait.code, 'wait_timeout');
  assert.equal(wait.state, 'unknown');
  assert.equal(wait.state_error.code, 'pane_not_found');
  assert.equal((await executeCommand(run, ['agent', 'prompt', 'worker', 'hello'])).code, 'timeout');
  for (const first of [ok, failedProbe, {...ok, cancelled: true}]) {
    let calls = 0;
    const result = await executeCommand({async run() { calls++; return first; }}, ['agent', 'wait', 'worker']);
    assert.equal(calls, 1);
    assert.notEqual(result.code, 'wait_timeout');
  }
  const malformed = await executeCommand({async run(args) { return args[1] === 'get' ? {...ok, stdout: 'not json'} : expired; }}, ['agent', 'wait', 'worker']);
  assert.equal(malformed.state, 'unknown');
  assert.equal(malformed.state_error.code, 'bridge_error');
});

test('per-call wait budget overrides but does not mutate the ordinary subprocess watchdog', async t => {
  const run = createRunner({binary: process.execPath, home: tmpdir(), path: process.env.PATH, timeoutMs: 100});
  t.after(() => run.stop());
  const args = ['-e', 'setTimeout(()=>console.log("done"),300)'];
  const extended = await run.run(args, undefined, {timeoutMs: 2000});
  assert.equal(extended.exit_code, 0);
  assert.equal(extended.timed_out, false);
  assert.equal((await run.run(args)).timed_out, true);
});

test('disconnecting an HTTP wait terminates its subprocess and releases capacity', {timeout: 10000}, async t => {
  const childRunner = createRunner({binary: process.execPath, home: tmpdir(), path: process.env.PATH, concurrency: 1});
  const events = new EventEmitter();
  const runner = { async run(args, signal, options) {
    const pending = childRunner.run(['-e', 'setInterval(()=>{},1000)'], signal, options);
    events.emit('started');
    const result = await pending;
    events.emit('finished', result);
    return result;
  }};
  const http = createServer(createHandler({token: 'disconnect-test', runner, origins: []}));
  t.after(() => { childRunner.stop(); http.close(); http.closeAllConnections(); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);

  // More than the handler's 16 request slots also catches HTTP capacity leaks.
  for (let i = 0; i < 17; i++) {
    const deadline = AbortSignal.timeout(3000);
    const started = once(events, 'started', {signal: deadline});
    const finished = once(events, 'finished', {signal: deadline});
    const client = request(url, {method: 'POST', headers: {
      Authorization: 'Bearer disconnect-test', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }});
    // Closing our own connection can produce ECONNRESET before response headers.
    client.on('error', () => {});
    const response = once(client, 'response', {signal: deadline});
    client.end(JSON.stringify({jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: {
      name: 'herdr', arguments: {args: ['wait', 'worker']},
    }}));
    await started;
    const [stream] = await response;
    assert.match(stream.headers['content-type'], /^text\/event-stream/);
    stream.resume();
    client.destroy();
    const [result] = await finished;
    assert.equal(result.cancelled, true);
    assert.equal(result.timed_out, false);
    assert.notEqual(result.exit_code, 0);
  }
  assert.equal((await childRunner.run(['-e', ''])).exit_code, 0);
});
