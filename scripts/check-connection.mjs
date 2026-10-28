import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { config, readToken } from '../src/server.mjs';

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
  const client = new Client({ name: 'herdr-connection-check', version: '0.2.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['herdr_skill', 'herdr']);
    const skill = await client.callTool({ name: 'herdr_skill', arguments: {} });
    assert.notEqual(skill.isError, true);
    const response = await client.callTool({ name: 'herdr', arguments: { args: ['list'] } });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.code, 'ok', result.next);
    assert.ok(Array.isArray(JSON.parse(result.stdout).panes));
    console.log('ok: MCP 2026-07-28, bearer authentication, herdr_skill and pane discovery');
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = config();
  const local = `http://${cfg.host}:${cfg.port}/mcp`;
  const url = process.argv[2] === '--local' ? local : process.env.HERDR_MCP_URL ?? local;
  checkConnection(url).catch(error => { console.error(`Connection check failed: ${error.message}`); process.exitCode = 1; });
}
