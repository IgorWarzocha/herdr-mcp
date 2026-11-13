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
} else if (cmd === 'oauth') {
  const action = process.argv[3], requestId = process.argv[4];
  if ((action !== 'approve' || !/^[a-f0-9]{48}$/.test(requestId ?? '') || process.argv.length !== 5) &&
      (action !== 'revoke' || process.argv.length !== 4)) {
    console.error('usage: herdr-mcp oauth approve <request-ID> | herdr-mcp oauth revoke'); process.exitCode = 2;
  } else {
    try {
      const token = await readToken(cfg.tokenFile);
      const host = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
      const response = await fetch(`http://${host}:${cfg.port}/mcp/oauth/${action === 'approve' ? 'approve' : 'revoke-all'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? { request_id: requestId } : {}), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`OAuth ${action} failed (${response.status}). Check the bridge and request expiry.`);
      console.log(JSON.stringify(await response.json()));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
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
      return `${directory.panes.length} targets; Core preferred for new programs when installed`;
    } finally { runtimes.stop(); }
  });
  await check('token', async () => { await readToken(cfg.tokenFile); return cfg.tokenFile; });
  process.exitCode = ok ? 0 : 1;
} else if (!cmd || cmd === 'start') {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: herdr-mcp [start|token|doctor|oauth]'); process.exitCode = 2; }
