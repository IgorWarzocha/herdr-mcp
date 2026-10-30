---
name: herdr-mcp-setup
description: "Use when setting up herdr-mcp or operating Herdr through its MCP tools."
---

For installation, follow [SETUP.md](SETUP.md): inspect, explain requirements, ask which tunnel and client, then verify each setup step. Platform recipes are in [docs/setup.md](docs/setup.md), and connector templates in [docs/clients.md](docs/clients.md). Stop when verification fails.

Herdr TUI and Core are separate runtimes. The bridge supports both at once or either alone. It needs TUI 0.9.5+ or Core (`hc`) 0.1.14+ on its service PATH. Herdr TUI runs on Linux, macOS and native Windows. Use systemd on Linux, the shipped launchd plist on macOS, or WSL2 with systemd for the Windows background setup. Native Windows foreground setup is in docs/setup.md. Keep each runtime, Node and the bridge in the same OS environment. A WSL bridge cannot control native Windows Herdr through its local socket.

The token gives shell-equivalent access. Recommend a dedicated Herdr session. **HUMAN:** accept the risks, complete provider logins and administrator approvals, and paste the existing token into the client. Never put it into chat or tracked files. Never run Serve/Funnel reset or alter another service's route or port exposure. Use SETUP.md's Quirks table for setup failures.

## Day-to-day use

Call `herdr_skill` once to read the unified bridge guide. Then use `herdr` with an `args` array or a quoted `command` string:

```json
{"args":["list"]}
{"args":["read","w1:p1","--lines","80"]}
{"args":["send","w1:p1","Review the current changes"]}
{"args":["wait","w1:p1"]}
{"args":["reply","w1:p1"]}
{"args":["spawn","--name","review","--cwd","/absolute/project","--","pi"]}
{"args":["get","core:t1"]}
{"args":["close","core:t1"]}
```

`list` merges local TUI panes and Core terminals. TUI IDs stay unchanged. Core IDs use `core:tN`. Friendly commands resolve IDs, agent names and unique reported labels across both runtimes. Duplicate labels require an explicit ID. If a runtime is offline, `list` reports it in `unavailable` and name resolution fails closed. Choose a known explicit ID on the available runtime. No input is sent on ambiguity. A known Core ID can address a retained finished terminal even after it leaves the live list.

`spawn [--name NAME] [--cwd /absolute/path] -- <program> [arguments...]` prefers Core whenever its binary is installed, even if its backend is unavailable. Failed Core spawns never create a TUI pane instead. Without Core, spawn supports TUI agent executables such as `pi`, `claude` and `codex`, not arbitrary programs. Names accept 1 to 32 lowercase letters, digits, underscores or hyphens. Spawn acknowledges launch, not task completion. Pass startup arguments to the program, then inspect readiness before sending input. Core template launches include `first_message.sent` when Core handles task delivery. If false, the program exists but its task was not delivered. `close` stops the selected target.

Existing targets stay on their owning runtime. Raw TUI commands remain available when TUI is installed, with TUI syntax for commands outside the unified verbs. There is no raw Core CLI pass-through.

`send` submits input to a Core program, prompts a TUI agent or runs the text in an available TUI shell pane. It acknowledges delivery, not that the turn started or finished. Do not resend merely because status has not changed. The bridge pins each local runtime. Machine discovery (`machine list`), machine routing and session switching through tool arguments are disabled. Core `hc ls` may contact configured remote machines, but remote rows are filtered out and the adapter cannot route mutations to them. Do not use `--current` or `--session`. On TUI, a payload consisting solely of a routing flag such as `--session=other` is rejected because Herdr would interpret it as routing rather than text.

Use `get <target>` for reported status. An unknown status is not completion. The bridge does not infer agent state from terminal text. A list drawn inside a pane is just terminal content and may be stale or describe a different agent.

### Reading a working agent

`read <target>` defaults to `recent-unwrapped`. Use `--source visible` for the current screen. Neither guarantees a full transcript; requesting more lines does not recover unavailable history.

Core reads mark incomplete capture with `truncated: true` and report the capture method and any reason. They do not promise a full transcript.

TUI terminal history capture can return `agent_not_idle` while an agent is working. Use `--source visible` to inspect the screen, or wait until idle and retry the history read. Requested history is never silently replaced with screen output.

### Clean Pi replies

Use `reply <target>` for Pi's latest completed assistant text, without terminal wrapping or borders. The bridge follows the exact reported session path and returns text blocks only, never reasoning or tool payloads. It does not search other sessions by working directory. Core requires `get` to report `status.app: pi` and `labels['pi.session_file']`. Our Pi integration supplies that label. It is not a Core guarantee for every Pi installation.

The result identifies `message_id`, `agent_status` and `newer_activity`. It is the latest completed reply on the **last persisted branch**, not proof the current task has finished. Pi can switch its live branch before writing another record. Failed, aborted or still-working turns may leave an older completed reply as the latest available one.

Long replies are paged. When `next_offset` is not null, call `reply <target> --offset <next_offset> --message-id <message_id>`. Offsets count Unicode characters. `--limit` accepts 1 to 30000 characters, default 16000. A changed latest message rejects continuation rather than mixing replies. `reply_unavailable` means no reliable completed reply could be read.

## Watching a pane

