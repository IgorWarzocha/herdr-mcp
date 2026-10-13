---
name: herdr-mcp-setup
description: Install, expose and connect herdr-mcp (a thin MCP bridge to the Herdr CLI) on a Linux machine running Herdr 0.9+, using a systemd user service and Tailscale Funnel on 443 under /herdr-mcp.
---

# herdr-mcp setup

Follow [AGENTS.md](AGENTS.md) step by step: preflight → install → token → systemd → Funnel → connect → e2e test. Each step has a verify command.

Key facts:
- Two tools only: `herdr_skill` (read first) and `herdr` (`args` array or quote-only `command`; verbs list/read/send/wait).
- Token: `npm run token` writes `~/.config/herdr-mcp/token` (0600). Clients send `Authorization: Bearer <token>`.
- Funnel: `tailscale funnel --bg --set-path /herdr-mcp http://127.0.0.1:8792/mcp`. Use 443, not 10000. **Never** `serve reset` or `funnel reset`.
- Service PATH must put Herdr 0.9+ first. A stale `/usr/bin/herdr` shadows `~/.local/bin` in non-interactive shells.
- `*.ts.net` resolving to `198.18.0.1` on a client: pin the real tailnet IP in `/etc/hosts`.
- HUMAN steps: enabling Funnel/HTTPS in the Tailscale admin console, and pasting the token into Grok Bot or Cursor.
- Security: the token gives shell-equivalent control of your panes. It's not a sandbox.
