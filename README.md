# herdr-mcp

Let ChatGPT, Grok Bot or another compatible assistant work with agents running on your own always-on machines.

herdr-mcp connects your AI client to [Herdr Core](https://github.com/herdrdev/herdr-core), [Herdr TUI](https://github.com/herdrdev/herdr), or both. From a chat, you can:

- Find your running agents and see what they are doing.
- Send a task, wait for it and read the result.
- Start a new program on a chosen machine.
- Read completed Pi replies without terminal borders or wrapped lines.

One MCP connection can reach the remote machines already configured in Core, using the same machine catalogue as Shepherdr. You do not need a separate MCP endpoint on every machine. Your machines must stay awake and connected.

## Have your agent set it up

**This gives the connected client shell-equivalent access, including Core's configured remote machines.** It can launch programs and submit commands. This is not a sandbox. Only connect clients you trust, and consider a dedicated runtime session or OS account for separation.

Give an agent with terminal or SSH access to the machine hosting Herdr this prompt:

> Read https://github.com/IgorWarzocha/herdr-mcp/blob/main/SETUP.md and set up herdr-mcp for me. Inspect my environment first, explain the requirements and access risk, and help me choose a compatible client and connection route. Install and configure it, preserve existing services, and verify the selected client can list my agents and read output. Stop for account logins or administrator approvals. Keep credentials out of chat and tracked files.

Your agent handles installation, the background service, connection settings and checks. You handle account logins, administrator approvals and the decision to grant access. You do not need to write code.

For **ChatGPT**, the agent configures OAuth and approves the connection from the bridge host. Your bridge credential never goes into ChatGPT or its browser form. Access tokens refresh automatically; reapproval is needed after 30 days without a refresh, or after revocation. See [ChatGPT setup](docs/oauth.md).

For **Grok Bot and other bearer-token clients**, put the existing token directly into the client's protected credential field. Never paste it into a chat. [Client instructions](docs/clients.md) cover ChatGPT, Grok Bot and Cursor. Other clients need compatible remote MCP and authentication support.

## What you need

- **A Linux, macOS or Windows machine** with Herdr Core 0.1.14+ or Herdr TUI 0.9.5+, and Node.js 26.12.1+. TUI also needs Pi available for the deployment check. Your setup agent checks these prerequisites before proceeding.
- **A compatible MCP client** using Streamable HTTP with OAuth or a bearer header. ChatGPT and Grok Bot have been tested live.
- **An HTTPS connection route.** Hosted clients such as ChatGPT and Grok Bot need a publicly reachable endpoint. Tailscale Funnel can provide one without buying a domain; Cloudflare Tunnel uses a domain you manage. Private Tailscale access works only when the actual MCP client is on your tailnet, not merely the laptop displaying its chat.

Background setup uses systemd on Linux, launchd on macOS, or WSL2 with systemd on Windows. Native Windows can run the bridge in the foreground. Your agent can help choose the route and install missing prerequisites with your approval.

## Use it from a chat

Once connected, try:

> Read herdr_skill, then show my running agents.

Then ask it to send a task to a specific agent, check output, or start a program on a named machine. Names and new programs default to the local machine. Remote commands use `--machine <name-or-ID>`; the control guide explains the syntax.

Sending a task confirms delivery, not completion. Ask the client to wait and read the result. A wait can time out while the agent keeps working; that is not a reason to send the task again. Hosted clients may have shorter time limits than the bridge. See [wait behaviour](docs/clients.md#verify-discovery-and-long-waits).

Modern clients can receive [directory-change notifications](docs/push.md). These do not guarantee that a client wakes up or starts another model turn. ChatGPT's separate MCP Events webhook integration is not implemented here.

## Manual setup and troubleshooting

Follow [SETUP.md](SETUP.md) for the ordered setup, [platform recipes](docs/setup.md) for service commands, and [SKILL.md](SKILL.md) for control commands and recovery.

Terminal output can contain private information, and malicious prompts can steer an agent into misusing its access. Keep credentials out of chat, screenshots and committed files. If a bearer token leaks, replace it and update its clients. OAuth connections can be revoked separately. Remove only this bridge's public route when you no longer need it, preserving other services.

## Licence

[MIT](LICENSE) © Igor Warzocha
