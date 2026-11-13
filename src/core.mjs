import { isAbsolute, extname } from 'node:path';
import { BridgeError, commandResult, exceptionResult, failure } from './errors.mjs';
import { readSessionReply } from './reply.mjs';
import { readRemoteSessionReply } from './remote-reply.mjs';
import { CORE_ADDRESS, LOCAL_MACHINE, machineCatalogue, selectMachine, requireConnected, corePane } from './core-routing.mjs';

// Core reserves this exact ID shape. Other t-prefixed words are names and
// must never bypass the bridge's cross-runtime ambiguity checks.
export { CORE_ID, CORE_ADDRESS } from './core-routing.mjs';
const kinds = {
  not_found: 'pane_not_found', unavailable: 'runtime_unavailable', blocked: 'target_blocked',
  status_mismatch: 'target_busy', finished: 'target_finished', usage: 'invalid_arguments',
  machine_unknown: 'invalid_arguments', needs_update: 'runtime_unavailable',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = value => value == null || typeof value === 'string';
const turnValid = value => Number.isSafeInteger(value) && value >= 0;
function requireData(valid) { if (!valid) throw new BridgeError('bridge_error'); }

function coreResult(raw) {
  if (!raw.cancelled && !raw.timed_out && raw.exit_code !== 0) {
    for (const line of raw.stderr.split('\n')) {
      let kind;
      try { kind = JSON.parse(line)?.error?.kind; } catch { continue; }
      if (Object.hasOwn(kinds, kind)) {
        const detail = failure(kinds[kind]);
        return { ...raw, stdout: '', stderr: detail.message, ...detail };
      }
    }
  }
  return commandResult(raw);
}

function summary(row, machines = []) {
  requireData(object(row) && typeof row.address === 'string' &&
    ['live', 'finished'].includes(row.state) && turnValid(row.turn) &&
    typeof row.agent === 'string' && typeof row.cwd === 'string' &&
    ['name', 'where', 'status'].every(key => optionalString(row[key])));
  return {
    ...corePane(row.address, machines),
    workspace_id: null, workspace_label: null, tab_id: null, tab_label: row.where ?? null,
    name: row.name ?? null, terminal_title: null, agent: row.agent,
    agent_status: row.status ?? 'unknown', state: row.state,
    state_change_seq: null, completion_seq: row.turn, cwd: row.cwd,
  };
}

function record(row, pane) {
  const machines = [{ id: pane.machine_id, name: pane.machine_name, state: 'connected' }];
  requireData(object(row) && corePane(row.address, machines).pane_id === pane.pane_id && ['live', 'finished'].includes(row.state) &&
    turnValid(row.turn) && typeof row.cwd === 'string' && optionalString(row.name) &&
    ['exit_code', 'signal'].every(key => row[key] == null || Number.isSafeInteger(row[key])) &&
    optionalString(row.reason) &&
    (row.status == null || (object(row.status) && typeof row.status.state === 'string' && optionalString(row.status.app))));
  const metadata = summary({ ...row, agent: row.status?.app ?? '', status: row.status?.state,
    where: row.labels?.where }, machines);
  return { ...metadata, status: row.status ?? null, exit_code: row.exit_code ?? null,
    signal: row.signal ?? null, reason: row.reason ?? null };
}

function flags(options, allowed) {
  if (!Array.isArray(options) || options.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new BridgeError('invalid_arguments');
  }
  const values = {};
  for (let i = 0; i < options.length; i++) {
    const [flag, inline] = options[i].split(/=(.*)/s, 2);
    if (!allowed.includes(flag) || Object.hasOwn(values, flag)) throw new BridgeError('invalid_arguments');
    const value = inline ?? options[++i];
    if (value === undefined) throw new BridgeError('invalid_arguments');
    values[flag] = value;
  }
  return values;
}

function integer(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BridgeError('invalid_arguments');
  return Number(value);
}

// The runner owns the pinned session, isolated environment and subprocess slots.
// This adapter owns only the public-to-Core contract; it never retries mutations.
export function createCoreBackend(runner) {
  async function call(args, signal, budget) {
    return coreResult(await runner.run(['--json', ...args], signal, budget));
  }
  async function guarded(action) {
    try { return await action(); } catch (error) { return exceptionResult(error); }
  }
  function json(result) {
    try { return JSON.parse(result.stdout); } catch { throw new BridgeError('bridge_error'); }
  }
  function output(result, value) {
    const stdout = JSON.stringify(value);
    if (Buffer.byteLength(stdout) > 131072) return { ...result, stdout: '', ...failure('truncated'), truncated: true };
    return { ...result, stdout };
  }

  async function catalogue(signal) {
    const result = await call(['machine', 'ls'], signal);
    if (result.code !== 'ok') throw new BridgeError(result.code, result.next);
    return machineCatalogue(json(result).machines);
  }

  async function machine(selector, signal) {
    if (selector === 'local') return LOCAL_MACHINE;
    const selected = selectMachine(await catalogue(signal), selector);
    requireConnected(selected);
    return selected;
  }

  async function pane(address, signal) {
    if (!CORE_ADDRESS.test(address)) throw new BridgeError('invalid_arguments');
    const selected = address.includes('/') ? await machine(address.split('/')[0], signal) : LOCAL_MACHINE;
    return corePane(address, [selected]);
  }

  async function directory(signal, selected) {
    return guarded(async () => {
      const result = await call(['ls'], signal);
      if (result.code !== 'ok') return { ...result, stdout: '' };
      const data = json(result);
      requireData(object(data) && Array.isArray(data.terminals));
      requireData(data.machines === undefined || Array.isArray(data.machines));
      // `hc ls` deliberately projects machine health without permanent IDs.
      // Only the catalogue can turn its alias-prefixed rows into durable IDs.
      const machines = data.machines?.length ? await catalogue(signal) : [];
      const panes = [], ids = new Set();
      for (const row of data.terminals) {
        requireData(object(row) && typeof row.address === 'string');
        const pane = summary(row, machines);
        requireData(!ids.has(pane.pane_id));
        ids.add(pane.pane_id);
        if (!selected || pane.machine_id === selected.id) panes.push(pane);
      }
      panes.sort((a, b) => a.pane_id.localeCompare(b.pane_id));
      return output(result, { panes, machines: [LOCAL_MACHINE, ...machines] });
    });
  }

  async function execute(verb, pane, options = [], signal, waitMaxMs = 90000) {
    return guarded(async () => {
      const id = pane?.address ?? pane?.local_id;
      if (!pane || !CORE_ADDRESS.test(id) || pane.pane_id !== `core:${id}` || pane.runtime !== 'core') throw new BridgeError('invalid_arguments');
      const machines = [{ id: pane.machine_id, name: pane.machine_name, state: 'connected' }];
      if (verb === 'read') {
        const opts = flags(options, ['--lines', '--source']);
        const source = opts['--source'] ?? 'recent-unwrapped';
        if (!['visible', 'recent', 'recent-unwrapped'].includes(source)) throw new BridgeError('invalid_arguments');
        const lines = opts['--lines'] === undefined ? 80 : integer(opts['--lines']);
        const result = await call(['read', id, '--lines', String(source === 'visible' ? 0 : lines)], signal);
        if (result.code !== 'ok') return result;
        const data = json(result);
        requireData(object(data) && typeof data.text === 'string' && typeof data.complete === 'boolean' &&
          typeof data.how === 'string' && optionalString(data.why));
        return { ...result, stdout: data.text, pane_id: pane.pane_id, source, how: data.how,
          truncated: !data.complete, ...(data.why == null ? {} : { why: data.why }) };
      }
      if (verb === 'send') {
        if (!Array.isArray(options) || options.length !== 1 || typeof options[0] !== 'string' || options[0].includes('\0')) {
          throw new BridgeError('invalid_arguments');
        }
        const result = await call(['send', id, '--', options[0]], signal);
        if (result.code !== 'ok') return result;
        const data = json(result);
        requireData(object(data) && optionalString(data.status) && turnValid(data.turn) &&
          (data.started === null || typeof data.started === 'boolean'));
        return output({ ...result, pane_id: pane.pane_id, state: data.status ?? 'unknown' },
          { pane_id: pane.pane_id, status: data.status ?? null, turn: data.turn, started: data.started });
      }
      if (verb === 'wait') {
        const opts = flags(options, ['--timeout', '--match']);
        if (!Number.isSafeInteger(waitMaxMs) || waitMaxMs < 1) throw new BridgeError('invalid_arguments');
        const ms = Math.min(waitMaxMs, opts['--timeout'] === undefined ? waitMaxMs : integer(opts['--timeout']));
        const args = ['wait', id, '--timeout', String(ms / 1000)];
        if (opts['--match'] !== undefined) args.push('--output', opts['--match']);
        let result = await call(args, signal, { timeoutMs: ms + 2000 });
        const meta = { pane_id: pane.pane_id, wait_timeout_ms: ms,
          ...(opts['--match'] === undefined ? {} : { output_scope: 'after_wait_started' }) };
        if (result.code === 'timeout') return { ...result, ...failure('wait_timeout'), ...meta, state: 'unknown' };
        if (result.code !== 'ok') return { ...result, ...meta };
        const data = json(result);
        requireData(object(data) && corePane(data.terminal, machines).pane_id === pane.pane_id && typeof data.ended === 'boolean' &&
          typeof data.reason === 'string' && optionalString(data.status) && turnValid(data.turn) &&
          ['exit_code', 'signal'].every(key => data[key] == null || Number.isSafeInteger(data[key])));
        result = output(result, { pane_id: pane.pane_id, ended: data.ended, reason: data.reason,
          status: data.status ?? null, turn: data.turn, exit_code: data.exit_code ?? null, signal: data.signal ?? null });
        return { ...result, ...(!data.ended ? failure('wait_timeout') : {}), ...meta, state: data.status ?? 'unknown' };
      }
      if (!['get', 'close', 'reply'].includes(verb) || (verb !== 'reply' && options.length)) throw new BridgeError('invalid_arguments');
      const result = await call([verb === 'close' ? 'kill' : 'get', id], signal);
      if (result.code !== 'ok') return result;
      const data = json(result);
      if (verb === 'reply') {
        const path = data?.labels?.['pi.session_file'];
        if (data?.status?.app !== 'pi' || typeof path !== 'string' || extname(path) !== '.jsonl') throw new BridgeError('reply_unavailable');
        const metadata = record(data, pane);
        if (pane.machine_id !== 'local') return readRemoteSessionReply(call, pane, path, options, signal, metadata.agent_status);
        if (!isAbsolute(path)) throw new BridgeError('reply_unavailable');
        return readSessionReply(path, pane, options, signal, metadata.agent_status);
      }
      const metadata = record(data, pane);
      return output({ ...result, pane_id: pane.pane_id, state: metadata.agent_status }, metadata);
    });
  }

  async function spawn(spec, signal, selected = LOCAL_MACHINE) {
    return guarded(async () => {
      if (!object(spec) || Object.keys(spec).some(key => !['argv', 'cwd', 'name'].includes(key)) ||
          !Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
          !spec.argv[0] || ['cwd', 'name'].some(key => spec[key] !== undefined &&
            (typeof spec[key] !== 'string' || !spec[key] || spec[key].includes('\0')))) throw new BridgeError('invalid_arguments');
      const args = ['run', '--bg', '--no-parent'];
      if (selected.id !== 'local') args.push('--on', selected.id);
      for (const key of ['name', 'cwd']) if (spec[key] !== undefined) args.push(`--${key}`, spec[key]);
      args.push('--', ...spec.argv);
      const result = await call(args, signal);
      if (result.code !== 'ok') return result;
      const data = json(result);
      const pane = summary(data, [selected]);
      requireData(pane.machine_id === selected.id);
      if (data.first_message !== undefined) {
        const first = data.first_message;
        requireData(object(first) && typeof first.sent === 'boolean' &&
          (first.started == null || typeof first.started === 'boolean') &&
          (first.turn == null || turnValid(first.turn)));
        pane.first_message = { sent: first.sent, started: first.started ?? null, turn: first.turn ?? null };
      }
      return output({ ...result, pane_id: pane.pane_id, ...(pane.first_message?.sent === false
        ? { next: 'The program was created, but its template task was not delivered. Inspect this pane before sending input.' } : {}) }, pane);
    });
  }
  return { directory, execute, spawn, machine, pane };
}
