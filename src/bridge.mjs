import { spawn } from 'node:child_process';
import { readDirectory } from './directory.mjs';
import { FRIENDLY_VERBS, prepareFriendly } from './friendly.mjs';
import { BridgeError, commandResult, exceptionResult, failure } from './errors.mjs';

// Quote-only shell words: no substitution, expansion, operators, or shell process.
export function splitCommand(command) {
  const words = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (!quote && /\s/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false;
    } else if (c === quote) {
      quote = ''; started = true;
    } else if (!quote && (c === '"' || c === "'")) {
      quote = c; started = true;
    } else if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) throw new Error('Trailing backslash; use args for literal text');
      if (quote === '"' && !['"', '\\', '$', '`', '\n'].includes(next)) word += '\\';
      if (next !== '\n') word += next;
      started = true;
    } else {
      if (!quote && /[;|&<>`]/.test(c)) throw new Error('Shell operators are unsupported; quote literal text or use args');
      word += c; started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote; use args for literal text');
  if (started) words.push(word);
  return words;
}

const allowed = new Set(['pane', 'agent', 'workspace', 'tab', 'notification', 'status', 'api']);
const inputActions = new Set(['run', 'send-text', 'send-keys', 'prompt']);

export function normalize(input) {
  if ((input.args !== undefined) === (input.command !== undefined)) {
    throw new Error('Supply exactly one of args or command');
  }
  let args = input.args ?? splitCommand(input.command);
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) ||
      args.length > 256 || Buffer.byteLength(JSON.stringify(args)) > 65536) {
    throw new Error('Arguments must be strings without NUL, at most 256 arguments and 64 KiB');
  }
  if (!args.length) return ['--help'];
  const [verb, target, ...rest] = args;
  if (verb === 'list') {
    if (args.length !== 1) throw new Error('Use list, or raw pane list / agent list');
    return ['list'];
  } else if (FRIENDLY_VERBS.includes(verb)) {
    if (!target || target === '--current') throw new Error(`${verb} requires an explicit target`);
    if (verb === 'send' && !rest.length) throw new Error('Use send <target> "message"');
    return verb === 'send' ? [verb, target, rest.join(' ')] : args;
  }
  // Herdr extracts --session globally, even after the subcommand, until --.
  for (const arg of args) {
    if (arg === '--') break;
    if (/^--(?:session|machine|remote|remote-keybindings)(?:=|$)/.test(arg)) {
      throw new Error('Session and machine routing are fixed; put literal option-like payloads after --');
    }
  }
  if (args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0])) return args;
  if (!allowed.has(args[0])) throw new Error('Use pane, agent, workspace, tab, notification, status or api; session routing and maintenance are disabled');
  if (args[0] === 'api' && args.slice(1).some(a => a === '--output' || a.startsWith('--output='))) {
    throw new Error('api schema file output is disabled; use api schema --json');
  }
  if (['pane', 'agent'].includes(args[0]) && inputActions.has(args[1]) &&
      (!args[2] || args[2].startsWith('-'))) throw new Error('Input requires an explicit pane ID or agent name before options');
  return args;
}

export function commandEnvironment({ socket, home, path }, source = process.env, platform = process.platform) {
  const env = { HOME: home, PATH: path, LANG: 'C.UTF-8' };
  if (socket) env.HERDR_SOCKET_PATH = socket;
  // Keep Windows loader/profile variables, but never inherit pane identity or secrets.
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'TEMP', 'TMP']) {
      const actual = Object.keys(source).find(k => k.toLowerCase() === key.toLowerCase());
      if (actual !== undefined) env[key] = source[actual];
    }
  }
  return env;
}

export function createRunner({ binary, socket, home, path, timeoutMs = 25000, outputBytes = 131072, concurrency = 4 }) {
  let active = 0;
  const children = new Set();
  const env = commandEnvironment({ socket, home, path });
  async function run(args, signal, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    if (active >= concurrency) throw new BridgeError('busy');
    if (signal?.aborted) throw new BridgeError('cancelled');
    active++;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(binary, args, { env, cwd: home, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const chunks = { stdout: [], stderr: [] };
        let remaining = outputBytes, timedOut = false, truncated = false, cancelled = false, killTimer;
        const terminate = () => {
          // Node supports these on Windows too, where either signal forcibly terminates the child.
          child.kill('SIGTERM');
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
        };
        const timer = setTimeout(() => { timedOut = true; terminate(); }, callTimeoutMs);
        const abort = () => { cancelled = true; terminate(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        for (const stream of ['stdout', 'stderr']) {
          child[stream].on('data', data => {
            const size = Math.min(remaining, data.length);
            if (size) chunks[stream].push(data.subarray(0, size));
            remaining -= size;
            if (size < data.length) truncated = true;
          });
        }
        child.once('error', reject);
        child.once('close', (code, exitSignal) => {
          clearTimeout(timer); clearTimeout(killTimer);
          signal?.removeEventListener('abort', abort);
          children.delete(child);
          resolve({ exit_code: code, signal: exitSignal, stdout: Buffer.concat(chunks.stdout).toString('utf8'),
            stderr: Buffer.concat(chunks.stderr).toString('utf8'), timed_out: timedOut, truncated, cancelled });
        });
      });
    } finally { active--; }
  }
  return { run, stop: () => { for (const child of children) child.kill('SIGKILL'); } };
}

export const DEFAULT_WAIT_MAX_MS = 90000;

// Only read-only waits get the extended budget. A send --wait can have side effects.
export function prepareWait(args, waitMaxMs = DEFAULT_WAIT_MAX_MS) {
  const waiting = (args[0] === 'agent' && args[1] === 'wait') ||
    (args[0] === 'pane' && args[1] === 'wait-output');
  if (!waiting || args.includes('--help') || args.includes('-h')) return null;
  if (!args[2] || args[2].startsWith('-')) throw new BridgeError('invalid_arguments', 'Put an explicit pane ID or agent name before the wait options.');
  const bounded = args.slice(0, 3);
  let duration = waitMaxMs, seen = false;
  for (let i = 3; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { bounded.push(...args.slice(i)); break; }
    if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const value = arg === '--timeout' ? args[++i] : arg.slice('--timeout='.length);
      if (seen || !/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new BridgeError('invalid_arguments', 'Use --timeout once with a non-negative safe integer in milliseconds.');
      }
      seen = true;
      duration = Math.min(Number(value), duration);
    } else bounded.push(arg);
  }
  const end = bounded.indexOf('--');
  bounded.splice(end < 0 ? bounded.length : end, 0, '--timeout', String(duration));
  return { args: bounded, target: args[2], timeout_ms: duration };
}

export async function executeCommand(runner, args, signal, waitMaxMs = DEFAULT_WAIT_MAX_MS) {
  const started = performance.now();
  if (args.length === 1 && args[0] === 'list') {
    return { ...await readDirectory(runner, signal), elapsed_ms: Math.round(performance.now() - started) };
  }
  let wait, result;
  try {
    const prepared = await prepareFriendly(runner, args, signal, waitMaxMs);
    if (prepared.result) return { ...prepared.result, elapsed_ms: Math.round(performance.now() - started) };
    if (prepared.args !== args) {
      try { args = normalize({ args: prepared.args }); }
      catch (error) { throw new BridgeError('invalid_arguments', error.message); }
    }
    wait = prepareWait(args, waitMaxMs);
    // Let the CLI return its own timeout before the watchdog kills the process.
    result = commandResult(await runner.run(wait?.args ?? args, signal, wait ? { timeoutMs: wait.timeout_ms + 2000 } : {}));
  } catch (error) { result = exceptionResult(error); }
  if (wait) {
    result = { ...result, wait_timeout_ms: wait.timeout_ms };
    if (result.code === 'timeout') {
      const detail = failure('wait_timeout');
      result = { ...result, ...detail, stderr: detail.message, state: 'unknown' };
      // A timed-out wait is not evidence of working. Ask Herdr for current state.
      let probe;
      try {
        probe = commandResult(await runner.run(['agent', 'get', wait.target], signal, { timeoutMs: 2000 }));
      } catch (error) { probe = exceptionResult(error); }
      if (probe.code === 'ok') {
        try {
          const state = JSON.parse(probe.stdout)?.result?.agent?.agent_status;
          if (['idle', 'working', 'blocked', 'done', 'unknown'].includes(state)) result.state = state;
          else result.state_error = failure('bridge_error');
        } catch { result.state_error = failure('bridge_error'); }
      } else result.state_error = { code: probe.code, message: probe.message, next: probe.next };
    }
  }
  return { ...result, elapsed_ms: Math.round(performance.now() - started) };
}
