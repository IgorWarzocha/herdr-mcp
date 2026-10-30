# Developing herdr-mcp

Read [docs/development.md](docs/development.md) for the bridge boundaries before changing runtime behaviour. Installation instructions for users and setup agents live in [SETUP.md](SETUP.md).

- Run `npm run check` as the final code gate. For documentation-only changes, check affected links and package contents instead.
- Keep automated tests isolated with temporary files, fake runners and local HTTP listeners. Never use a deployed bridge, real token or tunnel in tests.
- Before every bridge restart, run the installed-binary gate with the service's Herdr binary and PATH. Use `npm run restart` for the Linux service: it runs the gate with systemd's environment, launcher and checkout before stopping the old process. A failed smoke blocks deployment. The disposable live smoke is separate from the isolated test suite and makes no model calls.
- Repository work does not authorise restarting a live service, reading its token or changing its tunnel. An explicitly requested trial deployment must use the second-instance procedure in SETUP.md.
- Keep the unified control guide in `src/runtimes.mjs` aligned with both adapters. Never retry a failed mutation on another runtime. New programs prefer Core when its binary is installed.
- Current-Herdr-only does not authorise dropping MCP revisions used by configured clients. Keep the client negotiation cases in `scripts/protocol-smoke.mjs` in the deployment gate.
