# Connect ChatGPT with OAuth

OAuth is optional. Existing bearer-token clients keep working. MCP calls always require authentication.

The OAuth connection has the same shell-equivalent authority as the bridge token, including configured remote machines. Approve only a connection you started.

## Configure the bridge

Set these in the service environment, using your verified public URL:

```sh
HERDR_MCP_PUBLIC_URL=https://your-host.example/herdr-mcp
HERDR_MCP_OAUTH_CLIENT_ID=herdr-chatgpt
HERDR_MCP_OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect
```

If ChatGPT displays a connection-specific callback, add that exact URL to the comma-separated redirect list. Wildcard callbacks are not supported. The fixed client uses token-endpoint authentication method `none`, with mandatory PKCE S256 and operator approval. This does not permit anonymous MCP access. No client secret is needed.

OAuth state defaults to `~/.config/herdr-mcp/oauth.json`. Override it with an absolute `HERDR_MCP_OAUTH_STATE_FILE` path. On POSIX, the file must be owned by the service user with mode `0600`, inside an owned `0700` directory. Only token hashes are persisted. On Windows, protect the directory with private ACLs.

Expose authorization-server metadata at the RFC 8414 URL. For the example above, route `https://your-host.example/.well-known/oauth-authorization-server/herdr-mcp` to this service's `/mcp/oauth/metadata`. Keep existing proxy routes intact. The bridge's authentication challenge points directly to protected-resource metadata under `/herdr-mcp/oauth/resource`.

Run the [gated restart](development.md) after configuring the service and proxy.

## Add the connection

1. In ChatGPT's plugin directory, choose **Add → Add custom MCP server**.
2. Enter the verified public URL and select **OAuth**.
3. In advanced OAuth settings, use **User-Defined OAuth Client**, client ID `herdr-chatgpt`, token-endpoint authentication `none`, and scope `mcp`. Leave the client secret empty. Verify the displayed callback matches a registered URI.
4. Create the plugin and start its connection flow.
5. The Herdr approval page shows the callback and a request-specific command. Run `npm run oauth -- approve <request-ID>` from the bridge checkout on its host. The command reads the existing bridge credential privately. Never paste that credential into ChatGPT or the approval page.

The browser continues automatically after approval. Approval requests expire after five minutes and belong to the browser that started them.

Operator commands need the service's host, port and token-file settings. On Linux, load its existing environment file in a subshell so overrides replace interactive shell values:

```sh
(set -a; . ~/.config/herdr-mcp/service.env; npm run oauth -- approve <request-ID>)
```

Use the same environment for `npm run oauth -- revoke`. On other supervisors, provide the matching `HERDR_MCP_HOST`, `HERDR_MCP_PORT` or `PORT`, and `HERDR_MCP_TOKEN_FILE` settings. Do not print the environment or credential contents.

Access tokens last one hour and refresh automatically. Refresh tokens rotate on use and expire after 30 days without a refresh. Restarting the bridge preserves authorised connections. To revoke all OAuth connections, run `npm run oauth -- revoke` on the bridge host. This leaves the existing bearer token unchanged.

The bridge supports one fixed public OAuth client. It does not offer dynamic client registration, OIDC login or arbitrary third-party token forwarding.
