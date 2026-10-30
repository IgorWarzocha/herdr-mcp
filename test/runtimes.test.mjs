import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/bridge.mjs';
import { createRuntimes } from '../src/runtimes.mjs';
import { ok, snapshot, snapshotResult } from './fixtures/panes.mjs';

// Core short-list and full-get shapes verified against ca23c642 (see core.test.mjs).
const coreRow = (overrides = {}) => ({ address: 't1', name: 'core-worker', cwd: '/project',
  agent: 'pi', status: 'working', turn: 1, state: 'live', ...overrides });
const json = data => ({ ...ok, stdout: JSON.stringify(data) });
const failed = { ...ok, exit_code: 1, stderr: 'private runtime diagnostic' };

function fixture({ tui = true, core = true, tuiName = 'reviewer', coreName = 'core-worker',
  tuiOffline = false, coreOffline = false, tuiMutation = ok, coreMutation = json({ status: 'working', turn: 1, started: true }) } = {}) {
  const calls = { tui: [], core: [] };
  const value = snapshot();
  value.agents[0].name = tuiName;
  const row = coreRow({ name: coreName });
  const runtimes = createRuntimes({
    tui: tui ? { async run(args) {
      calls.tui.push(args);
      if (args[0] === 'api') return tuiOffline ? failed : snapshotResult(value);
      if (args[0] === 'workspace' && args[1] === 'create') return json({ result: { root_pane: { pane_id: 'w3:p1' } } });
      return tuiMutation;
    }, stop() {} } : undefined,
    core: core ? { async run(args) {
      calls.core.push(args);
      if (args[1] === 'ls') return coreOffline ? failed : json({ terminals: [row] });
      if (args[1] === 'read') return json({ text: 'Core screen', complete: true, how: 'screen' });
      if (args[1] === 'get') return json({ address: row.address, name: row.name, cwd: row.cwd,
        state: row.state, turn: row.turn, status: { state: row.status, app: row.agent }, labels: {} });
      if (args[1] === 'run' && coreMutation.exit_code === 0) return json(row);
      return coreMutation;
    }, stop() {} } : undefined,
  });
  return { runtimes, calls };
}

const mutations = calls => calls.filter(args => !['api', '--json'].includes(args[0]) ||
  (args[0] === '--json' && !['ls', 'get', 'read'].includes(args[1])));

test('merged directory preserves native TUI IDs and namespaces Core IDs without collapsing names', async () => {
  const { runtimes } = fixture({ coreName: 'reviewer' });
  const result = await runtimes.execute(['list']);
  assert.equal(result.code, 'ok');
  const panes = JSON.parse(result.stdout).panes;
  assert.deepEqual(panes.map(pane => [pane.pane_id, pane.runtime]),
    [['w1:p1', 'tui'], ['w2:p1', 'tui'], ['core:t1', 'core']]);
  assert.equal(panes.filter(pane => pane.name === 'reviewer').length, 2);
});

test('duplicate names across runtimes fail without reading or sending to either occupant', async () => {
  for (const verb of ['send', 'read', 'get', 'close']) {
    const { runtimes, calls } = fixture({ coreName: 'reviewer' });
    const result = await runtimes.execute([verb, 'reviewer', ...(verb === 'send' ? ['hello'] : [])]);
    assert.equal(result.code, 'ambiguous_target');
    assert.deepEqual(calls.tui, [['api', 'snapshot']]);
    assert.deepEqual(calls.core, [['--json', 'ls']]);
  }
});

test('qualified IDs route only to their owner even when both runtimes use the same name', async () => {
  for (const [target, owner, expected] of [
    ['w1:p1', 'tui', ['agent', 'prompt', 'w1:p1', 'hello']],
    ['core:t1', 'core', ['--json', 'send', 't1', '--', 'hello']],
  ]) {
    const { runtimes, calls } = fixture({ coreName: 'reviewer' });
    assert.equal((await runtimes.execute(['send', target, 'hello'])).code, 'ok');
    assert.deepEqual(calls[owner].at(-1), expected);
    assert.deepEqual(calls[owner === 'core' ? 'tui' : 'core'], []);
  }
});

