import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunner, DEFAULT_WAIT_MAX_MS } from './bridge.mjs';
import { createHandler } from './http.mjs';
import { createRuntimes } from './runtimes.mjs';

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
    coreBinary: env.HERDR_MCP_CORE_BINARY ?? 'hc',
    coreRequired: env.HERDR_MCP_CORE_BINARY !== undefined,
    tuiRequired: env.HERDR_MCP_BINARY !== undefined,
    coreSocket: env.HERDR_MCP_CORE_SOCKET,
    coreSession: env.HERDR_MCP_CORE_SESSION ?? 'default',
    configHome: env.XDG_CONFIG_HOME,
    stateHome: env.XDG_STATE_HOME,
    runtimeDir: env.XDG_RUNTIME_DIR,
    host: env.HERDR_MCP_HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? env.HERDR_MCP_PORT ?? 8792),
    path: env.PATH ?? (win ? (env.Path ?? '') : '/usr/local/bin:/usr/bin:/bin'),
    origins: (env.HERDR_MCP_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    waitMaxMs,
  };
}

export function checkCoreVersion(text) {
  const match = /^hc (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(text.trim());
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 1 ||
      (Number(match[2]) === 1 && Number(match[3]) < 14)))) {
    throw new Error('Current herdr-core is required (hc 0.1.14 or newer). Check HERDR_MCP_CORE_BINARY and PATH.');
  }
  return text.trim();
}

// Version probes do not start a server. Missing default binaries are optional;
// explicitly configured, broken or unsupported installations are errors.
export async function installedRuntimes(cfg) {
  const runners = {};
  const budget = { active: 0 };
  try {
    for (const [name, binary, required, check] of [
      ['tui', cfg.binary, cfg.tuiRequired, checkHerdrVersion],
      ['core', cfg.coreBinary, cfg.coreRequired, checkCoreVersion],
    ]) {
      const runner = createRunner({ ...cfg, binary, runtime: name, budget });
      let version;
      try { version = await runner.run(['--version'], undefined, { timeoutMs: 5000 }); }
      catch (error) {
        runner.stop();
        if (error.code === 'ENOENT' && !required) continue;
        throw new Error(`Could not start the configured ${name} executable.`);
      }
      if (version.exit_code !== 0 || version.timed_out || version.truncated) {
        runner.stop(); throw new Error(`Could not verify the installed ${name} version.`);
      }
      try { check(version.stdout); } catch (error) { runner.stop(); throw error; }
      runners[name] = runner;
    }
    if (!runners.tui && !runners.core) throw new Error('Install Herdr TUI or herdr-core, then run doctor.');
    return createRuntimes(runners);
  } catch (error) {
    for (const runner of Object.values(runners)) runner.stop();
    throw error;
  }
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
  const cfg = config();
  const { tokenFile, socket, host, port, origins, waitMaxMs } = cfg;
  if (!isAbsolute(socket)) throw new Error('HERDR_MCP_SOCKET must be an absolute path');
  if (cfg.coreSocket && !isAbsolute(cfg.coreSocket)) throw new Error('HERDR_MCP_CORE_SOCKET must be an absolute path');
  const token = await readToken(tokenFile);
  const runner = await installedRuntimes(cfg);
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
