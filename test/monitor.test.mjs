import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, executeCommand, normalize, prepareWait } from '../src/bridge.mjs';
import { toolResult } from '../src/errors.mjs';
import { tmpdir } from 'node:os';

const ok = { exit_code: 0, stdout: '', stderr: '', timed_out: false, truncated: false, cancelled: false };
const expired = { ...ok, exit_code: 1, stderr: '{"id":"cli:wait","error":{"code":"timeout","message":"timed out waiting for agent status"}}' };

test('only read-only waits get a long budget and explicit durations cannot exceed the ceiling', () => {
  const friendly = normalize({args: ['wait', 'w1:p1']});
  assert.deepEqual(prepareWait(friendly).args, ['agent', 'wait', 'w1:p1', '--timeout', '600000']);
  assert.equal(prepareWait(['agent', 'wait', 'worker', '--timeout', '900000']).timeout_ms, 600000);
  assert.equal(prepareWait(['agent', 'wait', 'worker', '--timeout=20000']).timeout_ms, 20000);
  assert.equal(prepareWait(['agent', 'wait', 'worker'], 120000).timeout_ms, 120000);
  assert.deepEqual(prepareWait(['pane', 'wait-output', 'w1:p1', '--contains', 'done']).args,
    ['pane', 'wait-output', 'w1:p1', '--contains', 'done', '--timeout', '600000']);
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
    assert.equal(result.wait_timeout_ms, 600000);
    assert.ok(result.elapsed_ms >= 0);
    assert.equal(toolResult(result).isError, false);
    assert.deepEqual(calls[0].options, { timeoutMs: 602000 });
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
