# Setup reference

Follow [AGENTS.md](../AGENTS.md) for the ordered setup and verification flow. These recipes run on the machine hosting Herdr. Inspect existing services before changing them.

## Native Windows foreground setup

Install native Node 22+ and [Herdr for Windows](https://herdr.dev/docs/windows-beta/). Open Herdr so its server is running, then in PowerShell:

```powershell
git clone https://github.com/IgorWarzocha/herdr-mcp "$HOME/herdr-mcp"
Set-Location "$HOME/herdr-mcp"
npm ci --omit=dev
npm run token
npm run doctor
npm start
```

Use a native `herdr.exe`, not a `.cmd` or `.bat` wrapper. Stop with Ctrl+C. The background recipes below include WSL2 for Windows. No native Windows service wrapper is shipped.

## Keep the bridge running

These recipes supervise the bridge, not Herdr or your tunnel. Those must also be running. Stop a foreground `npm start` before starting a service on the same port.

### Linux: systemd user service

```sh
mkdir -p ~/.config/herdr-mcp ~/.config/systemd/user
[ -f ~/.config/herdr-mcp/service.env ] || cp .env.example ~/.config/herdr-mcp/service.env
[ -f ~/.config/systemd/user/herdr-mcp.service ] || cp systemd/herdr-mcp.service ~/.config/systemd/user/
```

Edit `service.env`: put absolute directories for Herdr 0.9+ and Node first in `PATH`. Set a custom token or socket path if needed. Edit `WorkingDirectory` in the copied unit if the repository is not `~/herdr-mcp`. Do not overwrite an existing service without reviewing it.

```sh
systemctl --user daemon-reload
systemctl --user enable --now herdr-mcp.service
loginctl enable-linger "$USER"                        # keep running after logout
systemctl --user is-active herdr-mcp
journalctl --user -u herdr-mcp -n 20
```

systemd does **not** read your shell rc, so mise/nvm/asdf shims aren't on PATH. Put absolute directories in `service.env` (systemd doesn't expand `%h`, `~` or `$HOME` there), or an absolute node path in `ExecStart`.

