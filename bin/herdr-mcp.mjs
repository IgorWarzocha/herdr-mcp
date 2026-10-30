#!/usr/bin/env node
// herdr-mcp            start the server (reads env, see .env.example)
// herdr-mcp token      create the token file (0600 on POSIX) if missing and print its path
// herdr-mcp doctor     preflight checks: herdr on PATH, version, socket, token
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, installedRuntimes, main, readToken } from '../src/server.mjs';

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
  await check('runtimes', async () => {
    const runtimes = await installedRuntimes(cfg);
    try {
      const result = await runtimes.directory();
      if (result.code !== 'ok') throw new Error(result.next);
      const directory = JSON.parse(result.stdout);
      if (directory.unavailable?.length) throw new Error(directory.unavailable.map(item => `${item.runtime}: ${item.code}`).join(', '));
      return `${directory.panes.length} local targets; Core preferred for new programs when installed`;
    } finally { runtimes.stop(); }
  });
  await check('token', async () => { await readToken(cfg.tokenFile); return cfg.tokenFile; });
  process.exitCode = ok ? 0 : 1;
} else if (!cmd || cmd === 'start') {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: herdr-mcp [start|token|doctor]'); process.exitCode = 2; }
