import { basename, isAbsolute, win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import { executeCommand, normalize } from './bridge.mjs';
import { readDirectory } from './directory.mjs';
import { resolveTarget } from './friendly.mjs';
import { BridgeError, commandResult, exceptionResult, failure } from './errors.mjs';
import { CORE_ID, CORE_ADDRESS, createCoreBackend } from './core.mjs';
import { LOCAL_MACHINE } from './core-routing.mjs';

export const RUNTIME_GUIDE = `Control terminals and agents with herdr. Supply args as an array, or command as quoted words.
list
read <target> [--lines N] [--source visible|recent-unwrapped]
send <target> <text>
wait <target> [--timeout ms] [--match text]
reply <target> [--offset N] [--limit N] [--message-id ID]
get <target>
spawn [--name NAME] [--cwd /absolute/path] -- <program> [arguments...]
close <target>
Use a pane_id from list, an agent name or a unique label. Existing targets stay on their owning runtime. New programs prefer Core when installed. Failed mutations are never retried on another runtime. Spawn acknowledges launch, not task completion. Pass startup arguments to the program, then inspect readiness before sending more input. Template launches report first_message.sent when Core handles task delivery.
list includes Core's configured machines and remote terminals. Prefix a command with --machine <name-or-ID> to scope it, for example --machine desktop send worker "review this" or --machine laptop spawn -- pi. Omit it for local names and new programs. Remote pane IDs use core:<machine-ID>/tN and route directly. A machine selector must agree with an explicit pane ID. Slow remote lists can omit terminals; absence does not prove closure.
Sending confirms delivery, not completion. Waits block for at most the configured ceiling; blocked means attention is needed, not success. Unknown status is not completion. Plain programs without reported status may need an output match or exit. Output matches on Core observe new output after the wait begins. Regular expressions are TUI-only.
read returns terminal text, not a full transcript. Incomplete history is marked. reply returns completed Pi text from the exact reported session file on the last persisted branch; it may predate current work. Use next_offset and message_id to continue a long reply.
Core owns machine connections; configure them with hc machine add on the bridge host. Remote reply needs Node.js there. Sessions stay pinned. Raw TUI CLI commands remain local; use subcommand --help for their syntax.`;

const ok = (stdout = '', fields = {}) => ({ code: 'ok', exit_code: 0, stdout, stderr: '', ...fields });

export function spawnSpec(args, remote = false) {
  const spec = { argv: [] };
  let i = 1;
  const seen = new Set();
  while (i < args.length && args[i] !== '--' && args[i].startsWith('-')) {
    const flag = args[i++];
    if (!['--cwd', '--name'].includes(flag) || seen.has(flag) || !args[i] || args[i].startsWith('-')) {
      throw new BridgeError('invalid_arguments', 'Use spawn [--name NAME] [--cwd /absolute/path] -- <program> [arguments...].');
    }
    seen.add(flag); spec[flag.slice(2)] = args[i++];
  }
  if (args[i] === '--') i++;
  spec.argv = args.slice(i);
  if (!spec.argv.length || !spec.argv[0] || spec.argv[0].startsWith('-') ||
      (spec.cwd && !isAbsolute(spec.cwd) && !(remote && win32.isAbsolute(spec.cwd))) || (spec.name && !/^[a-z0-9_-]{1,32}$/.test(spec.name))) {
    throw new BridgeError('invalid_arguments', 'Give a program, an absolute cwd and a name of 1 to 32 lowercase letters, digits, underscores or hyphens.');
  }
  return spec;
}

// These are semantic aliases, not a second implementation of either CLI.
function friendlyArgs(args) {
  if (['pane', 'agent'].includes(args[0])) {
    const verbs = { read: 'read', get: 'get', prompt: 'send', run: 'send', wait: 'wait', 'wait-output': 'wait', close: 'close' };
    if (verbs[args[1]] && args[2]) return [verbs[args[1]], ...args.slice(2)];
    if (args[1] === 'list' && args.length === 2) return ['list'];
    if (args[1] === 'spawn') return ['spawn', ...args.slice(2)];
  }
  return args;
}

async function spawnTui(runner, spec, signal) {
  const kind = basename(spec.argv[0]);
  if (!['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse'].includes(kind) || kind !== spec.argv[0]) {
    throw new BridgeError('invalid_arguments', 'Without Core, spawn needs a supported TUI agent executable such as pi, claude or codex.');
  }
  const name = spec.name ?? `mcp-${randomBytes(6).toString('hex')}`;
  const created = commandResult(await runner.run(['workspace', 'create', '--no-focus', '--label', name,
    ...(spec.cwd ? ['--cwd', spec.cwd] : [])], signal));
  if (created.code !== 'ok') return created;
  let paneId;
  try { paneId = JSON.parse(created.stdout).result.root_pane.pane_id; } catch { /* Never guess the created target. */ }
  if (typeof paneId !== 'string' || !paneId) throw new BridgeError('bridge_error', 'A workspace may have been created, but its pane ID was unreadable. Inspect list before spawning again.');
  let result;
  try {
    result = commandResult(await runner.run(['agent', 'start', name, '--kind', kind, '--pane', paneId,
      '--timeout', '20000', '--', ...spec.argv.slice(1)], signal));
  } catch (error) { result = exceptionResult(error); }
  if (result.code !== 'ok') return { ...result, pane_id: paneId, next: `${result.next} The new pane is ${paneId}; inspect it before retrying.` };
  return ok(JSON.stringify({ pane_id: paneId, name }), { pane_id: paneId });
}

// Owns runtime selection and cross-runtime identity. Adapters own CLI semantics.
// A missing binary is discovered before construction; a failing installed runtime
// remains visible and can never turn a mutation into a fallback on the other one.
export function createRuntimes({ tui, core }) {
  const coreBackend = core ? createCoreBackend(core) : undefined;
  async function directory(signal, machine) {
    const sources = await Promise.all([
      ...(tui && (!machine || machine.id === 'local') ? [readDirectory(tui, signal).then(result => ['tui', result])] : []),
      ...(core ? [coreBackend.directory(signal, machine).then(result => ['core', result])] : []),
    ]);
    const panes = [], unavailable = [], machines = [];
    for (const [runtime, result] of sources) {
      if (result.code !== 'ok') { unavailable.push({ runtime, code: result.code, next: result.next }); continue; }
      const data = JSON.parse(result.stdout);
      if (data.machines) machines.push(...data.machines);
      panes.push(...data.panes.map(pane => runtime === 'tui' ? { ...pane, runtime, machine_id: 'local' } : pane));
    }
    if (!panes.length && unavailable.length) return { ...failure('runtime_unavailable'), unavailable };
    const stdout = JSON.stringify({ panes, machines: machines.length ? machines : [LOCAL_MACHINE], ...(unavailable.length ? { unavailable } : {}) });
    if (Buffer.byteLength(stdout) > 131072) return failure('truncated', 'The merged directory exceeds 128 KiB. No partial list is used for targeting.');
    return ok(stdout);
  }
  async function targetPane(target, signal, machine) {
    if (!target || target.startsWith('-') || (target.startsWith('core:') && !CORE_ADDRESS.test(target.slice('core:'.length)))) throw new BridgeError('invalid_arguments', 'Choose a pane_id or a name on the selected machine from list.');
    // Qualified identities do not need an unavailable unrelated runtime.
    let result;
    if (target.startsWith('core:') || (machine && CORE_ID.test(target))) {
      if (!core) throw new BridgeError('runtime_unavailable');
      // Core retains finished terminals outside the default live list. An
      // explicit address remains readable after exit and needs no name lookup.
      const address = target.startsWith('core:') ? target.slice('core:'.length)
        : machine.id === 'local' ? target : `${machine.id}/${target}`;
      const owner = address.includes('/') ? address.split('/')[0] : 'local';
      if (machine && owner !== machine.id) throw new BridgeError('invalid_arguments', 'The machine selector and pane ID name different machines. No action was sent.');
      return { runtime: 'core', pane: await coreBackend.pane(address, signal) };
    } else if (/^w[^:]+:p\d+$/.test(target)) {
      if (machine && machine.id !== 'local') throw new BridgeError('invalid_arguments', 'TUI pane IDs are local to the bridge.');
      if (!tui) throw new BridgeError('runtime_unavailable');
      result = await readDirectory(tui, signal);
    } else result = await directory(signal, machine ?? LOCAL_MACHINE);
    if (result.code !== 'ok') return { result };
    const inventory = JSON.parse(result.stdout);
    if (inventory.unavailable?.length) throw new BridgeError('runtime_unavailable', 'A runtime is unavailable, so a name might be ambiguous. Choose an explicit pane_id from list.');
    const pane = resolveTarget(inventory.panes, target);
    return { pane, runtime: pane.runtime ?? 'tui' };
  }
  async function execute(inputArgs, signal, waitMaxMs) {
    const started = performance.now();
    try {
      let machine;
      const nativeArgs = inputArgs[0] === '--machine' ? inputArgs.slice(2) : inputArgs;
      if (inputArgs[0] === '--machine') {
        if (!inputArgs[1] || !nativeArgs.length) throw new BridgeError('invalid_arguments');
        if (!core && inputArgs[1] !== 'local') throw new BridgeError('runtime_unavailable');
        machine = core ? await coreBackend.machine(inputArgs[1], signal) : LOCAL_MACHINE;
      }
      const args = friendlyArgs(nativeArgs);
      const [verb, target, ...options] = args;
      let result;
      if (verb === '--skill' || (args.length === 1 && ['--help', '-h'].includes(verb))) result = ok(RUNTIME_GUIDE);
      else if (verb === 'list') {
        if (args.length !== 1) throw new BridgeError('invalid_arguments');
        result = await directory(signal, machine);
      } else if (verb === 'spawn') {
        const spec = spawnSpec(args, machine && machine.id !== 'local');
        result = core ? await coreBackend.spawn(spec, signal, machine) : await spawnTui(tui, spec, signal);
      } else if (['read', 'send', 'wait', 'reply', 'get', 'close'].includes(verb)) {
        if (['get', 'close'].includes(verb) && options.length) throw new BridgeError('invalid_arguments', `${verb} takes only an explicit target.`);
        const resolved = await targetPane(target, signal, machine);
        if (resolved.result) result = resolved.result;
        else if (resolved.runtime === 'core') result = await coreBackend.execute(verb, resolved.pane, options, signal, waitMaxMs);
        else if (args !== nativeArgs && ['pane', 'agent'].includes(nativeArgs[0])) {
          // Raw TUI flags keep their CLI meaning. Re-normalising them as a
          // friendly send would turn --wait into literal prompt text.
          const native = [...nativeArgs]; native[2] = resolved.pane.pane_id;
          result = await executeCommand(tui, normalize({ args: native }), signal, waitMaxMs);
        }
        else if (verb === 'get') result = ok(JSON.stringify({ ...resolved.pane, runtime: 'tui' }),
          { pane_id: resolved.pane.pane_id, state: resolved.pane.agent_status });
        else {
          const translated = verb === 'close' ? ['pane', 'close', resolved.pane.pane_id, ...options]
            : [verb, resolved.pane.pane_id, ...options];
          result = await executeCommand(tui, normalize({ args: translated }), signal, waitMaxMs);
          result = { ...result, pane_id: resolved.pane.pane_id };
        }
      } else {
        if (!tui || (machine && machine.id !== 'local') || args.some(arg => arg.startsWith('core:'))) throw new BridgeError('invalid_arguments', 'Use list, spawn, get, read, send, wait, reply or close for this target.');
        result = await executeCommand(tui, args, signal, waitMaxMs);
      }
      return { ...result, elapsed_ms: Math.round(performance.now() - started) };
    } catch (error) { return { ...exceptionResult(error), elapsed_ms: Math.round(performance.now() - started) }; }
  }
  return { directory, execute, stop() { tui?.stop(); core?.stop(); } };
}