### macOS: launchd user agent

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
[ -f ~/Library/LaunchAgents/dev.herdr-mcp.plist ] || cp launchd/dev.herdr-mcp.plist ~/Library/LaunchAgents/
command -v node
command -v herdr
```

Edit the copied [plist](../launchd/dev.herdr-mcp.plist). Replace every `/Users/YOU`, set the actual Node executable in `ProgramArguments`, and set the repository, token, socket and log paths. Adjust `PATH` to include Herdr's directory. `/opt/homebrew/bin/node` is only an example. For mise, nvm or asdf, resolve the real executable rather than a shim. The macOS default socket is `~/.config/herdr/herdr.sock`, unless you changed `XDG_CONFIG_HOME` or selected another session.

launchd does not expand `~` or `$HOME`, read your shell rc, or load `service.env`. Put settings in `EnvironmentVariables` with literal absolute paths. XML-escape `&` as `&amp;` in paths.

```sh
plutil -lint ~/Library/LaunchAgents/dev.herdr-mcp.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.herdr-mcp.plist
launchctl print "gui/$(id -u)/dev.herdr-mcp"   # look for state = running
tail -n 20 ~/Library/Logs/herdr-mcp.log
```

For an already loaded agent, use `launchctl bootout "gui/$(id -u)/dev.herdr-mcp"` before bootstrapping an edited plist. To restart without changing settings: `launchctl kickstart -k "gui/$(id -u)/dev.herdr-mcp"`.

This LaunchAgent starts at login and restarts the bridge if it exits. It does not run while logged out or keep a sleeping Mac awake. A headless, pre-login service needs a separately configured LaunchDaemon.

### Windows: WSL2 with systemd

Install a WSL2 distribution such as Ubuntu. In PowerShell, `wsl --list --verbose` must show version `2`. Install Linux Node and Herdr **inside that distribution**, with the repository in its Linux home directory. Use its Bash terminal for the install and Linux systemd steps above.

Recent Ubuntu WSL installations enable systemd by default. Check inside WSL:

```sh
ps -p 1 -o comm=                       # systemd
systemctl --user is-system-running    # running or degraded
```

If needed, merge this setting into `/etc/wsl.conf` without replacing other settings:

```ini
[boot]
systemd=true
```

Then run `wsl --shutdown` in PowerShell and reopen the distribution. **This stops every running WSL distribution**, so save work and ask before doing it. See [Microsoft's systemd setup](https://learn.microsoft.com/en-us/windows/wsl/systemd).

Enable the user service and lingering using the Linux recipe. WSL's lifetime still matters: systemd services alone do not keep a distribution alive, and lingering does not start WSL after a Windows reboot. For unattended use while Windows is awake, create a Task Scheduler task under your Windows account at logon that runs `wsl.exe` with arguments `-d Ubuntu --exec sleep infinity`. Replace `Ubuntu` with your distribution name and disable the task's execution time limit. Start the task and verify the bridge from a second WSL terminal. Windows shutdown, sleep and `wsl --shutdown` still interrupt access.

Run the tunnel inside the same distribution so its loopback target reaches the bridge. Do not mix a Windows-host tunnel with WSL loopback without configuring and verifying that networking separately.

## Cloudflare Tunnel

Use a named tunnel with a hostname the user owns. Do not use a temporary quick-tunnel URL for a permanent connector. These commands are Bash. In native Windows, use the same `cloudflared` arguments in PowerShell with Windows paths.

1. Inspect `cloudflared --version` and existing configuration. If account credentials are missing, run `cloudflared tunnel login`. **HUMAN:** log in through the printed URL and authorise the domain. **Verify:** `cloudflared tunnel list` succeeds. Never print credential files.
2. Choose an unused tunnel name and hostname with the user. Inspect existing tunnels and DNS records first. Create only the new tunnel: `cloudflared tunnel create herdr-mcp`. **Verify:** the tunnel list contains it. Record its UUID and the absolute credentials-file path printed by the command. If that name is already taken, choose another rather than deleting or replacing it.
3. Write a separate, private configuration file, such as `~/.cloudflared/herdr-mcp.yml`. Do not overwrite `config.yml` or another tunnel's configuration. Replace every placeholder below, including the port if it changed:

   ```yaml
   tunnel: <TUNNEL_UUID>
   credentials-file: <ABSOLUTE_PATH_TO_TUNNEL_CREDENTIALS_JSON>
   ingress:
     - hostname: herdr-mcp.example.com
       service: http://127.0.0.1:8792
     - service: http_status:404
   ```

   Set `CF_CONFIG` to that file's absolute path. **Verify:** `cloudflared tunnel --config "$CF_CONFIG" ingress validate` succeeds and `cloudflared tunnel --config "$CF_CONFIG" ingress rule https://herdr-mcp.example.com/mcp` selects the loopback service.
4. **HUMAN:** approve the new DNS route. Run `cloudflared tunnel route dns herdr-mcp herdr-mcp.example.com` without overwrite flags. **Verify:** the DNS dashboard shows this hostname pointing to the new tunnel UUID, not another service. Do not remove an existing record to make this pass.
5. Start `cloudflared tunnel --config "$CF_CONFIG" run herdr-mcp` in a separate foreground terminal. **Verify:** the connector reports an established tunnel, then check `https://herdr-mcp.example.com/mcp` from outside the hosting machine. It must return HTTP 401 with `bad_token` without a token and discover both tools with the existing bearer token. A Cloudflare login page is not a successful MCP connection. Do not remove an existing Access policy without approval.
6. For background use, configure a separately named systemd user service or launchd agent to run the same command with absolute paths. On Windows, use WSL2 and its Linux supervisor, or explicitly leave the tunnel in the foreground. Never replace a shared `cloudflared` service. **Verify:** stop only the foreground process you created, start the new supervisor, confirm it remains running and repeat the external authenticated check. Ask for administrator approval if required.

Set `URL=https://herdr-mcp.example.com/mcp`, substituting the real hostname, then return to AGENTS.md step 5. The Cloudflare origin target is the bridge root. The client URL includes `/mcp`. Tailscale's path proxy instead targets the local `/mcp` directly.

See Cloudflare's [locally managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/) for provider-specific login and installation steps.
