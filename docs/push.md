# Receive pane changes

The bridge supports the official [MCP 2026-07-28 subscription protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) through [TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk). It does not implement draft webhook proposals.

## Run the receiving client

After installing the bridge's dependencies, set `HERDR_MCP_URL` to its verified endpoint and load the existing bearer token into `HERDR_MCP_TOKEN` in the client process environment. Keep the token out of chat and command history. Then run from the checkout:

```sh
node scripts/watch-panes.mjs
```

The client subscribes and prints the initial directory as one JSON line. Each change triggers another read and line. It sends no input to Herdr and makes no model calls. Ctrl+C closes the subscription. A remote closure or connection error exits unsuccessfully rather than pretending monitoring continues. Restart it to reconnect and read current state. Directory errors arrive as explicit `code`, `message` and `next` documents.

The receiver explicitly selects protocol `2026-07-28`. SDK v2's default client mode is still legacy, so upgrading the package alone does not enable subscriptions. See [scripts/watch-panes.mjs](../scripts/watch-panes.mjs) for the complete SDK client, including coalesced reads and cleanup.

## Subscription contract

1. Register a handler for `notifications/resources/updated`.
2. Call `client.listen({ resourceSubscriptions: ['herdr://panes'] })` and verify that the returned `honoredFilter` includes the URI. The SDK resolves this after the subscription acknowledgement.
3. Read `herdr://panes` immediately, then again when its update notification arrives. A notification invalidates the resource; it does not contain the new directory.
4. Close the subscription when finished. Watch `subscription.closed` for a remote or graceful server closure. On reconnect, subscribe again and read again. There is no replay queue.

The resource contains `{ "code": "ok", "panes": [...] }`. Each pane has `pane_id`, `workspace_id`, `workspace_label`, `tab_id`, `tab_label`, `name`, `terminal_title`, `agent`, `agent_status`, `state_change_seq`, `completion_seq` and `cwd`. Missing optional labels are `null`. Friendly commands accept unique labels. Duplicate labels are not collapsed and require a pane ID to disambiguate.

The friendly `list` tool command returns the same pane directory in its usual result envelope's `stdout`. Raw `agent list`, `pane list`, `tab list` and `workspace list` still return the CLI's own output.

## Delivery limits

Herdr's CLI does not provide the subscription stream used here. The bridge samples one shared `api snapshot` every two seconds after the preceding observation completes, while subscriptions are open. This replaces repeated model tool calls, not all local polling. Slow CLI responses can delay updates. Fast transitions between samples can be missed.

Changes include pane membership, labels, terminal titles and reported agent state. They do not include terminal output. Read the pane when you need its screen or history. Reported idle or done still does not prove that a particular message finished.

Up to eight subscription streams share the existing authenticated endpoint. Older protocols are rejected. Neither this protocol nor the bridge guarantees that a hosted client starts a new model turn when notified. Grok Bot and Cursor support must be verified separately. Keep using blocking waits where the client cannot deliver push updates into the workflow.