test('explicit Core identities remain readable without a live-list membership or remote list query', async () => {
  const calls = [];
  const runtimes = createRuntimes({ core: { async run(args) {
    calls.push(args);
    if (args[1] === 'read') return json({ text: 'completed program output', complete: true, how: 'history' });
    throw new Error('A qualified read must not list other terminals');
  } } });
  const result = await runtimes.execute(['read', 'core:t42']);
  assert.equal(result.code, 'ok');
  assert.equal(result.stdout, 'completed program output');
  assert.deepEqual(calls, [['--json', 'read', 't42', '--lines', '80']]);
});

test('failed owner mutations are never retried on either runtime', async () => {
  for (const target of ['w1:p1', 'core:t1']) {
    const { runtimes, calls } = fixture({ tuiMutation: failed, coreMutation: failed });
    const result = await runtimes.execute(['send', target, 'hello']);
    assert.equal(result.code, 'command_failed');
    assert.equal(mutations(calls.tui).length + mutations(calls.core).length, 1);
    assert.deepEqual(calls[target === 'core:t1' ? 'tui' : 'core'], []);
    assert.ok(!JSON.stringify(result).includes('private runtime diagnostic'));
  }
});

test('an offline runtime stays visible, closes name routing, and does not block qualified healthy targets', async () => {
  for (const offline of ['tui', 'core']) {
    const { runtimes, calls } = fixture({ tuiOffline: offline === 'tui', coreOffline: offline === 'core' });
    const listed = await runtimes.execute(['list']);
    assert.equal(listed.code, 'ok');
    const inventory = JSON.parse(listed.stdout);
    assert.deepEqual(inventory.unavailable.map(item => item.runtime), [offline]);
    assert.ok(inventory.panes.every(pane => pane.runtime !== offline));
    const name = offline === 'tui' ? 'core-worker' : 'reviewer';
    assert.equal((await runtimes.execute(['send', name, 'unsafe'])).code, 'runtime_unavailable');
    assert.equal(mutations(calls.tui).length + mutations(calls.core).length, 0);
    calls.tui.length = 0; calls.core.length = 0;
    const target = offline === 'tui' ? 'core:t1' : 'w1:p1';
    assert.equal((await runtimes.execute(['send', target, 'safe'])).code, 'ok');
    assert.deepEqual(calls[offline], []);
  }
});

test('absent Core spawns a TUI workspace before starting the requested agent with literal argv', async () => {
  const { runtimes, calls } = fixture({ core: false });
  const result = await runtimes.execute(['spawn', '--name', 'new-worker', '--cwd', '/work dir', '--', 'pi', 'task with spaces', '--continue']);
  assert.equal(result.code, 'ok');
  assert.equal(result.pane_id, 'w3:p1');
  assert.deepEqual(calls.tui, [
    ['workspace', 'create', '--no-focus', '--label', 'new-worker', '--cwd', '/work dir'],
    ['agent', 'start', 'new-worker', '--kind', 'pi', '--pane', 'w3:p1', '--timeout', '20000', '--', 'task with spaces', '--continue'],
  ]);
  assert.deepEqual(calls.core, []);
});

test('installed Core owns new spawns, including failures: no TUI workspace fallback', async () => {
  for (const coreMutation of [json({}), failed]) {
    const { runtimes, calls } = fixture({ coreMutation });
    const result = await runtimes.execute(['spawn', '--name', 'new-worker', '--', 'pi', 'initial task']);
    assert.equal(result.code, coreMutation.exit_code === 0 ? 'ok' : 'command_failed');
    assert.deepEqual(calls.core, [['--json', 'run', '--bg', '--no-parent', '--name', 'new-worker', '--', 'pi', 'initial task']]);
    assert.deepEqual(calls.tui, []);
  }
});

test('target route guards reject option-like identities and never dispatch missing remote addresses', async () => {
  const { runtimes, calls } = fixture();
  for (const target of ['--current', '--session=other', 'core:remote/t1', 'core:tester', 'core:tmp', 'core:t0', 'core:t1a', 'core:t1l']) {
    assert.equal((await runtimes.execute(['send', target, 'hello'])).code, 'invalid_arguments');
  }
  assert.deepEqual(calls, { tui: [], core: [] });
  assert.equal((await runtimes.execute(['send', 'remote/t1', 'hello'])).code, 'pane_not_found');
  assert.equal(mutations(calls.tui).length + mutations(calls.core).length, 0);
  for (const args of [['--session', 'other', 'list'], ['pane', 'read', 'w1:p1', '--machine=other'],
    ['agent', 'prompt', 'core:t1', '--remote', 'other']]) {
    assert.throws(() => normalize({ args }));
  }
});

