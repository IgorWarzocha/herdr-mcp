import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, normalize } from '../src/bridge.mjs';
import { resolveTarget } from '../src/friendly.mjs';
import { projectDirectory } from '../src/directory.mjs';
import { ok, snapshot, snapshotResult } from './fixtures/panes.mjs';

function host({ idle = true, value = snapshot() } = {}) {
  const calls = [];
  return { calls, async run(args) {
    calls.push(args);
    if (args[0] === 'api') return snapshotResult(value);
    if (args[1] === 'process-info') return { ...ok, stdout: JSON.stringify({ result: { process_info: {
      pane_id: args[3], shell_pid: 100, foreground_processes: [{ pid: idle ? 100 : 200 }],
    } } }) };
    return ok;
  } };
}

test('friendly send selects the current occupant and never inserts a CLI delimiter', async () => {
  const run = host();
  assert.equal((await executeCommand(run, normalize({ command: 'send reviewer hello world' }))).code, 'ok');
  assert.deepEqual(run.calls.at(-1), ['agent', 'prompt', 'w1:p1', 'hello world']);
  assert.equal((await executeCommand(run, normalize({ args: ['send', 'w2:p1', 'printf "hello world"'] }))).code, 'ok');
  assert.deepEqual(run.calls.at(-1), ['pane', 'run', 'w2:p1', 'printf "hello world"']);
});

test('target matching accepts names and labels but never picks the first ambiguous pane', async () => {
  const panes = projectDirectory(snapshot());
  assert.equal(resolveTarget(panes, 'reviewer').pane_id, 'w1:p1');
  assert.equal(resolveTarget(panes, 'REVIEWER').pane_id, 'w1:p1');
  assert.equal(resolveTarget(panes, 'w2:t1').pane_id, 'w2:p1');
  assert.throws(() => resolveTarget(panes, 'MCP bridge'), { code: 'ambiguous_target' });
  assert.throws(() => resolveTarget(panes, 'missing'), { code: 'pane_not_found' });
  const run = host();
  for (const verb of ['send', 'read', 'wait', 'reply']) {
    const result = await executeCommand(run, [verb, 'MCP bridge', ...(verb === 'send' ? ['hello'] : [])]);
    assert.equal(result.code, 'ambiguous_target');
  }
  assert.ok(run.calls.every(args => args[0] === 'api'), 'ambiguity must not send input or read an arbitrary pane');
});

test('friendly reads default to unwrapped text without overriding an explicit source', async () => {
  const value = snapshot(); value.tabs[0].label = 'Pi review';
  const run = host({ value });
  for (const [target, options, expected] of [
    ['Pi review', [], ['--source', 'recent-unwrapped']],
    ['reviewer', ['--lines', '200'], ['--lines', '200', '--source', 'recent-unwrapped']],
    ['w1:p1', ['--source', 'visible'], ['--source', 'visible']],
  ]) {
    await executeCommand(run, normalize({ args: ['read', target, ...options] }));
    assert.deepEqual(run.calls.at(-1), ['pane', 'read', 'w1:p1', ...expected]);
  }
});

test('friendly waits select agent state, shell readiness or an explicit output match', async () => {
  const run = host();
  await executeCommand(run, ['wait', 'reviewer', '--timeout', '25']);
  assert.deepEqual(run.calls.at(-1), ['agent', 'wait', 'w1:p1', '--timeout', '25']);
  await executeCommand(run, ['wait', 'w2:p1', '--match', 'done', '--timeout', '25']);
  assert.deepEqual(run.calls.at(-1), ['pane', 'wait-output', 'w2:p1', '--match', 'done', '--timeout', '25']);
  const ready = await executeCommand(run, ['wait', 'w2:p1']);
  assert.equal(ready.code, 'ok'); assert.equal(ready.state, 'idle');
  const busy = host({ idle: false });
  const expired = await executeCommand(busy, ['wait', 'w2:p1', '--timeout', '0']);
  assert.equal(expired.code, 'wait_timeout'); assert.equal(expired.state, 'working');
  assert.equal((await executeCommand(busy, ['send', 'w2:p1', 'danger'])).code, 'target_busy');
  assert.ok(busy.calls.every(args => ['api', 'process-info'].includes(args[0] === 'api' ? args[0] : args[1])));
});

test('translation cannot reopen session routing and failures never trigger a second send route', async () => {
  const run = host();
  for (const payload of ['--session=other', '--machine=other', '--remote=host']) {
    assert.equal((await executeCommand(run, normalize({ args: ['send', 'reviewer', payload] }))).code, 'invalid_arguments');
  }
  assert.ok(run.calls.every(args => args[0] === 'api'));
  const failed = host();
  const original = failed.run;
  failed.run = async args => args[1] === 'prompt'
    ? { ...ok, exit_code: 1, stderr: '{"error":{"code":"agent_blocked"}}' } : original(args);
  assert.equal((await executeCommand(failed, ['send', 'reviewer', 'hello'])).code, 'command_failed');
  assert.ok(!failed.calls.some(args => args[1] === 'run'));
});

test('cancellation interrupts a shell wait without declaring completion', async () => {
  const run = host({ idle: false });
  const controller = new AbortController();
  const pending = executeCommand(run, ['wait', 'w2:p1'], controller.signal);
  setTimeout(() => controller.abort(), 20);
  assert.equal((await pending).code, 'cancelled');
});
