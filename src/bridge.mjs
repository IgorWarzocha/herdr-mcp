import { spawn } from 'node:child_process';

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
    args = ['agent', 'list'];
  } else if (['send', 'read', 'wait'].includes(verb)) {
    if (!target || target.startsWith('-')) throw new Error(`${verb} requires an explicit pane ID or agent name`);
    if (verb === 'send' && rest.length !== 1) throw new Error('Use send <target> "message"');
    args = verb === 'send' ? ['agent', 'prompt', target, '--', ...rest] :
      verb === 'read' ? [/^w[^:]+:p[^:]+$/.test(target) ? 'pane' : 'agent', 'read', target, ...rest] :
        ['agent', 'wait', target, ...rest];
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
  async function run(args, signal) {
    if (active >= concurrency) throw new Error('Bridge busy; no command was started. Retry after an active call finishes');
    if (signal?.aborted) throw new Error('Call cancelled before execution');
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
        const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
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

export const adaptation = `MCP bridge instructions (override local-shell assumptions in the upstream skill below):
You are an external client, not a Herdr pane. Do not check or set HERDR_ENV. Use herdr_skill for this guide and herdr for commands; no local shell is required. The bridge pins the server socket and supplies no caller pane identity. Always use explicit targets; never rely on --current or UI focus. Do not close panes you did not create without permission, especially swarm leaders.
herdr accepts exactly one of args (string array) or command (quote-only string, no expansion). Empty args prints help. Friendly verbs: list (agents), read <pane-or-agent>, send <agent-or-pane> "message" (agent prompt, submits Enter), wait <agent-or-pane> (agent state). Raw pane/agent/workspace/tab/notification/status/api commands remain available. Session/machine selection, maintenance, bare TUI and schema file output are disabled. Use raw pane list for all terminals; raw pane run for shell input. No friendly quit: graceful Pi shutdown needs Shepherdr's semantic channel.
All calls have a 25-second hard limit, 128 KiB combined output, and four concurrent subprocesses. Use --timeout 20000 or less on waits. Timeout/cancellation is not rollback; inspect before retrying input. Truncated output requires narrower reads with --lines/source; this bridge stores no transcript. send acknowledges input, not a reply. Read afterwards; waits track state rather than individual turns and wait-output can match old text. No push inbox or durable notifications. Remote shell/file-reading examples in the upstream skill are not additional MCP capabilities.
`;
