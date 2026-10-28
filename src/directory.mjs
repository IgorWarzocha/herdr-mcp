import { commandResult, exceptionResult, failure } from './errors.mjs';

export const PANES_URI = 'herdr://panes';

// Preserve every identity. The friendly command boundary resolves labels only
// when they identify one pane; discovery never collapses duplicate labels.
export function projectDirectory(snapshot) {
  if (!snapshot || !['panes', 'tabs', 'workspaces', 'agents'].every(key => Array.isArray(snapshot[key]))) {
    throw new Error('Invalid Herdr snapshot');
  }
  const index = (rows, key) => {
    const entries = rows.map(row => {
      if (!row || typeof row[key] !== 'string') throw new Error('Invalid Herdr identity');
      return [row[key], row];
    });
    const map = new Map(entries);
    if (map.size !== rows.length) throw new Error('Duplicate Herdr identity');
    return map;
  };
  const workspaces = index(snapshot.workspaces, 'workspace_id');
  const tabs = index(snapshot.tabs, 'tab_id');
  const agents = index(snapshot.agents, 'pane_id');
  return [...index(snapshot.panes, 'pane_id').values()].map(pane => {
    const workspace = workspaces.get(pane.workspace_id), tab = tabs.get(pane.tab_id);
    if (!workspace || !tab || tab.workspace_id !== pane.workspace_id) throw new Error('Inconsistent Herdr identity');
    const agent = agents.get(pane.pane_id);
    return {
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id, workspace_label: workspace.label ?? null,
      tab_id: pane.tab_id, tab_label: tab.label ?? null,
      name: agent?.name ?? pane.name ?? null,
      terminal_title: pane.terminal_title_stripped ?? agent?.terminal_title_stripped ?? null,
      agent: agent?.agent ?? pane.agent ?? null,
      agent_status: agent?.agent_status ?? pane.agent_status ?? 'unknown',
      state_change_seq: agent?.state_change_seq ?? null,
      completion_seq: agent?.completion_seq ?? null,
      cwd: pane.foreground_cwd ?? pane.cwd ?? null,
    };
  }).sort((a, b) => a.pane_id.localeCompare(b.pane_id));
}

export async function readDirectory(runner, signal) {
  let result;
  try { result = commandResult(await runner.run(['api', 'snapshot'], signal)); }
  catch (error) { return exceptionResult(error); }
  const oversized = () => ({ ...result, stdout: '', truncated: true, ...failure('truncated',
    'The pane directory exceeded the bridge output limit. Use raw pane list, tab list and workspace list separately. No partial directory is used for targeting.') });
  if (result.code === 'truncated') return oversized();
  if (result.code !== 'ok') return { ...result, stdout: '' };
  try {
    const panes = projectDirectory(JSON.parse(result.stdout)?.result?.snapshot);
    const stdout = JSON.stringify({ panes });
    if (Buffer.byteLength(stdout) > 131072) return oversized();
    return { ...result, stdout };
  } catch {
    const detail = failure('bridge_error', 'Herdr returned an unreadable pane directory. Check api snapshot locally. No names or targets were guessed.');
    return { ...result, stdout: '', stderr: detail.message, ...detail };
  }
}

export function directoryText(result) {
  return JSON.stringify(result.code === 'ok'
    ? { code: 'ok', ...JSON.parse(result.stdout) }
    : { code: result.code, message: result.message, next: result.next });
}
