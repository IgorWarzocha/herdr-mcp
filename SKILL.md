---
name: herdr-mcp-setup
description: "Use when setting up herdr-mcp or operating Herdr through its MCP tools."
---

For installation, follow [SETUP.md](SETUP.md): inspect, explain requirements, ask which tunnel and client, then verify each setup step. Platform recipes are in [docs/setup.md](docs/setup.md), and connector templates in [docs/clients.md](docs/clients.md). Stop when verification fails.

Herdr runs on Linux, macOS and native Windows. Use systemd on Linux, the shipped launchd plist on macOS, or WSL2 with systemd for the Windows background setup. Native Windows foreground setup is in docs/setup.md. Keep Herdr, Node and the bridge in the same OS environment. A WSL bridge cannot control native Windows Herdr through its local socket.

The token gives shell-equivalent access. Recommend a dedicated Herdr session. **HUMAN:** accept the risks, complete provider logins and administrator approvals, and paste the existing token into the client. Never put it into chat or tracked files. Never run Serve/Funnel reset or alter another service's route or port exposure. Use SETUP.md's Quirks table for setup failures.

## Day-to-day use

Call `herdr_skill` once to read the installed CLI guide. Then use `herdr` with an `args` array:

```json
{"args":["list"]}
{"args":["read","w1:p1","--lines","80"]}
{"args":["send","w1:p1","Review the current changes"]}
{"args":["wait","w1:p1"]}
```

`list` includes all panes, including shells. Match the user's name against `workspace_label`, `tab_label`, `name` and `terminal_title`, then use the returned `pane_id`. A tab label is not an agent name. Duplicate labels remain separate panes: ask if the intended target is ambiguous. Raw `agent list`, `pane list`, `tab list` and `workspace list` retain the CLI's own output.

`send` acknowledges delivery, not that the turn started or finished. Do not resend merely because status has not changed. The bridge pins the session: machine discovery (`machine list`), machine routing and session switching are disabled. Do not use `--current` or `--session`.

Use `agent get <target>` for reported status. A list drawn inside a pane is just terminal content and may be stale or describe a different agent.

### Reading a working agent

Use `read <pane-id> --source visible` for the current screen. It is not a transcript; requesting more lines does not recover unavailable history. The pane-ID `read` alias uses `pane read`.

On Herdr 0.9.4, `agent read <target> --lines 200` can return `agent_not_idle` while Pi is working: capturing its alternate-screen history requires scrolling while idle. Use `--source visible` to inspect the screen without that capture, or wait until idle and retry the original read. The bridge does not silently substitute screen output for requested history.

## Watching a pane

If the client supports MCP 2026-07-28 subscriptions, subscribe to `herdr://panes` and re-read that resource on `notifications/resources/updated`. Read once after subscribing or reconnecting too. Updates cover names and reported state, not terminal transcripts or per-message completion. Only use push instead of waiting when the client actually delivers notifications to your workflow. See [push clients](docs/push.md). Otherwise use the wait loop below.

The default wait ceiling is 90 seconds. A wait returns earlier when Herdr matches idle, done or blocked. The `herdr` tool description carries the blocking-call guidance. The separate `herdr_skill` tool returns the installed Herdr guide unchanged.

- On `ok`, inspect Herdr's returned state and read the output. Blocked means the agent needs attention, not that it finished.
- On `wait_timeout` with `state: working`, the wait expired without a match. If looking for a reply, read with `--source visible`: an answer may already be on screen while the agent continues working. If the result is still needed, continue the wait loop with the same target, condition and timeout rather than resending the task.
- On `wait_timeout` with idle, done or blocked, read the pane because state may have changed at the deadline. With unknown state or `state_error`, inspect using `list` or `read` and follow the reported recovery advice.
- Stop waiting when the user's overall deadline is reached. `elapsed_ms` measures this bridge call, not the age of the agent's task.

`HERDR_MCP_WAIT_MAX` sets the ceiling in milliseconds, default `90000`. It applies only to `wait`, raw `agent wait` and `pane wait-output`. A supplied `--timeout` is capped at that ceiling. Higher values remain available for local or long-tolerant clients. Ordinary commands, including `agent prompt --wait`, retain the 25-second watchdog. Use send followed by separate waits when you need the reply.

The client must allow a request to last longer than the wait budget, including up to four seconds for cleanup and the state check. [Client timeout guidance](docs/clients.md#verify-discovery-and-long-waits) explains the 15-second protocol keepalives and the SDK's shorter default. Keepalives do not add model turns or extend hard client deadlines. If a gateway cuts off longer waits but accepts 25 seconds, use `wait <target> --timeout 25000` on every iteration. This needs no service restart and does not change other clients' budgets. An approved deployment change can instead lower `HERDR_MCP_WAIT_MAX` for all clients of that bridge.

Waits track state, not individual message turns. `pane wait-output` searches existing output too. Neither proves that the most recent prompt has completed.

## Status and recovery

`herdr` returns JSON with `code`. Failures add `message` and `next`, with no exception stack or raw CLI failure dump. `herdr_skill` uses the same failure envelope. `wait_timeout` is a normal non-error wait result. Other non-`ok` codes set MCP `isError`. `bad_token` is an HTTP 401 response before a tool can run.

| Code | What to do next | Ask the user? |
|---|---|---|
| `herdr_not_running` | Start Herdr or check the bridge's pinned socket. A dead socket does not prove the session was deleted. | Yes |
| `session_missing` | Restore the intended session or correct the configured socket. Used only when Herdr explicitly reports a missing session. | Yes |
| `pane_not_found` | Refresh `list` or `pane list` and choose the intended current ID. | If the target is absent or ambiguous |
| `agent_not_idle` | Read with `--source visible`, or wait until idle before retrying history capture. | No |
| `bad_token` | Copy the existing token into the client's bearer header. Do not rotate it automatically. | Yes, private client entry only |
| `wait_timeout` | Check state; read visible output if looking for a reply, even while working. Repeat the wait if the result is still needed. | Only for a blocker or overall deadline |
| `timeout` | Read before retrying input. The command may already have taken effect. | If its outcome remains unclear |
| `truncated` | Use fewer `--lines` or a narrower source. For an oversized skill, use subcommand `--help`. Never resend input to recover output. | Usually no |
| `invalid_arguments` | Follow `next`, or read the guide and subcommand `--help`, then correct the call. | Usually no |
| `busy` | Wait for an active call to finish, then retry. No command started. | No |
| `cancelled` | Inspect before retrying. Cancellation is not rollback. | If mutation outcome is unclear |
| `herdr_unavailable` | Check the executable, service PATH and permissions, then run doctor locally. | Yes |
| `command_failed` | Check CLI help. If needed, run locally for full diagnostics. | If it persists |
| `bridge_error` | Inspect the target, then check the bridge with doctor. | If it persists |

Exit and timeout flags remain available. `truncated: true` marks omitted output, and partial successful output is retained. The bridge stores no full transcript. Successful pane text is unmodified and can itself contain application errors or stack traces. Do not confuse those with bridge failures.
