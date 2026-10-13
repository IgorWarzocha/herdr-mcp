# AGENTS.md: set up herdr-mcp end to end

herdr-mcp lets hosted agents (Cursor cloud agents, Grok Bot, Muse, OpenClaw, any remote MCP client) drive Herdr on this machine. The token is shell access; read the README "Risks" section and make sure the human has too.

You are an agent installing herdr-mcp on the machine that runs Herdr. Do the steps in order. Every step is idempotent and has a **verify** command. Stop and report if a verify fails. Steps marked **HUMAN** need the user.

Hard rules:
- Never run `tailscale serve reset` or `tailscale funnel reset`, and never `funnel off` a path you didn't create. Other services share the node.
- Never print the token into chat or commit it. Refer to its path, and only reveal it when the user asks to paste it into a client.
- Don't modify existing Funnel/Serve handlers. Only add `/herdr-mcp`.

Run the commands in **bash** (`bash -l` if the login shell is zsh/fish; some snippets are bash-only). Set the variables once and keep them for every step:
```sh
REPO=~/herdr-mcp PORT=8792          # if PORT is taken, pick another and use it everywhere
TOKEN_FILE=~/.config/herdr-mcp/token
```
The server and `npm run token`/`doctor` read `PORT` and `HERDR_MCP_TOKEN_FILE` from the environment, so `export PORT HERDR_MCP_TOKEN_FILE=$TOKEN_FILE` before steps 2–3 if you changed either.

