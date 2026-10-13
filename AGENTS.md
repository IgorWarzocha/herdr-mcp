herdr-mcp lets hosted agents (Cursor cloud agents, Grok Bot, Muse, OpenClaw, any remote MCP client) drive Herdr on this machine. The token is shell access; read the README "Risks" section and make sure the human has too.

When asked to install herdr-mcp, do the steps in order on the machine that runs Herdr. Inspect an existing installation before changing it. Stop and report if a verify fails. Steps marked **HUMAN** need the user. Repository development does not authorise changing a live installation.

Hard rules:
- Never run `tailscale serve reset` or `tailscale funnel reset`, and never `funnel off` a path you didn't create. Other services share the node.
- Never print the token into chat or commit it. Refer to its path, and only reveal it when the user asks to paste it into a client.
- Don't modify existing Funnel/Serve handlers. Only add `/herdr-mcp`.
- Keep Herdr and the bridge in the same OS environment and user context. Herdr supports Linux, macOS and native Windows. WSL2 is the documented Windows background-service route, not a requirement of Herdr.

Run the commands in **Bash** on Linux, macOS or inside WSL2. They are not PowerShell snippets. For native Windows foreground use, follow the README's PowerShell recipe and use NTFS ACLs instead of `chmod`. Set these variables once and keep them for every step:
```sh
REPO=~/herdr-mcp PORT=8792          # if PORT is taken, pick another and use it everywhere
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-mcp/token"
export PORT HERDR_MCP_TOKEN_FILE="$TOKEN_FILE"
```
For a custom socket, export `HERDR_MCP_SOCKET` too. Carry the same values into the service configuration.

**Trial run / second instance:** use a temporary checkout, a spare `PORT` such as 18800 and a token inside that checkout. Run `npm start` in the foreground instead of step 3's service installation. Skip step 4 and test step 6 against `http://127.0.0.1:$PORT/mcp`. Stop only your trial process and remove only its temporary directory. Do not reuse an existing token or service.

## 0. Preflight
```sh
node -p 'process.platform + " " + process.version'   # Node >= 22
command -v node                           # resolve version-manager shims (Q2)
type -a herdr                             # inspect all PATH candidates (Q3)
herdr --version                           # need >= 0.9
node -e 'const s=require("node:net").createServer(); s.once("error",e=>{console.error(e.code);process.exitCode=1}); s.listen(Number(process.env.PORT||8792),"127.0.0.1",()=>{console.log("port free");s.close()})'
tailscale status --self | head -1         # logged in? (Q6)
tailscale funnel status                   # record existing handlers; do not change them (Q9)
env | grep -i _proxy                      # inspect locally, redact credentials (Q11)
```
The Node port probe works on every OS and reports `EADDRINUSE` if occupied. For an existing bridge, an occupied port is expected. Do not kill its listener. After installation, `npm run doctor` checks the configured server through Herdr rather than assuming a socket file exists.

Select the service path before continuing:
- **Linux:** `systemctl --user is-system-running` must report `running` or `degraded`. Check `loginctl show-user "$USER" -p Linger` (Q4, Q5).
- **macOS:** use the shipped launchd plist, not systemd. A LaunchAgent requires a logged-in GUI user session.
- **Windows with WSL2:** prepare systemd using the README's Windows instructions first. Herdr, Node, the bridge and the tunnel must run inside the same distribution. Ask before `wsl --shutdown`, which stops all WSL distributions.

**STOP and ask the human** if: Herdr < 0.9 everywhere, node < 22 and you can't install one, Tailscale isn't installed/logged in, or any fix needs `sudo` you don't have. Report the exact output.

## 1. Install
```sh
[ -d "$REPO" ] || git clone https://github.com/OWNER/herdr-mcp "$REPO"   # OWNER = the repo you were given
cd "$REPO" && npm ci --omit=dev
```
**verify:** `node --check "$REPO/src/server.mjs" && echo ok`

## 2. Token
```sh
cd "$REPO" && npm run token
```
**verify:** `npm run doctor` reports `ok` for the token, Herdr version and server connectivity. It validates token contents without printing them, plus ownership and permissions on POSIX. On native Windows, inspect the token's ACLs separately. It must not be readable by other ordinary users.

## 3. Keep it running

