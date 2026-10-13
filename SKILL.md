---
name: herdr-mcp-setup
description: "Use when installing or connecting herdr-mcp so hosted agents can control Herdr on Linux, macOS or Windows."
---

Follow [AGENTS.md](AGENTS.md) step by step: preflight, install, token, OS-specific service, tunnel, connect, end-to-end test. Use [README.md](README.md#keep-the-bridge-running) for service recipes. Stop when verification fails.

Herdr runs on Linux, macOS and native Windows. Use systemd on Linux, the shipped launchd plist on macOS, or WSL2 with systemd for the Windows background setup. Native Windows foreground setup is also in the README. Keep Herdr, Node and the bridge in the same OS environment. A WSL bridge cannot control native Windows Herdr through its local socket.

Key facts:
- Two tools only: `herdr_skill` (read first) and `herdr` (`args` array or quote-only `command`; verbs list/read/send/wait).
- Token: `npm run token` prints its path, not its contents. The default is under `~/.config` on Linux/macOS/WSL and `%APPDATA%` on Windows. `XDG_CONFIG_HOME` and `HERDR_MCP_TOKEN_FILE` can override it. POSIX enforces private permissions and ownership. Windows needs private NTFS ACLs, which the bridge does not validate. Clients send `Authorization: Bearer <token>`.
- Funnel: `tailscale funnel --bg --set-path /herdr-mcp http://127.0.0.1:8792/mcp`. Use 443, not 10000. **Never** `serve reset` or `funnel reset`.
- Service PATH must put Herdr 0.9+ first and use real binary paths, not version-manager shims. launchd settings live in the plist, not `service.env`.
- launchd's user agent needs a logged-in session. WSL needs its distribution kept running. Neither recipe prevents machine sleep.
- `*.ts.net` resolving to `198.18.0.1` on a client: investigate that client's DNS or proxy. Ask before modifying system hosts files.
- HUMAN steps: enabling Funnel/HTTPS in the Tailscale admin console, and pasting the token into Grok Bot or Cursor.
- Security: the token gives shell-equivalent control of your panes; prompt injection can steer a hosted agent into using it. Not a sandbox. Recommend a dedicated Herdr session and turning Funnel off when idle.
- Unfamiliar system? Use the Quirks table (Q1-Q15) at the end of AGENTS.md. Stop and ask the human for logins, admin consoles, sudo and token pasting.
