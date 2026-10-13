---
name: herdr-mcp-setup
description: Install, expose and connect herdr-mcp (a thin MCP bridge to the Herdr CLI) so hosted agents (Cursor cloud agents, Grok Bot, Muse, OpenClaw) can drive Herdr on the user's own Linux machine (macOS untested) with Herdr 0.9+ and Node 22+, using a systemd user service and Tailscale Funnel on 443 under /herdr-mcp.
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
- Security: the token gives shell-equivalent control of your panes; prompt injection can steer a hosted agent into using it. Not a sandbox. Recommend a dedicated Herdr session and turning Funnel off when idle.
- Unfamiliar system? Use the Quirks table (Q1-Q15) at the end of AGENTS.md. Stop and ask the human for logins, admin consoles, sudo and token pasting.
