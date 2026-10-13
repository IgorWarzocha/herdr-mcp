# Bridge boundaries

Run `npm ci` to install dependencies and `npm run check` for syntax checks and tests. Tests use temporary files and isolated HTTP listeners. They must not use a deployed bridge, real token or tunnel.

`npm run check:long-wait` is a separate 65-second smoke check through the real HTTP and MCP SDK transport. It runs one harmless Node subprocess instead of Herdr and verifies keepalives plus completion beyond both the ordinary 25-second limit and the SDK's default 60 seconds. It does not establish hosted-client deadlines. The selected client and tunnel still need the setup check.

The MCP surface has two tools: `herdr_skill` reads the installed CLI guide, and `herdr` passes validated arguments to the pinned local Herdr server. Friendly list/read/send/wait verbs normalise into CLI arguments. No shell parses the command. Use `args` for literal paths, especially Windows backslashes.

The bridge fixes the session through `HERDR_MCP_SOCKET` or `HERDR_SOCKET_PATH`. It rejects session and machine routing, maintenance commands, bare TUI launch and API schema file output. These guards are not a sandbox. A token holder can still execute shell commands through a pane.

The subprocess environment excludes caller pane identity and secrets. Windows keeps the loader and profile variables needed to launch a native executable. Token content is validated on every OS. POSIX also enforces private mode bits and ownership. Native Windows ACLs remain the operator's responsibility.

## Results and timeouts

`src/errors.mjs` owns the public `code`, `message` and `next` recovery envelope. Known CLI errors are classified from Herdr's stderr JSON `error.code`, only on failure. Successful terminal text must never be interpreted as a bridge error. Unknown diagnostics and exception messages are not sent to clients. Existing exit, signal, timeout and truncation fields remain available. Partial successful output survives truncation. Failed-command diagnostic streams are replaced with the short message, not a backtrace.

Ordinary subprocesses have a 25-second watchdog. Only `agent wait` and `pane wait-output`, including the friendly `wait` alias, get the longer budget. `HERDR_MCP_WAIT_MAX` is a positive integer in milliseconds, default 90000. Longer ceilings remain available for clients that support them. The CLI's requested `--timeout` is capped there. A watchdog allows another two seconds for CLI cleanup, and an expired wait can take up to two more seconds to fetch current agent state. A failed state probe is explicit, never interpreted as working or complete. `agent prompt --wait` and raw `api` calls retain the ordinary limit because they can include mutations.

Calls are bounded to 128 KiB combined output and four subprocesses. HTTP accepts at most 128 KiB per body, 16 active requests and 64 connections. The Node request and header timeouts bound receiving a request, not waiting for its response. Tool responses use the SDK's Streamable HTTP SSE mode with its supported 15-second keepalive setting. No SDK code is patched. Client hard deadlines still apply, including the TypeScript SDK's default 60 seconds. See [client setup](clients.md#verify-discovery-and-long-waits).

When the HTTP client disconnects, the response's close event aborts the command signal. The runner terminates the wait subprocess and releases its slot. This cancels the observation, not the agent working in the pane. If a client or proxy reports a timeout without closing its connection to the bridge, the bridge's own deadline still bounds the wait.

Cancelling or timing out a call does not roll back input already sent to a pane. No transcript or durable notification queue is kept. Do not retry a mutation merely to retrieve lost output.
