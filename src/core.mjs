import { isAbsolute, extname } from 'node:path';
import { BridgeError, commandResult, exceptionResult, failure } from './errors.mjs';
import { readSessionReply } from './reply.mjs';

// Core reserves this exact ID shape. Other t-prefixed words are names and
// must never bypass the bridge's cross-runtime ambiguity checks.
export const CORE_ID = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
const LOCAL = CORE_ID;
const kinds = {
  not_found: 'pane_not_found', unavailable: 'runtime_unavailable', blocked: 'target_blocked',
  status_mismatch: 'target_busy', finished: 'target_finished', usage: 'invalid_arguments',
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

function summary(row) {
  requireData(object(row) && LOCAL.test(row.address) && typeof row.address === 'string' &&
    ['live', 'finished'].includes(row.state) && turnValid(row.turn) &&
    typeof row.agent === 'string' && typeof row.cwd === 'string' &&
    ['name', 'where', 'status'].every(key => optionalString(row[key])));
  return {
    pane_id: `core:${row.address}`, local_id: row.address, runtime: 'core',
    workspace_id: null, workspace_label: null, tab_id: null, tab_label: row.where ?? null,
    name: row.name ?? null, terminal_title: null, agent: row.agent,
    agent_status: row.status ?? 'unknown', state: row.state,
    state_change_seq: null, completion_seq: row.turn, cwd: row.cwd,
  };
}

function record(row, id) {
  requireData(object(row) && row.address === id && ['live', 'finished'].includes(row.state) &&
    turnValid(row.turn) && typeof row.cwd === 'string' && optionalString(row.name) &&
    ['exit_code', 'signal'].every(key => row[key] == null || Number.isSafeInteger(row[key])) &&
    optionalString(row.reason) &&
    (row.status == null || (object(row.status) && typeof row.status.state === 'string' && optionalString(row.status.app))));
  const pane = summary({ ...row, agent: row.status?.app ?? '', status: row.status?.state,
    where: row.labels?.where });
  return { ...pane, status: row.status ?? null, exit_code: row.exit_code ?? null,
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

  async function directory(signal) {
    return guarded(async () => {
      const result = await call(['ls'], signal);
      if (result.code !== 'ok') return { ...result, stdout: '' };
      const data = json(result);
      requireData(object(data) && Array.isArray(data.terminals));
      const panes = [], ids = new Set();
      for (const row of data.terminals) {
        requireData(object(row) && typeof row.address === 'string');
        if (row.address.includes('/')) continue; // Remote terminals are outside the pinned local runtime.
        const pane = summary(row);
        requireData(!ids.has(pane.local_id));
        ids.add(pane.local_id); panes.push(pane);
      }
      panes.sort((a, b) => a.pane_id.localeCompare(b.pane_id));
      return output(result, { panes });
    });
  }

  async function execute(verb, pane, options = [], signal, waitMaxMs = 90000) {
    return guarded(async () => {
      if (!pane || typeof pane.local_id !== 'string' || !LOCAL.test(pane.local_id) ||
          pane.pane_id !== `core:${pane.local_id}` || pane.runtime !== 'core') throw new BridgeError('invalid_arguments');
      const id = pane.local_id;
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
        requireData(object(data) && data.terminal === id && typeof data.ended === 'boolean' &&
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
        if (data?.address !== id || data?.status?.app !== 'pi' || typeof path !== 'string' ||
            !isAbsolute(path) || extname(path) !== '.jsonl') throw new BridgeError('reply_unavailable');
        const metadata = record(data, id);
        return readSessionReply(path, pane, options, signal, metadata.agent_status);
      }
      const metadata = record(data, id);
      return output({ ...result, pane_id: pane.pane_id, state: metadata.agent_status }, metadata);
    });
  }

  async function spawn(spec, signal) {
    return guarded(async () => {
      if (!object(spec) || Object.keys(spec).some(key => !['argv', 'cwd', 'name'].includes(key)) ||
          !Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
          !spec.argv[0] || ['cwd', 'name'].some(key => spec[key] !== undefined &&
            (typeof spec[key] !== 'string' || !spec[key] || spec[key].includes('\0')))) throw new BridgeError('invalid_arguments');
      const args = ['run', '--bg', '--no-parent'];
      for (const key of ['name', 'cwd']) if (spec[key] !== undefined) args.push(`--${key}`, spec[key]);
      args.push('--', ...spec.argv);
      const result = await call(args, signal);
      if (result.code !== 'ok') return result;
      const data = json(result);
      const pane = summary(data);
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
  return { directory, execute, spawn };
}