test('slash-containing labels remain local names, not machine routes', async () => {
  const { runtimes, calls } = fixture({ coreName: 'review/worker' });
  assert.equal((await runtimes.execute(['send', 'review/worker', 'hello'])).code, 'ok');
  assert.deepEqual(calls.core.at(-1), ['--json', 'send', 't1', '--', 'hello']);
  assert.equal(mutations(calls.tui).length, 0);
});

test('friendly and raw get/close cannot smuggle session routing through extra options', async () => {
  const { runtimes, calls } = fixture();
  for (const target of ['w1:p1', 'core:t1']) {
    for (const verb of ['get', 'close']) {
      for (const prefix of [[], ['pane'], ['agent']]) {
        // normalize is intentionally bypassed to test the unified dispatch boundary too.
        assert.equal((await runtimes.execute([...prefix, verb, target, '--session', 'other'])).code, 'invalid_arguments');
      }
    }
  }
  assert.deepEqual(calls, { tui: [], core: [] });
});

test('literal payloads are not reparsed as commands; TUI global routing payloads fail closed', async () => {
  const text = 'hello "quoted"\n$(touch /not-run); --force';
  for (const target of ['core:t1', 'w1:p1']) {
    const { runtimes, calls } = fixture();
    assert.equal((await runtimes.execute(normalize({ args: ['send', target, text] }))).code, 'ok');
    assert.equal((target === 'core:t1' ? calls.core : calls.tui).at(-1).at(-1), text);
  }
  const { runtimes, calls } = fixture();
  assert.equal((await runtimes.execute(normalize({ args: ['send', 'core:t1', '--session=other'] }))).code, 'ok');
  assert.deepEqual(calls.core.at(-1), ['--json', 'send', 't1', '--', '--session=other']);
  assert.equal((await runtimes.execute(normalize({ args: ['send', 'w1:p1', '--session=other'] }))).code, 'invalid_arguments');
  assert.equal(mutations(calls.tui).length, 0);
  assert.equal((await runtimes.execute(['read', 'core:t1', '--session', 'other'])).code, 'invalid_arguments');
});

test('raw agent and pane semantic aliases use the unified owner rather than leaking Core IDs to TUI', async () => {
  for (const prefix of ['agent', 'pane']) {
    const { runtimes, calls } = fixture();
    const read = await runtimes.execute(normalize({ args: [prefix, 'read', 'core:t1'] }));
    assert.equal(read.code, 'ok');
    assert.equal(read.stdout, 'Core screen');
    assert.deepEqual(calls.core.at(-1), ['--json', 'read', 't1', '--lines', '80']);
    assert.equal((await runtimes.execute(normalize({ args: [prefix, 'get', 'core:t1'] }))).code, 'ok');
    assert.deepEqual(calls.core.at(-1), ['--json', 'get', 't1']);
    assert.deepEqual(calls.tui, []);
  }
  for (const [prefix, verb] of [['agent', 'prompt'], ['pane', 'run']]) {
    const { runtimes, calls } = fixture();
    assert.equal((await runtimes.execute(normalize({ args: [prefix, verb, 'core:t1', 'literal task'] }))).code, 'ok');
    assert.deepEqual(calls.core.at(-1), ['--json', 'send', 't1', '--', 'literal task']);
    assert.deepEqual(calls.tui, []);
  }
});

test('raw TUI mutation flags keep their meaning instead of becoming literal prompt text', async () => {
  const { runtimes, calls } = fixture();
  const args = ['agent', 'prompt', 'reviewer', 'Review the change', '--wait', '--timeout', '1000'];
  const result = await runtimes.execute(normalize({ args }));
  assert.equal(result.code, 'ok');
  assert.deepEqual(calls.tui.at(-1), ['agent', 'prompt', 'w1:p1', 'Review the change', '--wait', '--timeout', '1000']);
  assert.equal(mutations(calls.tui).length, 1);
  assert.equal(mutations(calls.core).length, 0);
});