Use the matching [README service recipe](README.md#keep-the-bridge-running):
- **Linux:** `systemd/herdr-mcp.service`, settings in `~/.config/herdr-mcp/service.env`, lingering enabled.
- **macOS:** `launchd/dev.herdr-mcp.plist`, settings in its `EnvironmentVariables`. Replace all placeholder paths and set the real Node executable. launchd does not read `service.env`.
- **Windows:** WSL2 plus the Linux systemd unit. Set up WSL lifetime separately if unattended access is needed. Lingering alone does not launch or keep WSL alive.

Set absolute paths in all service settings. Neither manager loads shell rc files or expands `~` and `$HOME`. Put Herdr 0.9+ first on the service PATH. Preserve custom `PORT`, token and socket settings from the previous steps. Never overwrite an existing unit or plist without inspecting it.

**Verify the manager:** Linux or WSL: `systemctl --user is-active herdr-mcp`. macOS: `plutil -lint ~/Library/LaunchAgents/dev.herdr-mcp.plist`, then `launchctl print "gui/$(id -u)/dev.herdr-mcp"` must show `state = running`.

**Verify the bridge:** run `npm run doctor` with the same binary, PATH, token and socket settings as the service. For Linux's `service.env`, use `(set -a; . ~/.config/herdr-mcp/service.env; cd "$REPO"; node bin/herdr-mcp.mjs doctor)`. Then:
```sh
T=$(cat "$TOKEN_FILE")   # kept in a variable for steps 3 and 6; don't echo it
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:$PORT/mcp            # 401
curl -s http://127.0.0.1:$PORT/mcp -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                                   # herdr_skill, herdr
```

## 4. Expose with Tailscale Funnel (443 + path)
**STOP if Tailscale isn't logged in** (`tailscale up` opens a login URL: give it to the human and wait).
**HUMAN (once per tailnet):** if `tailscale funnel` says Funnel or HTTPS isn't enabled, ask the user to enable HTTPS certificates and the `funnel` node attribute in the Tailscale admin console, or open the link the CLI prints. Wait for them.
```sh
tailscale funnel --bg --set-path /herdr-mcp http://127.0.0.1:$PORT/mcp
```
Use 443, not 10000. Hosted clients couldn't reach `:10000`.
**verify:** `tailscale funnel status` shows `/herdr-mcp proxy http://127.0.0.1:$PORT/mcp`, and the existing handlers are unchanged. Then:
```sh
URL=https://$(tailscale status --json | node -e 'const d=require("node:fs").readFileSync(0,"utf8");console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))')/herdr-mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL"                                # 401 = reachable
```
If curl from a tailnet machine gets `198.18.0.1` or hangs, investigate that client's DNS or proxy (Q11). Ask before changing system hosts files.

Alternative: Cloudflare Tunnel, see the README.

## 5. Connect clients (HUMAN pastes the token)
Give the user the URL and the configured token file path. They paste its contents directly into the client:
- **Grok Bot:** add a remote MCP connector with URL `$URL` and header `Authorization: Bearer <token>`.
- **Cursor cloud agents / desktop:** see the README JSON. Use `${env:HERDR_MCP_TOKEN}` in files, never a literal token.

## 6. End-to-end test
Use `$URL` from step 4 (or `URL=http://127.0.0.1:$PORT/mcp` for a local-only/trial run). `T` is from step 3.
```sh
curl -s "$URL" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"herdr","arguments":{"args":["pane","list"]}}}'
```
**verify:** the result has `"exit_code":0` and lists panes. Then, from the connected client: call `herdr_skill`, then `herdr {"args":["list"]}`.

Report the URL, the status of each step, and any HUMAN steps still pending.

## Quirks: symptom → check → fix
| # | Symptom | Check | Fix |
|---|---|---|---|
| Q1 | Snippets fail (`set -a`, `$(...)`, `while read`) under zsh/fish | `echo $SHELL` | Run everything in `bash` (or `bash -l` to pick up PATH). Fish syntax differs entirely. |
| Q2 | Service: `node: not found` or wrong version; works in your terminal | `command -v node`; inspect the unit or plist environment | Resolve the real binary (`mise which node`, `nvm which current`, `asdf which nodejs`). Use its absolute path in systemd `ExecStart` or launchd `ProgramArguments`. Re-check after upgrades. |
| Q3 | `doctor` reports Herdr 0.8.x | `type -a herdr` and `--version` each candidate | Put the 0.9+ directory first in the service PATH or set `HERDR_MCP_BINARY` to its absolute path. Ask before removing a stale binary. |
| Q4 | `systemctl --user` errors | On Linux or WSL: `ps -p 1 -o comm=` | Enable WSL systemd using the README recipe. On macOS use launchd instead. In a container, arrange supervision outside this runbook. |
| Q5 | Service dies at logout or after reboot | Linux: `loginctl show-user "$USER" -p Linger`. macOS: check login session. Windows: check WSL lifetime. | Linux: enable lingering (ask if sudo is needed). macOS: the shipped LaunchAgent runs only while logged in. WSL: follow the README's Task Scheduler guidance. |
| Q6 | `tailscale` says logged out / `NeedsLogin` | `tailscale status` | `tailscale up`, then **give the login URL to the human** and wait. |
| Q7 | `Access denied: serve config denied` / needs root | `tailscale funnel status` error text | **Ask the human** to run once: `sudo tailscale set --operator=$USER`. |
| Q8 | `Funnel not available` / `funnel` nodeAttr missing / HTTPS disabled | Error text or printed admin link | **HUMAN:** admin console → DNS: enable MagicDNS + HTTPS certificates; Access controls: allow `funnel` nodeAttr for this node (or open the CLI's link). |
| Q9 | Other services already on 443 | `tailscale funnel status` | Add only `--set-path /herdr-mcp`. Never `reset`, never replace `/`, never `off` paths you didn't create. |
| Q10 | Hosted client can't reach the URL | Port in URL? | Funnel only allows **443, 8443, 10000**. Use 443 + path; `:10000` was unreachable from Grok Bot in our tests. |
| Q11 | `curl` to ts.net hangs or hits `198.18.0.1`, or a corporate proxy intercepts | `node -e 'require("node:dns").lookup(process.argv[1],console.log)' <fqdn>`; inspect proxy settings locally | Fix client DNS or proxy bypass settings. Ask before changing a system hosts file. |
| Q12 | Corporate network blocks the tunnel outright | `tailscale netcheck`; `curl -I https://<fqdn>` from outside | Use Cloudflare Tunnel (outbound 443) or a different network. **Ask the human.** |
| Q13 | `doctor` cannot reach Herdr | Check the reported socket identifier, service environment and running Herdr session | Start Herdr or correct `HERDR_MCP_SOCKET`. macOS uses `~/.config`, not `~/Library/Application Support`. Native Windows uses a named pipe, not a disk socket. |
| Q14 | Port taken | Use the Node port probe in preflight | Pick another `PORT`; use it in the service settings and tunnel target. Never stop an unknown listener. |
| Q15 | Token refused at startup | `npm run doctor` without printing contents | POSIX: private mode and correct owner. Windows: private ACLs managed separately. Every OS: exactly 64 hex characters. Do not rotate an existing token without permission. |

