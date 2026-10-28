import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Client revisions used in production are an explicit deployment contract.
// Keep them independent of the server's list so removing one fails the gate.
export async function checkProtocols(url, token) {
  for (const version of ['2025-03-26', '2025-06-18', '2026-07-28']) {
    const modern = version === '2026-07-28';
    const client = new Client({ name: 'herdr-protocol-smoke', version: '1' }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: modern ? { pin: version } : 'legacy' },
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      assert.equal(client.getServerCapabilities().resources.subscribe, modern);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['herdr_skill', 'herdr']);
      const skill = await client.callTool({ name: 'herdr_skill', arguments: {} });
      assert.notEqual(skill.isError, true);
      const response = await client.callTool({ name: 'herdr', arguments: { args: ['list'] } });
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.code, 'ok', result.next);
      assert.ok(Array.isArray(JSON.parse(result.stdout).panes));
      console.log(`ok: MCP ${version}, ${modern ? 'discovery' : 'initialize'}, herdr_skill and pane discovery`);
    } finally { await client.close(); }
  }
}
