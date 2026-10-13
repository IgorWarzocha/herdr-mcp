import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { adaptation, createRunner, normalize } from './bridge.mjs';

function toolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.exit_code !== 0 || result.timed_out || result.cancelled };
}

export function createHandler({ token, runner, origins }) {
  const expected = Buffer.from(`Bearer ${token}`);
  let requests = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Bearer token required'); return;
    }
    if (req.headers.origin && !origins.includes(req.headers.origin)) {
      res.writeHead(403).end('Origin not allowed'); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (requests >= 16) { res.writeHead(503).end('Bridge busy'); return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      res.writeHead(415).end('Expected application/json'); return;
    }
    requests++;
    const abort = new AbortController();
    const bodyTimer = setTimeout(() => req.destroy(), 10000);
    let server, transport;
    res.once('close', () => {
      abort.abort();
      void server?.close().catch(() => {});
    });
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
      server = new McpServer({ name: 'herdr-mcp', version: '0.1.0' });
      const execute = async (args, extra) => runner.run(args, AbortSignal.any([abort.signal, extra.signal]));
      server.registerTool('herdr_skill', { description: 'Read the installed Herdr guide adapted for this MCP bridge', inputSchema: {} }, async (_, extra) => {
        const result = await execute(['--skill'], extra);
        if (result.exit_code !== 0 || result.timed_out || result.cancelled) return toolResult(result);
        return { content: [{ type: 'text', text: `${adaptation}\n--- Installed herdr --skill ---\n${result.stdout}${result.truncated ? '\n[Skill truncated]' : ''}` }] };
      });
      server.registerTool('herdr', {
        description: 'Run Herdr on the configured server. Read herdr_skill for CLI and friendly list/read/send/wait usage',
        inputSchema: { args: z.array(z.string()).max(256).optional(), command: z.string().max(65536).optional() }
      }, async (input, extra) => {
        try { return toolResult(await execute(normalize(input), extra)); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end('Bridge request failed');
    } finally {
      clearTimeout(bodyTimer);
      // handleRequest may return before the tool response; close owns request capacity.
      if (res.writableEnded || res.destroyed) { requests--; await server?.close(); }
      else res.once('close', () => { requests--; });
    }
  };
}

export function config(env = process.env) {
  const home = env.HOME ?? homedir();
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return {
    home,
    tokenFile: env.HERDR_MCP_TOKEN_FILE ?? join(xdg, 'herdr-mcp', 'token'),
    socket: env.HERDR_MCP_SOCKET ?? env.HERDR_SOCKET_PATH ?? join(xdg, 'herdr', 'herdr.sock'),
    binary: env.HERDR_MCP_BINARY ?? 'herdr',
    host: env.HERDR_MCP_HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? env.HERDR_MCP_PORT ?? 8792),
    path: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    origins: (env.HERDR_MCP_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

export async function main() {
  const { home, tokenFile, socket, binary, host, port, path, origins } = config();
  if (!socket.startsWith('/')) throw new Error('HERDR_MCP_SOCKET must be an absolute path');
  const tokenStat = await stat(tokenFile);
  if (tokenStat.mode & 0o077 || tokenStat.uid !== process.getuid()) throw new Error(`Token file ${tokenFile} must be owned by the service user with mode 0600 (chmod 600)`);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Token must be 64 hex chars; generate with: herdr-mcp token');
  const runner = createRunner({ binary, socket, home, path });
  const http = createServer(createHandler({ token, runner, origins }));
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.maxConnections = 64;
  http.listen(port, host, () => console.log(`herdr-mcp listening on http://${host}:${port}/mcp (bearer auth required)`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    runner.stop(); http.close(); http.closeAllConnections();
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
