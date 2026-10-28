import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunner, DEFAULT_WAIT_MAX_MS } from './bridge.mjs';
import { createHandler } from './http.mjs';

export function checkHerdrVersion(text) {
  const match = /^herdr (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(text.trim());
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 9 ||
      (Number(match[2]) === 9 && Number(match[3]) < 5)))) {
    throw new Error('Current Herdr is required (0.9.5 or newer). Check HERDR_MCP_BINARY and PATH.');
  }
  return text.trim();
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
  const version = await runner.run(['--version']);
  if (version.exit_code !== 0 || version.timed_out || version.truncated) throw new Error('Could not verify the installed Herdr version.');
  checkHerdrVersion(version.stdout);
  const handler = createHandler({ token, runner, origins, waitMaxMs });
  const http = createServer(handler);
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.maxConnections = 64;
  http.listen(port, host, () => console.log(`herdr-mcp listening on http://${host}:${port}/mcp (bearer auth required)`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    http.close();
    void handler.close().finally(() => { runner.stop(); http.closeAllConnections(); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
