import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceCheckArguments } from '../scripts/restart.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Property shapes verified against systemd's running service through busctl.
const definition = () => ({
  ExecStart: [['/usr/bin/mise', ['/usr/bin/mise', 'exec', 'node@latest', '--', 'node', 'src/server.mjs'], false]],
  WorkingDirectory: root, Environment: ['MISE_EXEC_AUTO_INSTALL=false'],
  EnvironmentFiles: [['/service config/service.env', false]], UnsetEnvironment: ['UNWANTED'], RootDirectory: '', RootImage: '',
});

test('restart gate preserves service launcher and environment file instead of caller PATH or token settings', async () => {
  const args = await serviceCheckArguments(definition(), root, 'check-live.mjs');
  assert.ok(args.includes('--property=EnvironmentFile=/service config/service.env'));
  assert.ok(args.includes('--setenv=MISE_EXEC_AUTO_INSTALL=false'));
  assert.ok(args.includes('--property=UnsetEnvironment=UNWANTED'));
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/usr/bin/mise', 'exec', 'node@latest', '--', 'node', join(root, 'scripts/check-live.mjs')]);
  const probe = await serviceCheckArguments(definition(), root, 'check-connection.mjs');
  assert.equal(probe.at(-1), '--local', 'post-restart verification must use the service endpoint, not a caller URL');
});

test('restart gate refuses a different checkout or an unverifiable service command before stopping anything', async () => {
  await assert.rejects(serviceCheckArguments({ ...definition(), WorkingDirectory: dirname(root) }, root, 'check-live.mjs'), /different checkout/);
  await assert.rejects(serviceCheckArguments({ ...definition(), RootDirectory: '/container' }, root, 'check-live.mjs'), /filesystem root/);
  await assert.rejects(serviceCheckArguments({ ...definition(), ExecStart: [] }, root, 'check-live.mjs'), /one service/);
  const other = definition(); other.ExecStart[0][1] = ['/usr/bin/mise', 'exec', 'node@latest', '--', 'node', '/another/server.mjs'];
  await assert.rejects(serviceCheckArguments(other, root, 'check-live.mjs'), /supported bridge entry point/);
});
