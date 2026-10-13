# AGENTS.md: set up herdr-mcp end to end

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
which -a herdr | while read h; do echo "$h: $($h --version)"; done   # need >= 0.9; note every path
node --version                            # need >= 22 (or bun --version)
ls ~/.config/herdr/herdr.sock             # Herdr server running
ss -ltn | grep -q ":$PORT " && echo "PORT TAKEN" || echo "port free"
tailscale status --self | head -1         # logged in
tailscale funnel status                   # record existing handlers; do not change them
```
If `which -a herdr` lists an older binary first (for example `/usr/bin/herdr` 0.8), note the 0.9+ directory. It must come first in the service PATH (step 3).

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
**verify:** `stat -c '%a %U' $TOKEN_FILE` shows `600 <you>`, and `wc -c < $TOKEN_FILE` is 65.

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
