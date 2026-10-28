// The bridge owns recovery advice. Never forward exception messages or CLI diagnostics.
const advice = {
  herdr_not_running: ['Herdr cannot be reached.', 'Ask the user to start Herdr or check the pinned HERDR_MCP_SOCKET in the bridge environment.'],
  session_missing: ['The selected session is missing.', 'Ask the user to restore the intended session or correct the bridge socket. Session switching is disabled here.'],
  pane_not_found: ['The pane or agent was not found.', 'Run list, match workspace_label, tab_label, name and terminal_title, then use the pane_id. Display labels are not agent names. Ask the user if the target is absent or ambiguous.'],
  agent_not_idle: ['Herdr cannot capture the requested agent history while the agent is working.', 'Read the same target with --source visible for the current screen, or wait until idle and retry the history read. Visible output is not the full transcript.'],
  bad_token: ['Bearer token missing or rejected.', 'Ask the user to copy the existing token into the client Authorization: Bearer header. Do not rotate it or paste it into chat.'],
  timeout: ['The command timed out.', 'Read the target before retrying input. A timeout does not undo input.'],
  wait_timeout: ['The wait ended before its condition matched.', 'If looking for a reply, read the target with --source visible even while working; an answer may already be on screen. If the result is still needed, repeat the wait with the same target, condition and timeout. Read output on idle, done or blocked. Unknown state needs inspection, not an assumption of completion. Do not resend the prompt.'],
  truncated: ['Output exceeded the bridge limit.', 'Read again with fewer --lines or a narrower source. Do not repeat input commands to recover output. No full transcript is stored.'],
  invalid_arguments: ['The command arguments are invalid or disallowed.', 'Check the subcommand, flags and required values with herdr_skill or subcommand --help, then correct the call.'],
  busy: ['The bridge is busy. No command was started.', 'Wait for an active call to finish, then retry.'],
  cancelled: ['The call was cancelled.', 'Read the target before retrying input. Cancellation does not undo input.'],
  herdr_unavailable: ['The Herdr executable could not be started.', 'Ask the user to check HERDR_MCP_BINARY, the service PATH and executable permissions, then run doctor.'],
  command_failed: ['Herdr rejected or failed the command.', 'Check subcommand --help and read the target before retrying input. If it persists, ask the user to run the command locally for diagnostics.'],
  bridge_error: ['The bridge could not complete the request.', 'Read the target before retrying input. If it persists, ask the user to check the bridge with doctor.'],
};

export function failure(code, next) {
  const [message, defaultNext] = advice[code];
  return { code, message, next: next ?? defaultNext };
}

export class BridgeError extends Error {
  constructor(code, next) {
    super(advice[code][0]);
    this.code = code;
    this.next = next;
  }
}

export function exceptionResult(error) {
  if (error instanceof BridgeError) return failure(error.code, error.next);
  if (['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM'].includes(error?.code)) return failure('herdr_unavailable');
  return failure('bridge_error');
}

const upstreamCodes = {
  server_not_running: 'herdr_not_running',
  session_not_found: 'session_missing',
  session_missing: 'session_missing',
  pane_not_found: 'pane_not_found',
  agent_not_found: 'pane_not_found',
  agent_not_idle: 'agent_not_idle',
  timeout: 'timeout',
};

function cliFailure(result) {
  // Herdr emits JSON ErrorResponse on stderr. Never classify successful pane text.
  for (const line of result.stderr.split('\n')) {
    try {
      const code = JSON.parse(line)?.error?.code;
      if (Object.hasOwn(upstreamCodes, code)) return upstreamCodes[code];
    } catch { /* Plain CLI diagnostics use the generic failure below. */ }
  }
  return result.exit_code === 2 ? 'invalid_arguments' : 'command_failed';
}

export function commandResult(result) {
  const code = result.cancelled ? 'cancelled' : result.timed_out ? 'timeout' :
    result.exit_code !== 0 ? cliFailure(result) : result.truncated ? 'truncated' : 'ok';
  if (code === 'ok') return { ...result, code };
  const detail = failure(code);
  // Keep bounded partial output for successful truncation, not failure dumps/backtraces.
  return { ...result, stdout: code === 'truncated' ? result.stdout : '', stderr: detail.message, ...detail };
}

export function toolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !['ok', 'wait_timeout'].includes(result.code) };
}
