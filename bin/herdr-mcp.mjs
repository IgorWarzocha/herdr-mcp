#!/usr/bin/env node
// herdr-mcp            start the server (reads env, see .env.example)
// herdr-mcp token      create the token file (0600) if missing and print its path
// herdr-mcp doctor     preflight checks: herdr on PATH, version, socket, token
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, main } from '../src/server.mjs';

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
  const check = (name, fn) => { try { console.log(`ok   ${name}: ${fn()}`); } catch (e) { ok = false; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); } };
  check('herdr', () => {
    const v = execFileSync(cfg.binary, ['--version'], { env: { PATH: cfg.path, HOME: cfg.home } }).toString().trim();
    const [maj, min] = (v.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
    if (!(maj > 0 || min >= 9)) throw new Error(`${v} found first on PATH; need 0.9+ (stale /usr/bin/herdr?)`);
    return v;
  });
  for (const [n, f] of [['socket', cfg.socket], ['token', cfg.tokenFile]]) await stat(f).then(s => {
    if (n === 'token' && (s.mode & 0o077)) { ok = false; console.log(`FAIL token: ${f} must be chmod 600`); }
    else console.log(`ok   ${n}: ${f}`);
  }, () => { ok = false; console.log(`FAIL ${n}: missing ${f}${n === 'token' ? ' (run: herdr-mcp token)' : ' (is herdr server running?)'}`); });
  process.exitCode = ok ? 0 : 1;
} else if (!cmd || cmd === 'start') {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: herdr-mcp [start|token|doctor]'); process.exitCode = 2; }
