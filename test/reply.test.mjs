import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestReply, readReply } from '../src/reply.mjs';
import { ok } from './fixtures/panes.mjs';

const header = { type: 'session', version: 3, id: 'session-id', cwd: '/project' };
const message = (id, parentId, role, content, stopReason = 'stop') => ({
  type: 'message', id, parentId, timestamp: '2026-10-28T00:00:00Z', message: { role, content, stopReason },
});
const text = value => [{ type: 'text', text: value }];

async function session(t, entries, partial = '') {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-mcp-reply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, [header, ...entries].map(entry => JSON.stringify(entry) + '\n').join('') + partial);
  return path;
}

test('reply follows the persisted parent chain and excludes reasoning, tools and abandoned branches', async t => {
  const path = await session(t, [
    message('u1', null, 'user', text('question')),
    message('a1', 'u1', 'assistant', [{ type: 'thinking', thinking: 'private' }, ...text('Answer without terminal wrapping.')]),
    message('other', 'u1', 'assistant', text('abandoned answer')),
    message('u2', 'a1', 'user', text('next question')),
    message('tool', 'u2', 'assistant', [{ type: 'toolCall', name: 'bash', arguments: { command: 'private' } }], 'toolUse'),
    message('aborted', 'tool', 'assistant', text('unfinished text'), 'aborted'),
  ], '{"type":"message","unfinished":');
  const reply = await latestReply(path);
  assert.equal(reply.text, 'Answer without terminal wrapping.');
  assert.equal(reply.message_id, 'a1');
  assert.equal(reply.newer_activity, true);
  assert.doesNotMatch(JSON.stringify(reply), /private|abandoned|unfinished/);
});

test('reply does not invent history for missing parents, bad files, unsupported formats or no completed answer', async t => {
  for (const entries of [
    [],
    [message('u1', null, 'user', text('question'))],
    [message('u2', 'missing-parent', 'user', text('question'))],
    [message('a1', null, 'assistant', text('cut off'), 'length')],
    [{ type: 'message', id: 'bad', message: {} }],
  ]) await assert.rejects(latestReply(await session(t, entries)), { code: 'reply_unavailable' });
  const path = await session(t, []);
  await writeFile(path, '{"type":"session","version":2,"id":"old"}\n');
  await assert.rejects(latestReply(path), { code: 'reply_unavailable' });
  await writeFile(path, JSON.stringify(header) + '\nnot json\n');
  await assert.rejects(latestReply(path), { code: 'reply_unavailable' });
});

test('reply paging preserves Unicode and marks newer activity without misreporting it as completion', async t => {
  const original = 'A😀B\n' + 'wide content '.repeat(6000);
  const path = await session(t, [message('a1', null, 'assistant', text(original))]);
  const runner = { async run(args) {
    assert.deepEqual(args, ['agent', 'get', 'w1:p1']);
    return { ...ok, stdout: JSON.stringify({ result: { agent: {
      pane_id: 'w1:p1', agent: 'pi', agent_status: 'working',
      agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: path },
    } } }) };
  } };
  const pane = { pane_id: 'w1:p1', agent: 'pi' };
  const first = await readReply(runner, pane, ['--limit', '2']);
  assert.equal(first.stdout, 'A😀'); assert.equal(first.next_offset, 2);
  assert.equal(first.agent_status, 'working'); assert.equal(first.branch, 'last_persisted');
  const second = await readReply(runner, pane, ['--offset=2', '--limit=2', '--message-id', first.message_id]);
  assert.equal(second.stdout, 'B\n');
  let received = '', offset = 0;
  do {
    const part = await readReply(runner, pane, ['--offset', String(offset)]);
    assert.ok(Buffer.byteLength(part.stdout) <= 120000);
    received += part.stdout; offset = part.next_offset;
  } while (offset !== null);
  assert.equal(received, original);
  await assert.rejects(readReply(runner, pane, ['--message-id', 'another']), { code: 'reply_unavailable' });
  await assert.rejects(readReply(runner, pane, ['--limit', '50000']), { code: 'invalid_arguments' });
});

test('reply requires the live target session identity and honours cancellation', async t => {
  const path = await session(t, [message('a1', null, 'assistant', text('answer'))]);
  for (const agent of [undefined, { pane_id: 'w2:p1', agent: 'pi' },
    { pane_id: 'w1:p1', agent: 'pi', agent_session: { agent: 'pi', kind: 'id', value: path } },
    { pane_id: 'w1:p1', agent: 'pi', agent_session: { agent: 'pi', kind: 'path', value: 'relative.jsonl' } }]) {
    await assert.rejects(readReply({ async run() { return { ...ok, stdout: JSON.stringify({ result: { agent } }) }; } },
      { pane_id: 'w1:p1', agent: 'pi' }, []), { code: 'reply_unavailable' });
  }
  await assert.rejects(latestReply(path, AbortSignal.abort()), { code: 'cancelled' });
});

test('an oversized session record fails within the read budget instead of returning a partial reply', async t => {
  const path = await session(t, [message('a1', null, 'assistant', text('x'.repeat(4 * 1024 * 1024)))]);
  await assert.rejects(latestReply(path), error => error.code === 'reply_unavailable' && /4 MiB/.test(error.next));
});
