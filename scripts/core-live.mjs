// Real installed Core, private session and OSC fixture. No user terminals,
// provider credentials or model calls. The parent owns the scratch directory.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunner } from '../src/bridge.mjs';
import { checkCoreVersion } from '../src/server.mjs';

export async function coreSmoke(cfg, root) {
  const runner = createRunner({ ...cfg, binary: cfg.coreBinary, runtime: 'core', home: root,
    coreSession: `mcp-${randomBytes(5).toString('hex')}`, coreSocket: join(root, 'core.sock'),
    configHome: join(root, 'core-config'), stateHome: join(root, 'core-state'), runtimeDir: join(root, 'run') });
  const remoteRoot = join(root, 'remote');
  const remoteSession = `mcp-${randomBytes(5).toString('hex')}`;
  const remoteSocket = join(remoteRoot, 'core.sock');
  const remote = createRunner({ ...cfg, binary: cfg.coreBinary, runtime: 'core', home: remoteRoot,
    coreSession: remoteSession, coreSocket: remoteSocket, configHome: join(remoteRoot, 'config'),
    stateHome: join(remoteRoot, 'state'), runtimeDir: join(remoteRoot, 'run') });
  try {
    let version;
    try { version = await runner.run(['--version']); }
    catch (error) { if (error.code === 'ENOENT' && !cfg.coreRequired) { runner.stop(); remote.stop(); return; } throw error; }
    assert.equal(version.exit_code, 0, 'Core version probe failed');
    checkCoreVersion(version.stdout);
    await mkdir(join(root, 'run'), { recursive: true, mode: 0o700 });
  } catch (error) { runner.stop(); remote.stop(); throw error; }
  const command = async (which, args) => {
    const result = await which.run(['--json', ...args]);
    assert.equal(result.exit_code, 0, `private Core ${args[0]} failed`);
    assert.equal(result.truncated, false);
    return JSON.parse(result.stdout);
  };
  const cli = args => command(runner, args);
  const remoteCli = args => command(remote, args);
  return {
    runner,
    async exercise(call) {
      const marker = `core-${randomBytes(8).toString('hex')}`;
      const received = join(root, 'core-message.txt');
      const sessionFile = join(root, 'core-reply.jsonl');
      const reply = `Clean Core Pi reply ${marker}`;
      await writeFile(sessionFile, [
        { type: 'session', version: 3, id: marker },
        { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: reply }] } },
      ].map(value => JSON.stringify(value) + '\n').join(''));
      const program = [
        'const fs = require("node:fs");',
        'const rl = require("node:readline").createInterface({input: process.stdin});',
        'const status = s => process.stdout.write("\\x1b]7501;state=" + s + ":app=pi\\x1b\\\\");',
        'status("idle");',
        'rl.on("line", line => { status("working"); fs.writeFileSync(process.argv[1],line); process.stdout.write(line + "\\n"); setTimeout(() => status("idle"), 1000); });',
      ].join('\n');
      const created = await call(['spawn', '--name', 'core-smoke', '--cwd', root, '--', process.execPath, '-e', program, received]);
      assert.match(created.pane_id, /^core:t[0-9a-z]+$/, 'new programs must prefer Core');
      const target = created.pane_id;
      const id = target.slice('core:'.length);
      await cli(['label', id, `pi.session_file=${sessionFile}`]);
      const deadline = Date.now() + 10000;
      while ((await cli(['get', id])).status?.state !== 'idle') {
        assert.ok(Date.now() < deadline, 'private Core fixture did not report idle');
        await delay(50);
      }
      assert.ok(JSON.parse((await call(['list'])).stdout).panes.some(pane => pane.pane_id === target));
      assert.equal((await call(['get', target])).pane_id, target);
      await call(['send', target, marker]);
      assert.equal(await readFile(received, 'utf8'), marker);
      await call(['wait', target, '--timeout', '3000']);
      assert.ok((await call(['read', target, '--source', 'visible'])).stdout.includes(marker));
      assert.equal((await call(['reply', target])).stdout, reply);

      if (process.platform !== 'win32') {
        // The transport is a local SSH-like command, not a connection to a real host.
        // It executes Core's supplied remote shell line in a completely separate home.
        await mkdir(join(remoteRoot, 'run'), { recursive: true, mode: 0o700 });
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
        const wrapper = join(root, 'remote-via');
        const remotePath = `${dirname(process.execPath)}:${cfg.path}`;
        await writeFile(wrapper, `#!/bin/sh\nexec env -i HOME=${quote(remoteRoot)} PATH=${quote(remotePath)} ` +
          `HC_SESSION=${quote(remoteSession)} HC_SOCKET=${quote(remoteSocket)} ` +
          `XDG_CONFIG_HOME=${quote(join(remoteRoot, 'config'))} XDG_STATE_HOME=${quote(join(remoteRoot, 'state'))} ` +
          `XDG_RUNTIME_DIR=${quote(join(remoteRoot, 'run'))} sh -c "$1"\n`);
        await chmod(wrapper, 0o700);
        const remoteInfo = await remoteCli(['server', 'status']);
        const machineId = remoteInfo.core.id;
        const added = await cli(['machine', 'add', '--name', 'box', '--via', wrapper]);
        assert.equal(added.id, machineId);
        const connectedDeadline = Date.now() + 10000;
        while ((await cli(['machine', 'ls'])).machines.find(machine => machine.id === machineId)?.state !== 'connected') {
          assert.ok(Date.now() < connectedDeadline, 'remote Core did not connect');
          await delay(50);
        }
        const remoteReceived = join(remoteRoot, 'message.txt');
        const remoteSessionFile = join(remoteRoot, 'reply.jsonl');
        await writeFile(remoteSessionFile, [
          { type: 'session', version: 3, id: marker },
          { type: 'message', id: 'remote-answer', parentId: null, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `Remote ${reply}` }] } },
        ].map(value => JSON.stringify(value) + '\n').join(''));
        const remoteCreated = await call(['--machine', 'box', 'spawn', '--name', 'remote-smoke', '--cwd', remoteRoot,
          '--', process.execPath, '-e', program, remoteReceived]);
        const remoteTarget = remoteCreated.pane_id;
        assert.match(remoteTarget, new RegExp(`^core:${machineId}/t[0-9a-z]+$`));
        const remoteId = remoteTarget.slice(`core:${machineId}/`.length);
        assert.equal(remoteId, id, 'private local and remote IDs should collide');
        await remoteCli(['label', remoteId, `pi.session_file=${remoteSessionFile}`]);
        const remoteDeadline = Date.now() + 10000;
        while ((await remoteCli(['get', remoteId])).status?.state !== 'idle') {
          assert.ok(Date.now() < remoteDeadline, 'remote Core fixture did not report idle');
          await delay(50);
        }
        const directory = JSON.parse((await call(['list'])).stdout);
        assert.ok(directory.panes.some(pane => pane.pane_id === target));
        assert.ok(directory.panes.some(pane => pane.pane_id === remoteTarget));
        assert.ok(directory.machines.some(machine => machine.id === machineId && machine.name === 'box' && machine.state === 'connected'));
        const filtered = JSON.parse((await call(['--machine', 'box', 'list'])).stdout);
        assert.ok(filtered.panes.some(pane => pane.pane_id === remoteTarget));
        assert.ok(!filtered.panes.some(pane => pane.pane_id === target));
        assert.equal((await call(['get', remoteTarget])).pane_id, remoteTarget);
        await call(['--machine', 'box', 'send', remoteId, marker]);
        assert.equal(await readFile(remoteReceived, 'utf8'), marker);
        await call(['wait', remoteTarget, '--timeout', '3000']);
        assert.ok((await call(['--machine', machineId, 'read', remoteId, '--source', 'visible'])).stdout.includes(marker));
        assert.equal((await call(['reply', remoteTarget])).stdout, `Remote ${reply}`);
        const largeReply = '😀'.repeat(30000);
        await writeFile(remoteSessionFile, [
          { type: 'session', version: 3, id: marker },
          { type: 'message', id: 'large-answer', parentId: null, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: largeReply }] } },
        ].map(value => JSON.stringify(value) + '\n').join(''));
        const firstPage = await call(['reply', remoteTarget, '--limit', '30000']);
        assert.ok(firstPage.stdout.length > 0 && firstPage.next_offset > 0 && firstPage.next_offset < 30000);
        assert.equal(Array.from(firstPage.stdout).length, firstPage.next_offset);
        assert.equal(firstPage.message_id, 'large-answer');
        const nextPage = await call(['reply', remoteTarget, '--limit', '30000', '--offset', String(firstPage.next_offset),
          '--message-id', firstPage.message_id]);
        assert.equal(nextPage.next_offset, null);
        assert.equal(firstPage.stdout + nextPage.stdout, largeReply);
        await cli(['machine', 'rename', 'box', 'renamed']);
        assert.equal((await call(['get', remoteTarget])).pane_id, remoteTarget);
        assert.ok(JSON.parse((await call(['--machine', 'renamed', 'list'])).stdout).panes.some(pane => pane.pane_id === remoteTarget));
        const rejectedCall = error => error instanceof assert.AssertionError && error.expected === 'ok' && typeof error.actual === 'string';
        await assert.rejects(call(['--machine', 'missing-machine', 'send', id, 'must-not-arrive']), rejectedCall);
        assert.equal(await readFile(received, 'utf8'), marker);
        await call(['close', remoteTarget]);
        await unlink(wrapper);
        await remoteCli(['server', 'stop']);
        const disconnectedDeadline = Date.now() + 10000;
        while ((await cli(['machine', 'ls'])).machines.find(machine => machine.id === machineId)?.state === 'connected') {
          assert.ok(Date.now() < disconnectedDeadline, 'remote Core did not disconnect');
          await delay(50);
        }
        await assert.rejects(call(['--machine', machineId, 'send', id, 'must-not-arrive']), rejectedCall);
        assert.equal(await readFile(received, 'utf8'), marker);
        console.log('ok: remote Core spawn/list/get/send/read/wait/reply/close and routing failures');
      } else {
        console.log('skip: remote Core fixture requires POSIX shell transport');
      }
      await call(['close', target]);
      console.log('ok: installed Core; local spawn/list/get/send/read/wait/reply/close; private OSC fixture; no model calls');
    },
    async close() {
      try { await runner.run(['server', 'stop'], undefined, { timeoutMs: 5000 }); }
      finally {
        try { await remote.run(['server', 'stop'], undefined, { timeoutMs: 5000 }); }
        finally { runner.stop(); remote.stop(); }
      }
    },
  };
}
