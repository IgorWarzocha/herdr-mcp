#!/usr/bin/env node
// herdr-mcp            start the server (reads env, see .env.example)
// herdr-mcp token      create the token file (0600 on POSIX) if missing and print its path
// herdr-mcp doctor     preflight checks: herdr on PATH, version, socket, token
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, main, readToken } from '../src/server.mjs';
import { commandEnvironment } from '../src/bridge.mjs';

const cmd = process.argv[2];
const cfg = config();
if (cmd === 'token') {
  try { await stat(cfg.tokenFile); console.log(`exists: ${cfg.tokenFile}`); }
  catch {
    await mkdir(dirname(cfg.tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(cfg.tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`created: ${cfg.tokenFile}`);
  }
} else if (cmd === 'doctor') {
  let ok = true;
  const check = async (name, fn) => { try { console.log(`ok   ${name}: ${await fn()}`); } catch (e) { ok = false; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); } };
  const execOptions = { env: commandEnvironment(cfg), cwd: cfg.home, shell: false, windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };
  await check('herdr', () => {
    const v = execFileSync(cfg.binary, ['--version'], execOptions).toString().trim();
    const [maj, min] = (v.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
    if (!(maj > 0 || min >= 9)) throw new Error(`${v} found first on PATH; need 0.9+ (check HERDR_MCP_BINARY and PATH)`);
    return v;
  });
  await check('socket', () => {
    // Let Herdr probe its own transport: a Unix socket on POSIX, a named pipe on Windows.
    execFileSync(cfg.binary, ['pane', 'list'], execOptions);
    return `${cfg.socket} (Herdr responded)`;
  });
  await check('token', async () => { await readToken(cfg.tokenFile); return cfg.tokenFile; });
  process.exitCode = ok ? 0 : 1;
} else if (!cmd || cmd === 'start') {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: herdr-mcp [start|token|doctor]'); process.exitCode = 2; }
