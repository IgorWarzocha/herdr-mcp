import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreBackend } from '../src/core.mjs';
import { BridgeError } from '../src/errors.mjs';

// Shapes verified against core ca23c642: cli/output.rs short(), api/types.rs,
// terminals.rs Public and wait.rs WaitResult. These test our mapping, not hc.
const row = (overrides = {}) => ({ address: 't1', agent: 'pi', state: 'live', turn: 4,
  cwd: '/work', name: 'worker', status: 'idle', where: 'review', ...overrides });
const raw = (data, overrides = {}) => ({ exit_code: 0, signal: null, stdout: JSON.stringify(data),
  stderr: '', timed_out: false, truncated: false, cancelled: false, ...overrides });
const terminal = (overrides = {}) => ({ address: 't1', name: 'worker', cwd: '/work',
  state: 'live', turn: 4, status: { state: 'idle', app: 'pi' }, labels: {}, ...overrides });
const pane = { pane_id: 'core:t1', local_id: 't1', runtime: 'core' };
function fixture(...responses) {
  const calls = [];
  const backend = createCoreBackend({ async run(args, signal, budget) {
    calls.push({ args, signal, budget });
    assert.ok(responses.length, 'Unexpected subprocess (possibly a mutation retry)');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  return { backend, calls };
}

test('directory projects local identities without guessing agent readiness or leaking remote targets', async () => {
  const { backend, calls } = fixture(raw({ terminals: [row(), row({ address: 'box/t2' }),
    row({ address: 't2', name: null, agent: 'zsh', status: undefined, where: undefined })] }));
  const signal = new AbortController().signal;
  const result = await backend.directory(signal);
  assert.equal(result.code, 'ok');
  const panes = JSON.parse(result.stdout).panes;
  assert.deepEqual(panes[0], { ...pane, workspace_id: null, workspace_label: null, tab_id: null,
    tab_label: 'review', name: 'worker', terminal_title: null, agent: 'pi', agent_status: 'idle',
    state: 'live', state_change_seq: null, completion_seq: 4, cwd: '/work' });
  assert.equal(panes[1].agent, 'zsh');
  assert.equal(panes[1].agent_status, 'unknown');
  assert.equal(panes[1].tab_label, null);
  assert.deepEqual(calls, [{ args: ['--json', 'ls'], signal, budget: undefined }]);
});

test('malformed or duplicate local directory data never yields a partial targeting directory', async () => {
  for (const data of [null, { terminals: {} }, { terminals: [row(), row()] },
    { terminals: [row({ address: '--machine' })] }, { terminals: [row({ address: 'core:t1' })] },
    { terminals: [row({ address: null })] }, { terminals: [row({ turn: '4' })] },
    { terminals: [row({ status: { state: 'idle' } })] }, { terminals: [row({ agent: null })] },
    { terminals: [row({ where: 7 })] }, { terminals: [row({ cwd: false })] }]) {
    const { backend } = fixture(raw(data));
    const result = await backend.directory();
    assert.equal(result.code, 'bridge_error');
    assert.equal(result.stdout, undefined);
  }
  const { backend } = fixture(raw({ terminals: [] }, { truncated: true }));
  const result = await backend.directory();
  assert.equal(result.code, 'truncated');
  assert.equal(result.stdout, '');
});

test('local routing is enforced before every target operation', async () => {
  const { backend, calls } = fixture();
  for (const target of [{ ...pane, local_id: 'remote/t1' }, { ...pane, pane_id: 't1' },
    { ...pane, runtime: 'tui' }, { ...pane, local_id: '--help' }, null]) {
    for (const verb of ['get', 'close', 'send', 'read', 'wait', 'reply']) {
      assert.equal((await backend.execute(verb, target, verb === 'send' ? ['hi'] : [])).code, 'invalid_arguments');
    }
  }
  assert.equal(calls.length, 0);
});

test('read translates bounded sources honestly, preserving incomplete output', async () => {
  for (const [options, lines, source] of [[[], '80', 'recent-unwrapped'],
    [['--lines=12', '--source', 'recent'], '12', 'recent'],
    [['--lines', '99', '--source=visible'], '0', 'visible']]) {
    const { backend, calls } = fixture(raw({ text: 'screen', complete: false, how: 'screen', why: 'working' }));
    const result = await backend.execute('read', pane, options);
    assert.equal(result.stdout, 'screen');
    assert.equal(result.code, 'ok');
    assert.equal(result.source, source);
    assert.equal(result.how, 'screen');
    assert.equal(result.why, 'working');
    assert.equal(result.truncated, true);
    assert.deepEqual(calls[0].args, ['--json', 'read', 't1', '--lines', lines]);
  }
  const { backend, calls } = fixture();
  for (const options of [['--source', 'history'], ['--lines', '-1'], ['--lines', '1.5'],
    ['--lines', '3', '--lines=4'], ['--machine', 'box'], ['--source']]) {
    assert.equal((await backend.execute('read', pane, options)).code, 'invalid_arguments');
  }
  assert.equal(calls.length, 0);
  const invalid = fixture(raw({ text: 'untrusted', how: 'screen' }));
  assert.equal((await invalid.backend.execute('read', pane)).code, 'bridge_error');
});

test('send submits exactly one literal payload and preserves an unknown acknowledgement', async () => {
  const text = '--force --machine box\n$(echo danger)';
  const { backend, calls } = fixture(raw({ status: null, turn: 4, started: null }));
  const result = await backend.execute('send', pane, [text]);
  assert.equal(result.state, 'unknown');
  assert.deepEqual(JSON.parse(result.stdout), { pane_id: 'core:t1', status: null, turn: 4, started: null });
  assert.deepEqual(calls[0].args, ['--json', 'send', 't1', '--', text]);
  assert.equal(calls.length, 1);
  const invalid = fixture();
  for (const options of [[], ['a', 'b'], ['a\0b']]) {
    assert.equal((await invalid.backend.execute('send', pane, options)).code, 'invalid_arguments');
  }
  assert.equal(invalid.calls.length, 0);
});

test('wait caps milliseconds, uses seconds and reports unknown timeout state without probing or resending', async () => {
  const data = { terminal: 't1', ended: false, reason: 'timeout', status: null, turn: 4, exit_code: null, signal: null };
  const signal = new AbortController().signal;
  const { backend, calls } = fixture(raw(data));
  const result = await backend.execute('wait', pane, ['--timeout=99999', '--match', 'ready'], signal, 1250);
  assert.equal(result.code, 'wait_timeout');
  assert.equal(result.state, 'unknown');
  assert.equal(result.wait_timeout_ms, 1250);
  assert.equal(result.output_scope, 'after_wait_started');
  assert.equal(JSON.parse(result.stdout).ended, false);
  assert.deepEqual(calls, [{ args: ['--json', 'wait', 't1', '--timeout', '1.25', '--output', 'ready'],
    signal, budget: { timeoutMs: 3250 } }]);
  const watchdog = fixture(raw(null, { timed_out: true, exit_code: null }));
  assert.equal((await watchdog.backend.execute('wait', pane, [], undefined, 100)).code, 'wait_timeout');
  assert.equal(watchdog.calls.length, 1);
  const invalid = fixture();
  for (const options of [['--regex', 'x'], ['--timeout', 'NaN'], ['--timeout', '2', '--timeout=3']]) {
    assert.equal((await invalid.backend.execute('wait', pane, options)).code, 'invalid_arguments');
  }
  assert.equal(invalid.calls.length, 0);
});

test('wait completion keeps the observed status rather than translating unknown to done', async () => {
  for (const status of [null, 'blocked', 'done', 'custom']) {
    const { backend } = fixture(raw({ terminal: 't1', ended: true, reason: 'status', status, turn: 4 }));
    const result = await backend.execute('wait', pane);
    assert.equal(result.code, 'ok');
    assert.equal(result.state, status ?? 'unknown');
  }
  const { backend } = fixture(raw({ terminal: 'remote/t1', ended: true, reason: 'status', status: 'done', turn: 4 }));
  assert.equal((await backend.execute('wait', pane)).code, 'bridge_error');
});

test('get and close normalize full records; close only kills once', async () => {
  for (const verb of ['get', 'close']) {
    const { backend, calls } = fixture(raw(terminal({ status: null })));
    const result = await backend.execute(verb, pane);
    assert.equal(result.code, 'ok');
    assert.equal(result.state, 'unknown');
    assert.equal(JSON.parse(result.stdout).agent_status, 'unknown');
    assert.deepEqual(calls[0].args, ['--json', verb === 'close' ? 'kill' : 'get', 't1']);
    assert.equal(calls.length, 1);
  }
  const { backend } = fixture(raw(terminal({ address: 't2' })));
  assert.equal((await backend.execute('get', pane)).code, 'bridge_error');
});

test('reply refuses unreported, non-Pi or unvalidated session paths', async () => {
  for (const data of [terminal(), terminal({ address: 't2' }), terminal({ status: null }), terminal({ status: { state: 'idle', app: 'zsh' },
    labels: { 'pi.session_file': '/private/session.jsonl' } }),
    terminal({ labels: { 'pi.session_file': 'relative.jsonl' } }),
    terminal({ labels: { 'pi.session_file': '/private/session.txt' } })]) {
    const { backend, calls } = fixture(raw(data));
    assert.equal((await backend.execute('reply', pane)).code, 'reply_unavailable');
    assert.equal(calls.length, 1);
  }
});

test('reply uses only the reported local Pi session, forwarding pagination and current status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-core-reply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pi.jsonl');
  await writeFile(path, [
    { type: 'session', version: 3, id: 'session' },
    { type: 'message', id: 'reply', parentId: null, message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'hello world' }] } },
  ].map(value => JSON.stringify(value) + '\n').join(''));
  const { backend, calls } = fixture(raw(terminal({ status: { state: 'working', app: 'pi' },
    labels: { 'pi.session_file': path } })));
  const result = await backend.execute('reply', pane, ['--offset=6', '--limit=5']);
  assert.equal(result.code, 'ok');
  assert.equal(result.stdout, 'world');
  assert.equal(result.pane_id, 'core:t1');
  assert.equal(result.agent_status, 'working');
  assert.equal(result.source, 'pi_session');
  assert.equal(calls.length, 1);
});

