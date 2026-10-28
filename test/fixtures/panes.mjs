export const ok = { exit_code: 0, signal: null, stdout: '', stderr: '', timed_out: false, truncated: false, cancelled: false };

export function snapshot() {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'work' }, { workspace_id: 'w2', label: 'work' }],
    tabs: [
      { tab_id: 'w1:t1', workspace_id: 'w1', label: 'MCP bridge' },
      { tab_id: 'w2:t1', workspace_id: 'w2', label: 'MCP bridge' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_title_stripped: 'Pi - bridge', agent_status: 'working', cwd: '/project' },
      { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', terminal_title_stripped: 'shell', agent_status: 'unknown' },
    ],
    agents: [{ pane_id: 'w1:p1', agent: 'pi', name: 'reviewer', agent_status: 'working', state_change_seq: 1 }],
  };
}

export function snapshotResult(value) {
  return { ...ok, stdout: JSON.stringify({ result: { type: 'session_snapshot', snapshot: value } }) };
}
