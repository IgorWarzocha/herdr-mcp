import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryText, projectDirectory, readDirectory } from '../src/directory.mjs';
import { executeCommand, normalize } from '../src/bridge.mjs';
import { ok, snapshot, snapshotResult } from './fixtures/panes.mjs';

test('directory pairs UI labels with pane IDs without collapsing duplicate labels or hiding shells', () => {
  const panes = projectDirectory(snapshot());
  assert.deepEqual(panes.map(p => [p.pane_id, p.workspace_label, p.tab_label, p.name, p.terminal_title]), [
    ['w1:p1', 'work', 'MCP bridge', 'reviewer', 'Pi - bridge'],
    ['w2:p1', 'work', 'MCP bridge', null, 'shell'],
  ]);
  assert.equal(panes[0].agent_status, 'working');
  assert.equal(panes[0].state_change_seq, 1);
  assert.equal(panes[1].agent_status, 'unknown');
  const reordered = snapshot();
  reordered.panes.reverse(); reordered.tabs.reverse(); reordered.workspaces.reverse();
  reordered.layouts = [{ meaningless: 'presentation-only' }];
  reordered.panes[0].focused = true;
  assert.deepEqual(projectDirectory(reordered), panes);
});

test('friendly list uses one snapshot, raw lists and explicit targets remain pass-through', async () => {
  const calls = [];
  const runner = { async run(args) { calls.push(args); return snapshotResult(snapshot()); } };
  const result = await executeCommand(runner, normalize({ args: ['list'] }));
  assert.equal(result.code, 'ok');
  assert.equal(result.exit_code, 0);
  assert.equal(JSON.parse(result.stdout).panes[0].tab_label, 'MCP bridge');
  assert.deepEqual(calls, [['api', 'snapshot']]);
  assert.deepEqual(normalize({ command: 'list' }), ['list']);
  for (const args of [['agent', 'list'], ['pane', 'list'], ['tab', 'list'], ['workspace', 'list']]) {
    assert.deepEqual(normalize({ args }), args);
  }
  assert.deepEqual(normalize({ args: ['read', 'w2:p1', '--source', 'visible'] }), ['read', 'w2:p1', '--source', 'visible']);
});

test('missing, inconsistent and truncated inventories fail explicitly instead of guessing targets', async () => {
  const duplicate = snapshot(); duplicate.panes.push(duplicate.panes[0]);
  const orphan = snapshot(); orphan.tabs[0].workspace_id = 'w2';
  for (const value of [undefined, {}, { ...snapshot(), workspaces: [] }, duplicate, orphan]) {
    const result = await readDirectory({ async run() { return snapshotResult(value); } });
    assert.equal(result.code, 'bridge_error');
    assert.equal(result.stdout, '');
    const document = JSON.parse(directoryText(result));
    assert.equal(document.code, 'bridge_error');
    assert.equal(document.panes, undefined);
  }
  for (const response of [
    { ...ok, truncated: true, stdout: 'private incomplete snapshot' },
    { ...ok, exit_code: 1, stderr: '{"error":{"code":"server_not_running","message":"private diagnostic"}}' },
  ]) {
    const result = await readDirectory({ async run() { return response; } });
    assert.equal(result.code, response.truncated ? 'truncated' : 'herdr_not_running');
    assert.equal(result.stdout, '');
    assert.doesNotMatch(directoryText(result), /private/);
  }
});

test('enriched output remains bounded even when repeated workspace labels amplify the snapshot', async () => {
  const value = snapshot();
  value.workspaces[0].label = 'x'.repeat(10000);
  value.panes = Array.from({ length: 20 }, (_, i) => ({ ...value.panes[0], pane_id: `w1:p${i}` }));
  const result = await readDirectory({ async run() { return snapshotResult(value); } });
  assert.equal(result.code, 'truncated');
  assert.equal(result.stdout, '');
  assert.match(result.next, /No partial directory/);
});