If the client supports MCP 2026-07-28 subscriptions, subscribe to `herdr://panes` and re-read that resource on `notifications/resources/updated`. Read once after subscribing or reconnecting too. Updates cover names and reported state, not terminal transcripts or per-message completion. Only use push instead of waiting when the client actually delivers notifications to your workflow. See [push clients](docs/push.md). Otherwise use the wait loop below.

The default wait ceiling is 90 seconds. TUI agent waits return earlier on idle, done or blocked. A TUI shell wait returns when its shell is the foreground process again. Core waits use reported agent status when available. Without status, they wait for program exit, not an inferred idle state.

`wait <target> --match <text>` waits for terminal output. Core watches only new output after the wait begins. TUI output waits can match existing output too. Regular expressions are TUI-only and are never translated into Core text matches.

- On `ok`, inspect Herdr's returned state and read the output. Blocked means the agent needs attention, not that it finished.
- On `wait_timeout` with `state: working`, the wait expired without a match. If looking for a reply, read with `--source visible`: an answer may already be on screen while the agent continues working. If the result is still needed, continue the wait loop with the same target, condition and timeout rather than resending the task.
- On `wait_timeout` with idle, done or blocked, read the pane because state may have changed at the deadline. With unknown state or `state_error`, inspect using `list` or `read` and follow the reported recovery advice.
- Stop waiting when the user's overall deadline is reached. `elapsed_ms` measures this bridge call, not the age of the agent's task.

`HERDR_MCP_WAIT_MAX` sets the ceiling in milliseconds, default `90000`. It applies only to `wait`, raw `agent wait` and `pane wait-output`. A supplied `--timeout` is capped at that ceiling. Higher values remain available for local or long-tolerant clients. Ordinary commands, including `agent prompt --wait`, retain the 25-second watchdog. Use send followed by separate waits when you need the reply.

The client must allow a request to last longer than the wait budget, including up to four seconds for cleanup and the state check. [Client timeout guidance](docs/clients.md#verify-discovery-and-long-waits) explains the 15-second protocol keepalives and the SDK's shorter default. Keepalives do not add model turns or extend hard client deadlines. If a gateway cuts off longer waits but accepts 25 seconds, use `wait <target> --timeout 25000` on every iteration. This needs no service restart and does not change other clients' budgets. An approved deployment change can instead lower `HERDR_MCP_WAIT_MAX` for all clients of that bridge.

Waits track reported state or process exit, not individual message turns. An output match does not prove that the most recent prompt has completed.

## Status and recovery

`herdr` returns JSON with `code`. Failures add `message` and `next`, with no exception stack or raw CLI failure dump. `herdr_skill` uses the same failure envelope. `wait_timeout` is a normal non-error wait result. Other non-`ok` codes set MCP `isError`. `bad_token` is an HTTP 401 response before a tool can run.

| Code | What to do next | Ask the user? |
|---|---|---|
| `runtime_unavailable` | Check the reported backend and its pinned settings. Use an explicit known ID on the available backend, not a name. Never retry a mutation on the other runtime. | If configuration or service intervention is needed |
| `target_blocked` | Inspect the target and resolve the reported block before sending more input. | If intervention is needed |
| `target_finished` | Read the final output. Do not send to an exited program. | If new work is needed |
| `herdr_not_running` | Start Herdr or check the bridge's pinned socket. A dead socket does not prove the session was deleted. | Yes |
| `session_missing` | Restore the intended session or correct the configured socket. Used only when Herdr explicitly reports a missing session. | Yes |
| `pane_not_found` | Refresh `list` or `pane list` and choose the intended current ID. | If the target is absent or ambiguous |
| `ambiguous_target` | Choose the intended pane ID from the returned candidates. No input was sent. | If intent is unclear |
| `target_busy` | Wait for the shell's foreground command to finish or inspect the pane. No input was sent. | If intervention is needed |
| `reply_unavailable` | Follow `next`. Pi may not have saved a completed reply, or its session identity may be unavailable. | If it persists |
| `agent_not_idle` | Read with `--source visible`, or wait until idle before retrying history capture. | No |
| `bad_token` | Copy the existing token into the client's bearer header. Do not rotate it automatically. | Yes, private client entry only |
| `wait_timeout` | Check state; read visible output if looking for a reply, even while working. Repeat the wait if the result is still needed. | Only for a blocker or overall deadline |
| `timeout` | Read before retrying input. The command may already have taken effect. | If its outcome remains unclear |
| `truncated` | Use fewer `--lines` or a narrower source. For raw TUI command syntax, use subcommand `--help`. Never resend input to recover output. | Usually no |
| `invalid_arguments` | Follow `next`, or read the guide and subcommand `--help`, then correct the call. | Usually no |
| `busy` | Wait for an active call to finish, then retry. No command started. | No |
| `cancelled` | Inspect before retrying. Cancellation is not rollback. | If mutation outcome is unclear |
| `herdr_unavailable` | Check the executable, service PATH and permissions, then run doctor locally. | Yes |
| `command_failed` | Check CLI help. If needed, run locally for full diagnostics. | If it persists |
| `bridge_error` | Inspect the target, then check the bridge with doctor. | If it persists |

Exit and timeout flags remain available. `truncated: true` marks omitted output, and partial successful output is retained. The bridge stores no full transcript. Successful pane text is unmodified and can itself contain application errors or stack traces. Do not confuse those with bridge failures.
