import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, isJsonContentType } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { DEFAULT_WAIT_MAX_MS } from './bridge.mjs';
import { PANES_URI } from './directory.mjs';
import { failure } from './errors.mjs';
import { createMcpServer } from './mcp.mjs';
import { createPaneUpdates } from './pane-updates.mjs';

export function createHandler({ token, runner, origins, waitMaxMs = DEFAULT_WAIT_MAX_MS, pollIntervalMs = 2000 }) {
  const expected = Buffer.from(`Bearer ${token}`);
  const updates = createPaneUpdates({ runner, intervalMs: pollIntervalMs });
  const mcp = createMcpHandler(() => createMcpServer({ runner, updates, waitMaxMs }), {
    legacy: 'reject', responseMode: 'sse', keepAliveMs: 15000,
    maxRequestBodySize: 131072, maxSubscriptions: 8, bus: updates.bus,
  });
  const serve = toNodeHandler(mcp, { maxRequestBodySize: 131072 });
  let requests = 0, closed = false;

  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }).end(JSON.stringify(failure('bad_token'))); return;
    }
    if (req.headers.origin && !origins.includes(req.headers.origin)) {
      res.writeHead(403).end('Origin not allowed'); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (closed || requests >= 16) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify(failure('busy'))); return; }
    if (!isJsonContentType(req.headers['content-type'])) { res.writeHead(415).end('Expected application/json'); return; }
    requests++;
    let released = false;
    const release = () => { if (!released) { released = true; requests--; } };
    res.once('close', release);
    const bodyTimer = setTimeout(() => req.destroy(), 10000);
    try {
      const buffers = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 131072) { res.writeHead(413).end('Request exceeds 128 KiB'); return; }
        buffers.push(chunk);
      }
      clearTimeout(bodyTimer);
      let body;
      try { body = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
      catch { res.writeHead(400).end('Invalid JSON'); return; }
      const uris = body?.params?.notifications?.resourceSubscriptions;
      if (body?.method === 'subscriptions/listen' && ['string', 'number'].includes(typeof body.id) &&
          Array.isArray(uris) && uris.some(uri => uri !== PANES_URI)) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Only ${PANES_URI} supports resource subscriptions.` },
        }));
        return;
      }
      // The official adapter carries disconnect cancellation and SSE backpressure.
      await serve(req, res, body);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify(failure('bridge_error')));
      else res.destroy();
    } finally {
      clearTimeout(bodyTimer);
      if (res.writableEnded || res.destroyed) release();
    }
  };
  handle.close = async () => {
    closed = true;
    updates.close();
    await mcp.close();
  };
  return handle;
}