test('spawn launches detached argv exactly once and returns a namespaced address', async () => {
  const { backend, calls } = fixture(raw(row()));
  const signal = new AbortController().signal;
  const result = await backend.spawn({ argv: ['pi', 'initial task --literal'], cwd: '/work dir', name: 'worker' }, signal);
  assert.equal(result.code, 'ok');
  assert.equal(result.pane_id, 'core:t1');
  assert.equal(JSON.parse(result.stdout).local_id, 't1');
  assert.deepEqual(calls, [{ args: ['--json', 'run', '--bg', '--no-parent', '--name', 'worker', '--cwd', '/work dir',
    '--', 'pi', 'initial task --literal'], signal, budget: undefined }]);
});

test('template launch reports task delivery separately from the created program', async () => {
  for (const sent of [true, false]) {
    const { backend, calls } = fixture(raw({ ...row(), first_message: { sent, started: false, reason: 'private diagnostic' } }));
    const result = await backend.spawn({ argv: ['reviewer', 'Review the change'] });
    assert.equal(result.code, 'ok');
    assert.deepEqual(JSON.parse(result.stdout).first_message, { sent, started: false, turn: null });
    assert.ok(!JSON.stringify(result).includes('private diagnostic'));
    if (!sent) assert.match(result.next, /not delivered/);
    assert.equal(calls.length, 1, 'never retry task delivery or launch a second program');
  }
});

