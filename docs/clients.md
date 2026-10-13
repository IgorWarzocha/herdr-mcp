# Connect your client

Use the URL verified during setup. These examples use `https://herdr-mcp.example.com/mcp`. A Tailscale route instead ends in `/herdr-mcp`. The setup agent should substitute the real URL before handing over a template.

**HUMAN:** paste the existing token directly into the client's protected header field, or load it into the desktop client's environment. Never send it through chat. This server uses Streamable HTTP and a bearer header, not OAuth or the legacy SSE transport.

## Grok Bot remote connector

In the remote MCP connector form, use:

```text
Name: herdr
Transport: HTTP / Streamable HTTP
URL: https://herdr-mcp.example.com/mcp
Header name: Authorization
Header value: Bearer <PASTE_TOKEN_HERE>
```

The hosted backend must reach the URL. Tailscale running only on the device displaying Grok Bot does not provide that access. If the connector form cannot accept a custom header, it is not compatible with this bridge.

## Cursor cloud agents

Open the MCP dropdown at [cursor.com/agents](https://cursor.com/agents), add a personal custom **HTTP** server and enter:

```text
Name: herdr
URL: https://herdr-mcp.example.com/mcp
Headers: {"Authorization":"Bearer <PASTE_TOKEN_HERE>"}
```

Paste the token into the protected header field and enable the server. Do not use the desktop environment-variable template here. Cursor proxies HTTP MCP calls through its backend, not through the cloud agent's VM or your desktop. Its [cloud MCP documentation](https://cursor.com/docs/cloud-agent/capabilities) describes the encrypted header storage and team setup.

## Cursor desktop

Merge this entry into `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`. Preserve other servers:

```json
{
  "mcpServers": {
    "herdr": {
      "url": "https://herdr-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:HERDR_MCP_TOKEN}" }
    }
  }
}
```

**HUMAN:** make `HERDR_MCP_TOKEN` available to the Cursor process, then relaunch it if necessary. A variable exported in an unrelated terminal does not reach an already running GUI application. Keep the literal token out of this JSON. See Cursor's [MCP configuration guide](https://cursor.com/docs/mcp).

## Other MCP clients

Select Streamable HTTP and supply these connection values. Configuration key names vary by client, so this is a connection record, not a universal config-file format:

```json
{
  "url": "https://herdr-mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer <PASTE_TOKEN_HERE>" }
}
```

For a client that wants a bearer-token field rather than a header, enter only the token there. Do not add `Bearer` twice. Browser-based callers also need their exact origin allowed in the bridge's `HERDR_MCP_ORIGINS`. Server-side connectors do not.

## Verify discovery and long waits

Ask the connected agent to call `herdr_skill`, then `herdr` with `{"args":["pane","list"]}`. Both must succeed before calling setup complete.

For monitoring, prefer one long wait. The bridge allows ten minutes by default, set by `HERDR_MCP_WAIT_MAX` in milliseconds. Configure the client's **tool request timeout** above that, for example 620000 ms. In the TypeScript MCP SDK, pass `{ timeout: 620000 }` as the third argument to `client.callTool`. Its default is only 60000 ms.

Tool responses stream over HTTP with protocol-level keepalive comments every 15 seconds. These carry no model-visible messages and do not cost repeated tool calls. They protect against idle proxy timeouts, but cannot extend a client's hard deadline. This is streaming within Streamable HTTP, not the legacy SSE connector type.

Grok Bot and Cursor do not publish a ten-minute guarantee in the connector documentation checked here. Verify the selected client and tunnel with one wait on an existing working pane, using the desired duration and explicit target. Do not launch work or change a pane merely to test waiting without permission. If the client times out first, report that limit and ask the user to raise it or use a compatible client. Do not silently replace a long wait with a rapid polling loop. See [SKILL.md](../SKILL.md#watching-a-pane) for the monitoring pattern.
