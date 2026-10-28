// Installed-binary gate. All mutations stay in a disposable Herdr session.
// Pi resumes a synthetic conversation and receives only a local /name command:
// no provider credentials, model calls, user panes, bridge token or tunnel.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { checkHerdrVersion, config } from '../src/server.mjs';
import { commandEnvironment, createRunner } from '../src/bridge.mjs';
import { createHandler } from '../src/http.mjs';
import { FRIENDLY_VERBS } from '../src/friendly.mjs';
import { checkProtocols } from './protocol-smoke.mjs';

const exec = promisify(execFile);

async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('Live smoke condition did not become ready before its deadline');
    await delay(100);
  }
}

export async function checkLive() {
  const cfg = config();
  const baseEnv = commandEnvironment(cfg);
  const version = checkHerdrVersion((await exec(cfg.binary, ['--version'], { env: baseEnv, timeout: 5000 })).stdout);
  const root = await mkdtemp(join(tmpdir(), 'herdr-mcp-live-'));
  const name = `mcp-smoke-${randomBytes(6).toString('hex')}`;
  const configHome = join(root, 'config');
  const agentDir = join(root, 'pi');
  const socket = join(configHome, 'herdr', 'sessions', name, 'herdr.sock');
  const env = { ...baseEnv, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', ZDOTDIR: root };
  delete env.HERDR_SOCKET_PATH;
  const runner = createRunner({ ...cfg, socket });
  let server, serverExit, exited = false, startupError, http, handler, client;
  const checked = new Set();
  const cli = async args => {
    const result = await runner.run(args);
    assert.equal(result.exit_code, 0, `installed Herdr failed ${args.slice(0, 2).join(' ')}: ${result.stderr}`);
    assert.equal(result.truncated, false);
    return JSON.parse(result.stdout).result;
  };
  try {
    await mkdir(join(configHome, 'herdr'), { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(configHome, 'herdr', 'config.toml'),
      '[terminal]\nshell_mode = "non_login"\n' + (process.platform === 'win32' ? '' : 'default_shell = "/bin/sh"\n'));
    // Use Herdr's supported installer, scoped to the temporary Pi directory.
    await exec(cfg.binary, ['integration', 'install', 'pi'], { env, timeout: 10000 });
    server = spawn(cfg.binary, ['--session', name, 'server'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    server.on('error', error => { startupError = error; });
    serverExit = new Promise(resolve => server.once('close', () => { exited = true; resolve(); }));
    await until(async () => {
      if (startupError) throw startupError;
      if (exited) throw new Error('Disposable Herdr server exited during startup');
      return (await runner.run(['api', 'snapshot'], undefined, { timeoutMs: 1000 })).exit_code === 0;
    });

    const shell = await cli(['workspace', 'create', '--cwd', root, '--label', 'Shell smoke', '--no-focus']);
    const shellId = shell.root_pane.pane_id;
    await cli(['tab', 'rename', shell.tab.tab_id, 'Shell smoke tab']);
    const token = randomBytes(32).toString('hex');
    handler = createHandler({ token, runner, origins: [] });
    http = createServer(handler); http.listen(0, '127.0.0.1'); await once(http, 'listening');
    await checkProtocols(`http://127.0.0.1:${http.address().port}/mcp`, token);
    client = new Client({ name: 'installed-herdr-smoke', version: '0.2.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const call = async args => {
      const response = await client.callTool({ name: 'herdr', arguments: { args } }, { timeout: 35000 });
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.code, 'ok', `${args[0]} failed: ${result.code}. ${result.next ?? ''}`);
      assert.equal(response.isError, false);
      checked.add(args[0]);
      return result;
    };
    assert.ok(JSON.parse((await call(['list'])).stdout).panes.some(pane => pane.pane_id === shellId));
    await call(['wait', shellId, '--timeout', '1000']);
    const marker = `smoke-${randomBytes(8).toString('hex')}`;
    const shellCommand = process.platform === 'win32' ? `echo ${marker}>smoke.txt` : `printf '%s' '${marker}' > smoke.txt`;
    await call(['send', 'Shell smoke tab', shellCommand]);
    await until(async () => {
      try { return (await readFile(join(root, 'smoke.txt'), 'utf8')).trim() === marker; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    const screen = await call(['read', 'Shell smoke tab']);
    assert.match(screen.stdout, /smoke\.txt/, 'the real shell screen should show the submitted command');

    const sessionFile = join(root, 'pi-session.jsonl');
    const timestamp = new Date().toISOString();
    const reply = `Clean reply ${marker}\n${'Unwrapped content '.repeat(30)}`;
    await writeFile(sessionFile, [
      { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: root },
      { type: 'message', id: 'smoke-user', parentId: null, timestamp,
        message: { role: 'user', content: [{ type: 'text', text: 'Stored smoke conversation. No new task.' }], timestamp: Date.now() } },
      { type: 'message', id: 'smoke-answer', parentId: 'smoke-user', timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: reply }], api: 'openai-responses', provider: 'openai', model: 'gpt-5',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry) + '\n').join(''));
    const pi = await cli(['workspace', 'create', '--cwd', root, '--label', 'Pi smoke', '--no-focus',
      '--env', `PI_CODING_AGENT_DIR=${agentDir}`, '--env', 'PI_OFFLINE=1', '--env', 'PI_TELEMETRY=0']);
    const piId = pi.root_pane.pane_id;
    await cli(['tab', 'rename', pi.tab.tab_id, 'Pi smoke tab']);
    await call(['wait', piId, '--timeout', '1000']);
    await cli(['agent', 'start', 'mcp-smoke', '--kind', 'pi', '--pane', piId, '--timeout', '20000', '--',
      '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools',
      '--extension', join(agentDir, 'extensions', 'herdr-agent-state.ts'), '--session', sessionFile]);
    await call(['send', 'Pi smoke tab', `/name ${marker}`]);
    await until(async () => (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .some(entry => entry.type === 'session_info' && entry.name === marker));
    await call(['wait', 'mcp-smoke', '--timeout', '1000']);
    assert.ok((await call(['read', 'mcp-smoke'])).stdout.length > 0);
    assert.equal((await call(['reply', 'Pi smoke tab'])).stdout, reply);
    assert.deepEqual([...checked].sort(), [...FRIENDLY_VERBS].sort(), 'every advertised friendly verb needs a live smoke case');
    console.log(`ok: ${version}; live list/send/read/wait/reply; agent and shell sends; no model calls`);
  } finally {
    try { await client?.close(); } finally {
      try { await handler?.close(); } finally {
        http?.close(); http?.closeAllConnections();
        if (server && !exited) {
          try { await runner.run(['server', 'stop'], undefined, { timeoutMs: 3000 }); }
          finally {
            if (!exited) server.kill('SIGTERM');
            const kill = setTimeout(() => { if (!exited) server.kill('SIGKILL'); }, 1000);
            await serverExit; clearTimeout(kill);
          }
        }
        runner.stop();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkLive().catch(error => { console.error(`Live smoke failed: ${error.message}`); process.exitCode = 1; });
}
