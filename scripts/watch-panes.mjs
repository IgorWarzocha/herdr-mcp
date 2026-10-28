import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pathToFileURL } from 'node:url';

const uri = 'herdr://panes';

// A receiving client, not a model scheduler. Fail visibly on disconnect so a
// caller can choose its reconnect policy and start with a fresh resource read.
export async function watchPanes({ url, token, signal, onDirectory }) {
  const client = new Client({ name: 'herdr-pane-watcher', version: '0.1.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  let subscription, wake, ended, dirty = true;
  const notify = () => { dirty = true; wake?.(); };
  signal.addEventListener('abort', notify);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    if (signal.aborted) return;
    client.setNotificationHandler('notifications/resources/updated', notice => {
      if (notice.params.uri === uri) notify();
    });
    subscription = await client.listen({ resourceSubscriptions: [uri] });
    if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) {
      throw new Error('The server did not accept the pane subscription');
    }
    void subscription.closed.then(reason => { ended = reason; wake?.(); });
    while (!signal.aborted && !ended) {
      if (!dirty) await new Promise(resolve => { wake = resolve; });
      wake = undefined;
      if (signal.aborted || ended) break;
      dirty = false;
      const result = await client.readResource({ uri }, { signal });
      const content = result.contents.find(item => item.uri === uri && typeof item.text === 'string');
      if (!content) throw new Error('The server returned no pane directory');
      await onDirectory(JSON.parse(content.text));
    }
    if (!signal.aborted) throw new Error(`Pane subscription closed (${ended}); reconnect and read again`);
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', notify);
    try { await subscription?.close(); } finally { await client.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { HERDR_MCP_URL: url, HERDR_MCP_TOKEN: token } = process.env;
  if (!url || !token) {
    console.error('Set HERDR_MCP_URL and HERDR_MCP_TOKEN in this process environment.');
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      await watchPanes({ url, token, signal: controller.signal, onDirectory: value => console.log(JSON.stringify(value)) });
    } catch {
      console.error('Pane watcher stopped. Check the endpoint, bearer token and push support before reconnecting.');
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  }
}
