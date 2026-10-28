// Opt-in 65-second transport smoke. No Herdr process, token file or tunnel is used.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRunner } from '../src/bridge.mjs';
import { createHandler } from '../src/http.mjs';

async function checkWait(version) {
  const childRunner = createRunner({binary: process.execPath, home: tmpdir(), path: process.env.PATH});
  let commands = 0, streamText = '';
  const runner = { run(args, signal, options) {
    assert.equal(args[1], 'wait');
    commands++;
    return childRunner.run(['-e', 'setTimeout(()=>console.log(JSON.stringify({result:{agent:{agent_status:"done"}}})),65000)'], signal, options);
  }};
  const handler = createHandler({token: 'isolated-smoke-token', runner, origins: []});
  const http = createServer(handler);
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  const client = new Client({name: 'long-wait-smoke', version: '1'}, {
    supportedProtocolVersions: [version],
    versionNegotiation: {mode: version === '2026-07-28' ? {pin: version} : 'legacy'},
  });
  try {
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {headers: {Authorization: 'Bearer isolated-smoke-token'}},
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) return response;
        const decoder = new TextDecoder();
        const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          streamText += decoder.decode(chunk, {stream: true});
          controller.enqueue(chunk);
        }}));
        return new Response(body, {status: response.status, headers: response.headers});
      },
    });
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const response = await client.callTool({name: 'herdr', arguments: {args: ['agent', 'wait', 'smoke-agent']}}, {timeout: 75000});
    const result = JSON.parse(response.content[0].text);
    assert.equal(response.isError, false);
    assert.equal(result.code, 'ok');
    assert.equal(result.wait_timeout_ms, 90000);
    assert.ok(result.elapsed_ms >= 65000);
    assert.equal(commands, 1);
    const keepalives = (streamText.match(/: keepalive/g) ?? []).length;
    assert.ok(keepalives >= 4, `expected at least four keepalives, got ${keepalives}`);
    console.log(`ok: ${client.getNegotiatedProtocolVersion()}, one ${result.elapsed_ms} ms MCP wait, ${keepalives} protocol keepalives, no polling`);
  } finally {
    await client.close();
    await handler.close();
    childRunner.stop();
    http.close();
    http.closeAllConnections();
  }
}

await Promise.all(['2025-03-26', '2025-06-18', '2026-07-28'].map(checkWait));
