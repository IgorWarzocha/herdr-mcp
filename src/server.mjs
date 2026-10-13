import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createRunner, DEFAULT_WAIT_MAX_MS, executeCommand, normalize } from './bridge.mjs';
import { failure, toolResult } from './errors.mjs';

const toolSchemas = {
  herdr: z.object({ args: z.array(z.string()).max(256).optional(), command: z.string().max(65536).optional() }),
  herdr_skill: z.object({}),
};

export function createHandler({ token, runner, origins, waitMaxMs = DEFAULT_WAIT_MAX_MS }) {
  const expected = Buffer.from(`Bearer ${token}`);
  let requests = 0;
  return async (req, res) => {
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
    if (requests >= 16) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify(failure('busy'))); return; }
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
      // Use the advertised schemas before SDK validation so malformed tool inputs
      // get the same short recovery envelope rather than a verbose validator dump.
      if (body?.method === 'tools/call' && ['string', 'number'].includes(typeof body.id) &&
          Object.hasOwn(toolSchemas, body.params?.name) &&
          !toolSchemas[body.params.name].safeParse(body.params.arguments ?? {}).success) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: body.id, result: toolResult(failure('invalid_arguments', body.params.name === 'herdr'
            ? 'Use args as an array of at most 256 strings, or command as a string of at most 65536 characters.'
            : 'Supply a JSON arguments object. herdr_skill needs no arguments.')),
        }));
        return;
      }
      server = new McpServer({ name: 'herdr-mcp', version: '0.1.0' });
      const execute = (args, extra) => executeCommand(runner, args, AbortSignal.any([abort.signal, extra.signal]), waitMaxMs);
      server.registerTool('herdr_skill', { description: 'Read the installed Herdr CLI guide verbatim', inputSchema: toolSchemas.herdr_skill }, async (_, extra) => {
        const result = await execute(['--skill'], extra);
        if (result.code === 'truncated') {
          return toolResult({ ...result, next: 'The installed guide exceeded the output limit. Use herdr with the relevant subcommand --help instead.' });
        }
        if (result.code !== 'ok') return toolResult(result);
        return { content: [{ type: 'text', text: result.stdout }] };
      });
      server.registerTool('herdr', {
        description: 'Run Herdr on the pinned server with explicit targets. Use args or a quote-only command. Friendly verbs: list, read, send, wait. Read herdr_skill for CLI syntax. Calls block: wait holds this call for up to 90 seconds by default (configurable). Coding agents take minutes, not seconds. If you need the result before continuing, call wait. On wait_timeout, call wait again in a loop while work continues. Do not assume finished or stuck. Otherwise carry on and check back later with read/list. send acknowledges delivery, not completion. Session switching and maintenance are disabled.',
        inputSchema: toolSchemas.herdr
      }, async (input, extra) => {
        let args;
        try { args = normalize(input); }
        catch (error) { return toolResult(failure('invalid_arguments', error.message)); }
        return toolResult(await execute(args, extra));
      });
      // Stream tool responses so SDK-owned SSE comments keep idle proxies alive.
      // Comments never enter model context and are not repeated tool calls.
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined,
        enableJsonResponse: body?.method !== 'tools/call', keepAliveMs: 15000 });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify(failure('bridge_error')));
    } finally {
      clearTimeout(bodyTimer);
      // handleRequest may return before the tool response; close owns request capacity.
      if (res.writableEnded || res.destroyed) { requests--; await server?.close(); }
      else res.once('close', () => { requests--; });
    }
  };
}

export function config(env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const { join } = win ? win32 : posix;
  const home = (win ? env.USERPROFILE ?? env.HOME : env.HOME) ?? homedir();
  const xdg = env.XDG_CONFIG_HOME ?? (win
    ? (env.APPDATA ?? (env.USERPROFILE ? join(home, 'AppData', 'Roaming') : join(home, '.config')))
    : join(home, '.config'));
  const waitMaxMs = Number(env.HERDR_MCP_WAIT_MAX ?? DEFAULT_WAIT_MAX_MS);
  if (!Number.isSafeInteger(waitMaxMs) || waitMaxMs < 1 || waitMaxMs > 2147481647) {
    throw new Error('HERDR_MCP_WAIT_MAX must be a positive integer in milliseconds, at most 2147481647');
  }
  return {
    home,
    tokenFile: env.HERDR_MCP_TOKEN_FILE ?? join(xdg, 'herdr-mcp', 'token'),
    // Herdr uses this path as a named-pipe identifier on Windows, not a Unix socket.
    socket: env.HERDR_MCP_SOCKET ?? env.HERDR_SOCKET_PATH ?? join(xdg, 'herdr', 'herdr.sock'),
    binary: env.HERDR_MCP_BINARY ?? 'herdr',
    host: env.HERDR_MCP_HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? env.HERDR_MCP_PORT ?? 8792),
    path: env.PATH ?? (win ? (env.Path ?? '') : '/usr/local/bin:/usr/bin:/bin'),
    origins: (env.HERDR_MCP_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    waitMaxMs,
  };
}

export async function readToken(tokenFile, platform = process.platform, uid = process.getuid?.()) {
  const tokenStat = await stat(tokenFile);
  // POSIX only: Windows has no mode bits/uid; keep the token inside your user profile (NTFS ACLs).
  if (!tokenStat.isFile()) throw new Error('Token must be a regular file');
  if (platform !== 'win32' && (tokenStat.mode & 0o077 || tokenStat.uid !== uid)) throw new Error(`Token file ${tokenFile} must be owned by the service user with mode 0600 (chmod 600)`);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Token must be 64 hex chars; generate with: herdr-mcp token');
  return token;
}

export async function main() {
  const { home, tokenFile, socket, binary, host, port, path, origins, waitMaxMs } = config();
  if (!isAbsolute(socket)) throw new Error('HERDR_MCP_SOCKET must be an absolute path');
  const token = await readToken(tokenFile);
  const runner = createRunner({ binary, socket, home, path });
  const http = createServer(createHandler({ token, runner, origins, waitMaxMs }));
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.maxConnections = 64;
  http.listen(port, host, () => console.log(`herdr-mcp listening on http://${host}:${port}/mcp (bearer auth required)`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    runner.stop(); http.close(); http.closeAllConnections();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
