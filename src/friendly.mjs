import { setTimeout as delay } from 'node:timers/promises';
import { readDirectory } from './directory.mjs';
import { BridgeError, commandResult, failure } from './errors.mjs';
import { readReply } from './reply.mjs';

export const FRIENDLY_VERBS = ['list', 'send', 'read', 'wait', 'reply'];

export function resolveTarget(panes, target) {
  const byId = panes.find(pane => pane.pane_id === target);
  if (byId) return byId;
  const labels = pane => [pane.name, pane.tab_label, pane.workspace_label, pane.terminal_title, pane.tab_id];
  let matches = panes.filter(pane => labels(pane).includes(target));
  if (!matches.length) matches = panes.filter(pane => labels(pane).some(label =>
    typeof label === 'string' && label.toLowerCase() === target.toLowerCase()));
  if (!matches.length) throw new BridgeError('pane_not_found');
  if (matches.length > 1) throw new BridgeError('ambiguous_target',
    `Choose a pane_id: ${matches.slice(0, 12).map(pane => pane.pane_id).join(', ')}${matches.length > 12 ? '. More matches are in list.' : '.'}`);
  return matches[0];
}

async function shellState(runner, paneId, signal) {
  const result = commandResult(await runner.run(['pane', 'process-info', '--pane', paneId], signal, { timeoutMs: 2000 }));
  if (result.code !== 'ok') return { result };
  let info;
  try { info = JSON.parse(result.stdout)?.result?.process_info; } catch { /* Invalid metadata is not an idle shell. */ }
  if (!info || info.pane_id !== paneId || !Number.isInteger(info.shell_pid) ||
      !Array.isArray(info.foreground_processes)) throw new BridgeError('bridge_error', 'The shell foreground process could not be identified. Inspect the pane before sending input.');
  return { idle: info.foreground_processes.length === 1 && info.foreground_processes[0].pid === info.shell_pid };
}

async function waitForShell(runner, pane, options, signal, waitMaxMs) {
  let timeout = waitMaxMs, seen = false;
  for (let i = 0; i < options.length; i++) {
    const flag = options[i];
    const value = flag === '--timeout' ? options[++i] : flag.startsWith('--timeout=') ? flag.slice(10) : undefined;
    if (value === undefined || seen || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new BridgeError('invalid_arguments', 'Use wait <target> with an optional --timeout in milliseconds.');
    }
    seen = true; timeout = Math.min(timeout, Number(value));
  }
  const deadline = performance.now() + timeout;
  while (true) {
    const state = await shellState(runner, pane.pane_id, signal);
    if (state.result) return state.result;
    if (state.idle) return { code: 'ok', exit_code: 0, stdout: '', stderr: '', pane_id: pane.pane_id, state: 'idle', wait_timeout_ms: timeout };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...failure('wait_timeout'), pane_id: pane.pane_id, state: 'working', wait_timeout_ms: timeout };
    try { await delay(Math.min(250, remaining), undefined, { signal }); }
    catch { throw new BridgeError('cancelled'); }
  }
}

export async function prepareFriendly(runner, args, signal, waitMaxMs) {
  const [verb, target, ...options] = args;
  if (!FRIENDLY_VERBS.includes(verb)) return { args };
  const directory = await readDirectory(runner, signal);
  if (directory.code !== 'ok') return { result: directory };
  const pane = resolveTarget(JSON.parse(directory.stdout).panes, target);
  switch (verb) {
    case 'send': {
      if (pane.agent) return { args: ['agent', 'prompt', pane.pane_id, options[0]] };
      const state = await shellState(runner, pane.pane_id, signal);
      if (state.result) return state;
      if (!state.idle) throw new BridgeError('target_busy');
      return { args: ['pane', 'run', pane.pane_id, options[0]] };
    }
    case 'read':
      return { args: ['pane', 'read', pane.pane_id, ...options,
        ...(!options.some(option => option === '--source' || option.startsWith('--source=')) ? ['--source', 'recent-unwrapped'] : [])] };
    case 'reply':
      return { result: await readReply(runner, pane, options, signal) };
    case 'wait':
      if (options.some(option => /^(--match|--regex)(=|$)/.test(option))) {
        return { args: ['pane', 'wait-output', pane.pane_id, ...options] };
      }
      return pane.agent ? { args: ['agent', 'wait', pane.pane_id, ...options] }
        : { result: await waitForShell(runner, pane, options, signal, waitMaxMs) };
    default: throw new BridgeError('invalid_arguments');
  }
}
