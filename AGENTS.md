# Developing herdr-mcp

Read [docs/development.md](docs/development.md) for the bridge boundaries before changing runtime behaviour. Installation instructions for users and setup agents live in [SETUP.md](SETUP.md).

- Run `npm run check` as the final code gate. For documentation-only changes, check affected links and package contents instead.
- Keep automated tests isolated with temporary files, fake runners and local HTTP listeners. Never use a deployed bridge, real token or tunnel in tests.
- Repository work does not authorise restarting a live service, reading its token or changing its tunnel. An explicitly requested trial deployment must use the second-instance procedure in SETUP.md.
- Keep `herdr_skill` output identical to the installed CLI guide. Bridge-specific operating guidance belongs in the `herdr` tool description and SKILL.md.
