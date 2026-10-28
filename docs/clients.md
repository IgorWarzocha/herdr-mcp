# Connect your client

Use the URL verified during setup. These examples use `https://herdr-mcp.example.com/mcp`. A Tailscale route instead ends in `/herdr-mcp`. The setup agent should substitute the real URL before handing over a template.

**Supported MCP revisions: 2025-03-26, 2025-06-18 and 2026-07-28 over Streamable HTTP.** A 2025 client's `initialize` request receives its requested version when supported. The official SDK handles negotiation. The 2026 protocol uses `server/discover` and supports push subscriptions. These MCP client revisions are independent of the requirement to run current Herdr.

**HUMAN:** paste the existing token directly into the client's protected header field, or load it into the desktop client's environment. Never send it through chat. This server uses a bearer header, not OAuth.

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

Ordinary tools and waits work with all three supported revisions. Push requires MCP 2026-07-28 and notification handling beyond tool discovery. With SDK v2, select `versionNegotiation: { mode: { pin: '2026-07-28' } }` when constructing a push client. See [push clients](push.md). Grok Bot and Cursor notification delivery into model turns has not been verified.

The endpoint is stateless and POST-only. A standalone GET receives 405 by design; a successful Streamable HTTP initialization does not need that GET stream. The deployment gate checks both 2025 initialization versions and subsequent tool calls before restarting.

Ask the connected agent to call `herdr_skill`, then `herdr` with `{"args":["pane","list"]}`. Both must succeed before calling setup complete.

Each wait allows 90 seconds by default; tool discovery reports the configured ceiling for this bridge. On `wait_timeout`, read with `--source visible` if looking for a reply, even when state is still working. If the result is still needed, call `wait` again with the same target, condition and timeout until it is ready or the user's overall deadline is reached. Do not resend the task.

`HERDR_MCP_WAIT_MAX` sets the bridge ceiling in milliseconds, default `90000`. Configure the client's **tool request timeout** above that budget, allowing for cleanup and the final state check. With SDK v2, pass `{ timeout: 100000 }` as the second argument to `client.callTool(params, options)`. Its default is only 60000 ms. For a local or long-tolerant client, `HERDR_MCP_WAIT_MAX=600000` still permits ten-minute waits, provided the client timeout is longer, such as 620000 ms.

Tool responses stream over HTTP with protocol-level keepalive comments every 15 seconds. These carry no model-visible messages and do not cost repeated tool calls. They protect against idle proxy timeouts, but cannot extend a client's hard deadline. This is streaming within Streamable HTTP, not the legacy SSE connector type.

Earlier Grok Bot testing accepted a 90-second wait and a call that returned at 99 seconds, but rejected 300 seconds with MCP `-32001`. A later connection report found that 75 seconds failed at the gateway while approximately 25 seconds worked. Neither observation establishes a universal hosted-client deadline.

For a connection with that shorter limit, tell its agent to use this on every wait, substituting the actual pane ID:

```json
{"args":["wait","w1:p1","--timeout","25000"]}
```

This per-call setting needs no service restart and leaves other clients unchanged. Allow up to four additional seconds for cleanup and a state check. If every client of a bridge needs the lower ceiling, set `HERDR_MCP_WAIT_MAX=25000` in its service environment and restart only with deployment approval. The setting is bridge-wide, not per connector.

Verify the selected client and tunnel on an existing working pane with an explicit target. Do not launch work or change a pane merely to test waiting without permission. A gateway timeout calls for a shorter wait or a longer client deadline, not another prompt. See [SKILL.md](../SKILL.md#watching-a-pane) for the monitoring pattern.
