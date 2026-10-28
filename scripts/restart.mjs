import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const unit = 'herdr-mcp.service';
const objectPath = '/org/freedesktop/systemd1/unit/herdr_2dmcp_2eservice';

async function property(name, type = 'Service') {
  const { stdout } = await exec('busctl', ['--user', '--json=short', 'get-property', 'org.freedesktop.systemd1',
    objectPath, `org.freedesktop.systemd1.${type}`, name], { timeout: 5000 });
  return JSON.parse(stdout).data;
}

export async function serviceCheckArguments(definition, checkout, script) {
  if (await realpath(definition.WorkingDirectory) !== await realpath(checkout)) {
    throw new Error('The service runs a different checkout. Run the gate from its working directory.');
  }
  if (definition.RootDirectory || definition.RootImage) throw new Error('This service uses a filesystem root the restart gate cannot reproduce.');
  if (!Array.isArray(definition.ExecStart) || definition.ExecStart.length !== 1) throw new Error('Expected one service ExecStart command.');
  const [executable, argv] = definition.ExecStart[0];
  if (!Array.isArray(argv) || argv.length < 2 || argv.some(arg => typeof arg !== 'string') || argv[0] !== executable) {
    throw new Error('The service ExecStart arguments could not be verified.');
  }
  const entry = resolve(checkout, argv.at(-1));
  if (![join(checkout, 'src/server.mjs'), join(checkout, 'bin/herdr-mcp.mjs')].includes(entry)) {
    throw new Error('The service command is not a supported bridge entry point. No restart was attempted.');
  }
  const args = ['--user', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', '--expand-environment=no',
    `--working-directory=${definition.WorkingDirectory}`, '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=5'];
  for (const entry of definition.Environment) args.push(`--setenv=${entry}`);
  for (const [path, optional] of definition.EnvironmentFiles) {
    args.push(`--property=EnvironmentFile=${(optional ? '-' : '') + path}`);
  }
  for (const entry of definition.UnsetEnvironment) args.push(`--property=UnsetEnvironment=${entry}`);
  // Preserve the service launcher, including mise's supported runtime selection.
  // systemd, not our shell parser, loads its EnvironmentFile values.
  args.push('--', ...argv.slice(0, -1), join(checkout, 'scripts', script));
  if (script === 'check-connection.mjs') args.push('--local');
  return args;
}

export async function restart({ checkOnly = false } = {}) {
  if (process.platform !== 'linux') {
    throw new Error('Automatic gated restart currently requires Linux systemd. On other supervisors, run check:live with the service environment before stopping the bridge.');
  }
  if (await property('NeedDaemonReload', 'Unit')) throw new Error('Reload the edited service unit before running the restart gate.');
  const names = ['ExecStart', 'WorkingDirectory', 'Environment', 'EnvironmentFiles', 'UnsetEnvironment', 'RootDirectory', 'RootImage'];
  const definition = Object.fromEntries(await Promise.all(names.map(async name => [name, await property(name)])));
  const runCheck = async script => {
    const args = await serviceCheckArguments(definition, root, script);
    const { stdout, stderr } = await exec('systemd-run', args, { timeout: 130000, maxBuffer: 131072 });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  };
  // A failed smoke leaves the running bridge untouched. Both checks use the
  // service manager's environment, launcher and checkout, never the caller's.
  await runCheck('check-live.mjs');
  if (checkOnly) return;
  await exec('systemctl', ['--user', 'restart', unit], { timeout: 30000 });
  await runCheck('check-connection.mjs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
    console.error('Usage: node scripts/restart.mjs [--check]'); process.exitCode = 2;
  } else restart({ checkOnly: process.argv[2] === '--check' }).catch(error => {
    // execFile's generated message includes argv. Do not echo service env values.
    console.error(`Bridge restart failed: ${error.code ? `service command exited with ${error.code}` : error.message}`);
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    process.exitCode = 1;
  });
}
