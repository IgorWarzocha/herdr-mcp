import { open } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';
import { BridgeError, commandResult } from './errors.mjs';

const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function unavailable(next) { return new BridgeError('reply_unavailable', next); }
function checkSignal(signal) { if (signal?.aborted) throw new BridgeError('cancelled'); }

// Snapshot the file size, ignore an unfinished append, and never load an entire
// conversation. Parent links, not chronological order, determine the branch.
async function* reverseRecords(file, size, signal) {
  let position = size, pending = Buffer.alloc(0), trailing = true, scanned = 0;
  while (position > 0) {
    checkSignal(signal);
    const length = Math.min(65536, position);
    if ((scanned += length) > MAX_SCAN_BYTES) throw unavailable('The persisted branch exceeds the 16 MiB reply scan budget. Read the pane instead.');
    position -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await file.read(chunk, 0, length, position);
    if (bytesRead !== length) throw unavailable('The session changed while reading. Retry the reply read.');
    const data = Buffer.concat([chunk, pending]);
    let end = data.length;
    for (let newline = data.lastIndexOf(10, end - 1); newline >= 0; newline = data.lastIndexOf(10, end - 1)) {
      const line = data.subarray(newline + 1, end);
      if (line.length > MAX_LINE_BYTES) throw unavailable('A session record exceeds the 4 MiB reply limit. Read the pane instead.');
      if (trailing) trailing = false;
      else if (line.length) yield JSON.parse(line.toString('utf8'));
      end = newline;
      if (end === 0) break;
    }
    pending = Buffer.from(data.subarray(0, end));
    if (pending.length > MAX_LINE_BYTES) throw unavailable('A session record exceeds the 4 MiB reply limit. Read the pane instead.');
  }
  if (!trailing && pending.length) yield JSON.parse(pending.toString('utf8'));
}

export async function latestReply(path, signal) {
  let file;
  try {
    checkSignal(signal);
    file = await open(path, 'r');
    const before = await file.stat();
    if (!before.isFile()) throw unavailable('The reported Pi session is not a regular file.');
    const headerBytes = Buffer.alloc(Math.min(before.size, 65536));
    await file.read(headerBytes, 0, headerBytes.length, 0);
    const newline = headerBytes.indexOf(10);
    if (newline < 0) throw unavailable('Pi has not persisted a complete session header yet. Retry after a reply.');
    const header = JSON.parse(headerBytes.subarray(0, newline).toString('utf8'));
    if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string') {
      throw unavailable('The reported file is not a current Pi session.');
    }
    let expected, newerActivity = false;
    for await (const entry of reverseRecords(file, before.size, signal)) {
      if (entry.type === 'session') break;
      if (typeof entry.id !== 'string' || !(entry.parentId === null || typeof entry.parentId === 'string')) {
        throw unavailable('The Pi session contains an invalid record. No reply was guessed.');
      }
      expected ??= entry.id;
      if (entry.id !== expected) continue;
      const message = entry.type === 'message' ? entry.message : undefined;
      if (message?.role === 'assistant' && message.stopReason === 'stop') {
        if (!Array.isArray(message.content)) throw unavailable('The Pi reply has an unreadable content format.');
        const text = message.content.filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('\n');
        if (text.trim()) {
          const after = await file.stat();
          if (after.size < before.size || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
            throw unavailable('The session changed while reading. Retry the reply read.');
          }
          checkSignal(signal);
          return { text, message_id: entry.id, timestamp: entry.timestamp, newer_activity: newerActivity };
        }
      }
      if (message && ['user', 'assistant'].includes(message.role)) newerActivity = true;
      expected = entry.parentId;
      if (expected === null) throw unavailable('No completed assistant reply exists on the last persisted branch yet.');
    }
    throw unavailable(expected ? 'The Pi session has an incomplete parent chain. No reply was guessed.'
      : 'Pi has not persisted a completed assistant reply yet.');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw unavailable('The reported Pi session could not be read. Check the target and retry after Pi saves a reply.');
  } finally { await file?.close(); }
}

function replyOptions(options) {
  const result = { offset: 0, limit: 16000, messageId: undefined };
  const seen = new Set();
  for (let i = 0; i < options.length; i++) {
    const [flag, inline] = options[i].split(/=(.*)/s, 2);
    const value = inline ?? options[++i];
    if (!['--offset', '--limit', '--message-id'].includes(flag) || seen.has(flag) || !value) {
      throw new BridgeError('invalid_arguments', 'Use reply <target> with optional --offset, --limit or --message-id.');
    }
    seen.add(flag);
    if (flag === '--message-id') { result.messageId = value; continue; }
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
        (flag === '--limit' && (Number(value) < 1 || Number(value) > 30000))) {
      throw new BridgeError('invalid_arguments', 'Use a non-negative character offset and a limit from 1 to 30000.');
    }
    result[flag.slice(2)] = Number(value);
  }
  return result;
}

export async function readReply(runner, pane, options, signal) {
  if (pane.agent !== 'pi') throw unavailable('Clean replies are available for Pi panes.');
  const response = commandResult(await runner.run(['agent', 'get', pane.pane_id], signal));
  if (response.code !== 'ok') return response;
  let agent;
  try { agent = JSON.parse(response.stdout)?.result?.agent; } catch { /* No guessed path. */ }
  const session = agent?.agent_session;
  if (agent?.pane_id !== pane.pane_id || agent.agent !== 'pi' || session?.agent !== 'pi' || session.kind !== 'path' ||
      typeof session.value !== 'string' || !isAbsolute(session.value) || extname(session.value) !== '.jsonl') {
    throw unavailable('Herdr has not reported a Pi session path for this pane. No session was guessed from its working directory.');
  }
  return readSessionReply(session.value, pane, options, signal, agent.agent_status);
}

// Both runtimes must report an exact current session path. Never discover one
// by scanning a working directory or choosing the newest conversation file.
export async function readSessionReply(path, pane, options, signal, status) {
  const { offset, limit, messageId } = replyOptions(options);
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path) !== '.jsonl') {
    throw unavailable('The target has not reported an absolute Pi session file path. Read the terminal instead.');
  }
  const reply = await latestReply(path, signal);
  if (messageId && messageId !== reply.message_id) throw unavailable('The latest reply changed. Read again from offset 0.');
  const characters = Array.from(reply.text);
  if (offset > characters.length) throw new BridgeError('invalid_arguments', 'The offset is past the end of this reply. Read again from offset 0.');
  const next = Math.min(offset + limit, characters.length);
  return {
    code: 'ok', exit_code: 0, stdout: characters.slice(offset, next).join(''), stderr: '',
    pane_id: pane.pane_id, source: 'pi_session', branch: 'last_persisted', agent_status: status,
    message_id: reply.message_id, timestamp: reply.timestamp, newer_activity: reply.newer_activity,
    offset, next_offset: next < characters.length ? next : null, total_characters: characters.length,
    truncated: next < characters.length,
  };
}