test('spawn rejects remote/malformed identities after launch without retrying a mutation', async () => {
  for (const data of [row({ address: 'box/t1' }), row({ address: 'core:t1' }), row({ address: 't-' }),
    row({ address: 'tester' }), row({ address: 't0' }), row({ address: 't1a' }), row({ address: 't1l' }),
    { terminal: row() }, row({ address: 7 })]) {
    const { backend, calls } = fixture(raw(data));
    assert.equal((await backend.spawn({ argv: ['pi'] })).code, 'bridge_error');
    assert.equal(calls.length, 1);
  }
  const { backend, calls } = fixture();
  for (const spec of [{ argv: [] }, { argv: [''] }, { argv: ['pi\0'] }, { argv: ['pi'], on: 'remote' },
    { argv: ['pi'], cwd: '' }, { argv: ['pi'], name: 1 }]) {
    assert.equal((await backend.spawn(spec)).code, 'invalid_arguments');
  }
  assert.equal(calls.length, 0);
});

test('Core failure kinds are sanitized and never trigger mutation fallback', async () => {
  for (const [kind, code] of Object.entries({ not_found: 'pane_not_found', unavailable: 'runtime_unavailable',
    blocked: 'target_blocked', status_mismatch: 'target_busy', finished: 'target_finished', usage: 'invalid_arguments',
    unexpected: 'command_failed' })) {
    const { backend, calls } = fixture(raw(null, { exit_code: 1,
      stdout: 'private output', stderr: JSON.stringify({ error: { kind, message: 'SECRET', hint: 'SECRET' } }) }));
    const result = await backend.execute('send', pane, ['hi']);
    assert.equal(result.code, code);
    assert.equal(result.stdout, '');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.equal(calls.length, 1);
  }
});

test('runner cancellation, timeouts, truncation and slot rejection keep their public meaning', async () => {
  for (const [response, code] of [[raw(null, { cancelled: true, exit_code: null }), 'cancelled'],
    [raw(null, { timed_out: true, exit_code: null }), 'timeout'],
    [raw({ text: 'partial' }, { truncated: true }), 'truncated'], [new BridgeError('busy'), 'busy'],
    [new Error('SECRET'), 'bridge_error']]) {
    const { backend, calls } = fixture(response);
    const result = await backend.execute('send', pane, ['hi']);
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.equal(calls.length, 1);
  }
});
