import { readFile } from 'node:fs/promises';
import { BridgeError } from './errors.mjs';

let readerSource;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

// Run the same bounded, branch-aware reader beside the reported session file.
// Nothing is installed remotely and a remote path is never opened on this host.
async function source() {
  const [reader, errors] = await Promise.all([
    readFile(new URL('./reply.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./errors.mjs', import.meta.url), 'utf8'),
  ]);
  const errorUrl = moduleUrl(errors);
  const readerUrl = moduleUrl(reader.replace("'./errors.mjs'", JSON.stringify(errorUrl)));
  return `import {readSessionReply} from ${JSON.stringify(readerUrl)};
import {exceptionResult} from ${JSON.stringify(errorUrl)};
const [path,pane,options,status]=JSON.parse(process.argv[1]);
try { console.log(JSON.stringify(await readSessionReply(path,pane,options,undefined,status,90000))); }
catch (error) { console.log(JSON.stringify(exceptionResult(error))); }`;
}

export async function readRemoteSessionReply(call, pane, path, options, signal, status) {
  const program = await (readerSource ??= source());
  const result = await call(['exec', '--on', pane.machine_id, '--timeout', '20', '--',
    'node', '--input-type=module', '-e', program, JSON.stringify([path, pane, options, status])], signal);
  if (result.code !== 'ok') return result;
  let execution;
  try { execution = JSON.parse(result.stdout); } catch { throw new BridgeError('bridge_error'); }
  if (execution.timed_out) throw new BridgeError('timeout');
  if (execution.truncated) throw new BridgeError('truncated');
  if (execution.code !== 0 || typeof execution.stdout !== 'string') throw new BridgeError('reply_unavailable',
    'The remote Pi session reader could not run. Check that Node.js is available on the selected machine.');
  let reply;
  try { reply = JSON.parse(Buffer.from(execution.stdout, 'base64').toString('utf8')); }
  catch { throw new BridgeError('bridge_error'); }
  if (reply.code !== 'ok') throw new BridgeError(['reply_unavailable', 'invalid_arguments', 'cancelled'].includes(reply.code)
    ? reply.code : 'bridge_error', reply.next);
  if (reply.pane_id !== pane.pane_id || typeof reply.stdout !== 'string' || reply.source !== 'pi_session') throw new BridgeError('bridge_error');
  return reply;
}
