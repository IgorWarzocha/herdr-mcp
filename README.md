# herdr-mcp

Let an AI agent read and send messages to [Herdr](https://github.com/herdrdev/herdr) terminal panes on your own machine.

herdr-mcp connects Grok Bot, Cursor cloud agents, Cursor desktop and other MCP clients to a running Herdr session. Ask your agent to list your agents, check their output, send a task or wait for a status change. You can follow work from a remote client without sitting at the terminal.

It is for people who already use Herdr and want to give an agent remote access. Your Herdr machine must stay awake and connected.

## SSH vs MCP

If you want to keep chatting with an agent while it works, SSH into the machine and use Herdr directly. If you want a remote agent to wait for a result before continuing its own task, use the MCP connection.

Coding tasks take minutes, not seconds. Each MCP wait lasts up to 90 seconds by default. If it returns `wait_timeout`, read the screen when looking for a reply: an answer can be visible while the agent is still working. If you still need the result, repeat the wait with the same timeout until it is ready or your overall deadline is reached. Otherwise, carry on with other work and check back later.

The wait limit is configurable for local clients or others that tolerate longer calls. Hosted clients can impose their own shorter deadline. See [client timeout settings](docs/clients.md#verify-discovery-and-long-waits).

## What you need

- **Herdr 0.9 or later**, with its server running.
- **Node.js 22 or later** on the same machine.
- **Linux, macOS or Windows.** Background setup uses systemd on Linux, launchd on macOS, or WSL2 with systemd on Windows. Native Windows can run the bridge in the foreground.
- **An MCP client that supports Streamable HTTP and a custom bearer-token header.** A client that requires OAuth without custom headers is not supported.
- **A connection route:**
  - **Tailscale Funnel:** a public HTTPS address without buying a domain. Requires a Tailscale account and permission to enable HTTPS and Funnel.
  - **Cloudflare Tunnel:** a public HTTPS address on a domain you manage through Cloudflare.
  - **Tailscale-only:** private access when the MCP client itself is on your tailnet. Having Tailscale on your laptop does not put a hosted agent's backend on it.

The agent will help you choose. You do not need both tunnel providers.

## Risks

**The token gives shell-equivalent access as the user running Herdr.** A connected agent can read what is on screen and type commands into panes. This is not a sandbox.

- A malicious prompt or document can steer an agent into using that access.
- Terminal output may contain passwords, keys or private work.
- Public tunnels make the endpoint reachable from the internet. The token protects access.
- A hosted client stores or handles your token. You are trusting that provider too.

Use a dedicated Herdr session for remote agents. For stronger separation, use a separate OS account without access to sensitive files. Keep the token out of chat, screenshots and committed files. If it leaks, revoke and replace it, then update your clients. Disable this bridge's tunnel route when you no longer need it, without disturbing other services.

## Ask your agent to set it up

Give a coding agent with terminal access to your Herdr machine this prompt:

> Read https://github.com/IgorWarzocha/herdr-mcp and follow its AGENTS.md setup flow. Inspect my environment first, explain what I need, and ask which tunnel and MCP client I want. Set it up with a check after each step. Stop for human-only actions, preserve existing services, and give me the connector settings without putting the token in chat.

The agent handles installation, service configuration, the selected tunnel and connection checks. **You handle account logins, administrator approvals, accepting the access risk and pasting the token into your client.** It will tell you when one of those steps is needed.

Once connected, ask:

> Read herdr_skill, then list my panes.

Sending a message confirms delivery, not that the agent has finished. Ask it to read the response afterwards. Waiting tracks agent state rather than a particular message.

For manual setup or troubleshooting, see the [setup flow](AGENTS.md), [platform recipes](docs/setup.md) and [usage and error guide](SKILL.md).

## Licence

[MIT](LICENSE) © Igor Warzocha
