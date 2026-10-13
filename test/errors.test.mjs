import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, commandResult, exceptionResult, toolResult } from '../src/errors.mjs';

const ok = { exit_code: 0, signal: null, stdout: 'output', stderr: '', timed_out: false, truncated: false, cancelled: false };

test('CLI error codes become bounded recovery advice without diagnostic dumps', () => {
  // ErrorResponse shape and codes verified in Herdr cli.rs and api/schema.
  for (const [upstream, code] of [
    ['server_not_running', 'herdr_not_running'], ['pane_not_found', 'pane_not_found'],
    ['agent_not_found', 'pane_not_found'], ['session_not_found', 'session_missing'],
    ['timeout', 'timeout'], ['unrecognised_failure', 'command_failed'],
  ]) {
    const result = commandResult({ ...ok, exit_code: 1, stdout: 'stack backtrace: private',
      stderr: JSON.stringify({ id: 'cli:test', error: { code: upstream, message: 'sensitive detail' } }) + '\nstack backtrace: private' });
    assert.equal(result.code, code);
    assert.equal(result.exit_code, 1);
    assert.ok(result.next.length > 0);
    assert.equal(toolResult(result).isError, true);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|private|backtrace/);
  }
  assert.equal(commandResult({ ...ok, exit_code: 2, stderr: 'usage dump' }).code, 'invalid_arguments');
  assert.equal(commandResult({ ...ok, exit_code: 1, stderr: 'unknown stack\n at somewhere' }).code, 'command_failed');
});

test('successful terminal content is not mistaken for bridge failure and truncation is explicit', () => {
  const text = JSON.stringify({ error: { code: 'server_not_running' } });
  const result = commandResult({ ...ok, stdout: text, stderr: text });
  assert.equal(result.code, 'ok');
  assert.equal(result.stdout, text);
  assert.equal(result.stderr, text);
  assert.equal(toolResult(result).isError, false);
  const partial = commandResult({ ...ok, truncated: true });
  assert.equal(partial.code, 'truncated');
  assert.equal(partial.stdout, 'output');
  assert.match(partial.next, /--lines/);
  assert.equal(toolResult(partial).isError, true);
  assert.equal(commandResult({ ...ok, exit_code: null, timed_out: true, truncated: true }).code, 'timeout');
  assert.equal(commandResult({ ...ok, exit_code: null, cancelled: true }).code, 'cancelled');
});

test('exceptions do not leak messages and retain actionable start/busy/cancel outcomes', () => {
  for (const code of ['busy', 'cancelled']) assert.equal(exceptionResult(new BridgeError(code)).code, code);
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']) {
    assert.equal(exceptionResult(Object.assign(new Error('private'), {code})).code, 'herdr_unavailable');
  }
  const unknown = exceptionResult(new Error('private stack trace'));
  assert.equal(unknown.code, 'bridge_error');
  assert.doesNotMatch(JSON.stringify(unknown), /private|stack/);
});
