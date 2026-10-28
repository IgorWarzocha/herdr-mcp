import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { config, readToken } from '../src/server.mjs';
import { checkProtocols } from './protocol-smoke.mjs';

export async function checkConnection(url) {
  const token = await readToken(config().tokenFile);
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      assert.equal((await fetch(url, { method: 'POST', signal: AbortSignal.timeout(1000) })).status, 401,
        'The endpoint must reject unauthenticated requests');
      break;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
  await checkProtocols(url, token);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = config();
  const local = `http://${cfg.host}:${cfg.port}/mcp`;
  const url = process.argv[2] === '--local' ? local : process.env.HERDR_MCP_URL ?? local;
  checkConnection(url).catch(error => { console.error(`Connection check failed: ${error.message}`); process.exitCode = 1; });
}
