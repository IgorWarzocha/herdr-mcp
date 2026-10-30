// Real installed Core, private session and OSC fixture. No user terminals,
// provider credentials or model calls. The parent owns the scratch directory.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunner } from '../src/bridge.mjs';
import { checkCoreVersion } from '../src/server.mjs';

export async function coreSmoke(cfg, root) {
  const runner = createRunner({ ...cfg, binary: cfg.coreBinary, runtime: 'core', home: root,
    coreSession: `mcp-${randomBytes(5).toString('hex')}`, coreSocket: join(root, 'core.sock'),
    configHome: join(root, 'core-config'), stateHome: join(root, 'core-state'), runtimeDir: join(root, 'run') });
  try {
    let version;
    try { version = await runner.run(['--version']); }
    catch (error) { if (error.code === 'ENOENT' && !cfg.coreRequired) { runner.stop(); return; } throw error; }
    assert.equal(version.exit_code, 0, 'Core version probe failed');
    checkCoreVersion(version.stdout);
    await mkdir(join(root, 'run'), { recursive: true, mode: 0o700 });
  } catch (error) { runner.stop(); throw error; }
  const cli = async args => {
    const result = await runner.run(['--json', ...args]);
    assert.equal(result.exit_code, 0, `private Core ${args[0]} failed`);
    assert.equal(result.truncated, false);
    return JSON.parse(result.stdout);
  };
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
      await call(['close', target]);
      console.log('ok: installed Core; live spawn/list/get/send/read/wait/reply/close; private OSC fixture; no model calls');
    },
    async close() {
      try { await runner.run(['server', 'stop'], undefined, { timeoutMs: 5000 }); }
      finally { runner.stop(); }
    },
  };
}