**Trial run / second instance** (doesn't touch an existing install): clone into a temp dir, use a spare `PORT` (e.g. 18800), `TOKEN_FILE=$TMP/token`, a `service.env` in the temp dir, and a unit named `herdr-mcp-test.service` (point its `EnvironmentFile=` at the temp `service.env`). Skip step 4 and test step 6 against `http://127.0.0.1:$PORT/mcp`. Clean up with `systemctl --user stop herdr-mcp-test`, remove the unit, `daemon-reload`, `rm -rf $TMP`.

## 0. Preflight
```sh
uname -s; echo "$SHELL"                    # Linux tested; Darwin untested (no systemd; see Q4)
which -a herdr | while read h; do echo "$h: $($h --version)"; done   # need >= 0.9; note every path (Q3)
node --version                            # need >= 22 (or bun --version); note `command -v node` (Q2)
ls -l "${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"           # Herdr server running (Q13)
systemctl --user is-system-running        # "running"/"degraded" = OK; error = no user systemd (Q4)
loginctl show-user "$USER" -p Linger      # Linger=yes needed to survive logout (Q5)
ss -ltn | grep -q ":$PORT " && echo "PORT TAKEN" || echo "port free"   # macOS: lsof -iTCP:$PORT -sTCP:LISTEN
tailscale status --self | head -1         # logged in? (Q6)
tailscale funnel status                   # record existing handlers; do not change them (Q9)
env | grep -i _proxy                      # corporate proxy? (Q11)
```
**STOP and ask the human** if: Herdr < 0.9 everywhere, node < 22 and you can't install one, Tailscale isn't installed/logged in, or any fix needs `sudo` you don't have. Report the exact output.

## 1. Install
```sh
[ -d "$REPO" ] || git clone https://github.com/OWNER/herdr-mcp "$REPO"   # OWNER = the repo you were given
cd "$REPO" && npm ci --omit=dev
```
**verify:** `node --check $REPO/src/server.mjs && echo ok`

## 2. Token
```sh
cd "$REPO" && npm run token
```
**verify:** `stat -c '%a %U' $TOKEN_FILE` (macOS: `stat -f '%Lp %Su'`) shows `600 <you>`, and `wc -c < $TOKEN_FILE` is 65.

## 3. Config + systemd user unit
```sh
mkdir -p ~/.config/herdr-mcp ~/.config/systemd/user
[ -f ~/.config/herdr-mcp/service.env ] || cp "$REPO/.env.example" ~/.config/herdr-mcp/service.env
```
Edit `service.env`: set `PATH=` with **absolute** dirs (no `%h`, `~` or `$HOME`; systemd won't expand them), Herdr 0.9+ dir first, then the dir of `$(command -v node)`, then `/usr/local/bin:/usr/bin:/bin`. Set `PORT`, and `HERDR_MCP_TOKEN_FILE=` if you're not using the default token path.
```sh
sed "s#%h/herdr-mcp#$REPO#" "$REPO/systemd/herdr-mcp.service" > ~/.config/systemd/user/herdr-mcp.service
systemctl --user daemon-reload && systemctl --user enable --now herdr-mcp.service
loginctl enable-linger "$USER"
```
**verify:**
```sh
(set -a; . ~/.config/herdr-mcp/service.env; cd $REPO; node bin/herdr-mcp.mjs doctor)
systemctl --user is-active herdr-mcp
T=$(cat $TOKEN_FILE)   # kept in a variable for steps 3 and 6; don't echo it
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
URL=https://$(tailscale status --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,"")))')/herdr-mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL"                                # 401 = reachable
```
If curl from a tailnet machine gets `198.18.0.1` or hangs, add `<tailscale ip -4 of server> <fqdn>` to that client's `/etc/hosts`.

Alternative: Cloudflare Tunnel, see the README.

## 5. Connect clients (HUMAN pastes the token)
Give the user the URL and tell them to paste the token from `~/.config/herdr-mcp/token`:
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
| Q2 | Service: `node: not found` or wrong version; works in your terminal | `systemctl --user show-environment \| grep PATH`; `command -v node` (mise/nvm/asdf shim?) | Resolve the real binary (`mise which node`, `nvm which current`, `asdf which nodejs`) and put its **directory** in `service.env` PATH, or use that absolute path in `ExecStart`. Shims break when the version changes; re-check after upgrades. |
| Q3 | `doctor` reports Herdr 0.8.x | `which -a herdr` + `--version` each | Put the 0.9+ dir first in `service.env` PATH, or `HERDR_MCP_BINARY=/abs/path/herdr`. Removing the stale binary: **ask the human** (may need sudo / be package-managed). |
| Q4 | `systemctl --user` errors (`Failed to connect to bus`): WSL, containers, macOS | `systemctl --user is-system-running`; `ps -p 1 -o comm=` | WSL: human enables `[boot] systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`. Otherwise use the `nohup` or launchd recipe in the README. |
| Q5 | Service dies at logout / not running after reboot | `loginctl show-user $USER -p Linger` | `loginctl enable-linger $USER` (if denied: **ask the human** to run `sudo loginctl enable-linger $USER`). |
| Q6 | `tailscale` says logged out / `NeedsLogin` | `tailscale status` | `tailscale up`, then **give the login URL to the human** and wait. |
| Q7 | `Access denied: serve config denied` / needs root | `tailscale funnel status` error text | **Ask the human** to run once: `sudo tailscale set --operator=$USER`. |
| Q8 | `Funnel not available` / `funnel` nodeAttr missing / HTTPS disabled | Error text or printed admin link | **HUMAN:** admin console → DNS: enable MagicDNS + HTTPS certificates; Access controls: allow `funnel` nodeAttr for this node (or open the CLI's link). |
| Q9 | Other services already on 443 | `tailscale funnel status` | Add only `--set-path /herdr-mcp`. Never `reset`, never replace `/`, never `off` paths you didn't create. |
| Q10 | Hosted client can't reach the URL | Port in URL? | Funnel only allows **443, 8443, 10000**. Use 443 + path; `:10000` was unreachable from Grok Bot in our tests. |
| Q11 | `curl` to ts.net hangs or hits `198.18.0.1`, or a corporate proxy intercepts | `getent hosts <fqdn>`; `env \| grep -i proxy` | Pin `<tailscale ip -4 of server> <fqdn>` in that client's `/etc/hosts`, or `NO_PROXY=.ts.net,127.0.0.1`. Hosted clients resolve public DNS and are unaffected. |
| Q12 | Corporate network blocks the tunnel outright | `tailscale netcheck`; `curl -I https://<fqdn>` from outside | Use Cloudflare Tunnel (outbound 443) or a different network. **Ask the human.** |
| Q13 | `doctor`: `missing ...herdr.sock` | `ls ~/.config/herdr/`; `echo $HERDR_SOCKET_PATH`; `$XDG_CONFIG_HOME` set? | Start Herdr, or set `HERDR_MCP_SOCKET=/abs/path` in `service.env` (it also honours `HERDR_SOCKET_PATH`, then `$XDG_CONFIG_HOME/herdr/herdr.sock`). |
| Q14 | Port taken | `ss -ltnp \| grep :$PORT` | Pick another `PORT`; use it in `service.env` and the Funnel target. |
| Q15 | Token refused at startup | `stat` on the token | `chmod 600`, owned by the service user, exactly 64 hex chars (`npm run token` makes one). |

