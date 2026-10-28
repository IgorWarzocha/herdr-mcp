import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHandler } from '../src/server.mjs';
import { createPaneUpdates } from '../src/pane-updates.mjs';
import { PANES_URI } from '../src/directory.mjs';
import { ok, snapshot, snapshotResult } from './fixtures/panes.mjs';
import { watchPanes } from '../scripts/watch-panes.mjs';

async function host(t, runner, options = {}) {
  const handler = createHandler({ token: 'push-test', origins: [], runner, pollIntervalMs: 20, ...options });
  const http = createServer(handler);
  t.after(async () => { await handler.close(); http.close(); http.closeAllConnections(); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { handler, url: new URL(`http://127.0.0.1:${http.address().port}/mcp`) };
}

async function connect(t, url, mode = { pin: '2026-07-28' }) {
  const client = new Client({ name: 'push-test', version: '1' }, { versionNegotiation: { mode } });
  const frames = [];
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer push-test' } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) return response;
      const decoder = new TextDecoder(); let pending = '';
      const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          for (const line of frame.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
        controller.enqueue(chunk);
      } }));
      return new Response(body, { status: response.status, headers: response.headers });
    },
  }));
  return { client, frames };
}

test('official modern subscriptions acknowledge first, filter updates, and expose names and current state', { timeout: 5000 }, async t => {
  let value = snapshot(); let reads = 0;
  const { url, handler } = await host(t, { async run(args) {
    assert.deepEqual(args, ['api', 'snapshot']); reads++; return snapshotResult(value);
  } });
  const { client, frames } = await connect(t, url);
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.equal(client.getServerCapabilities().resources.subscribe, true);
  assert.deepEqual((await client.listResources()).resources.map(r => r.uri), [PANES_URI]);
  assert.equal(reads, 0, 'discovery must not inspect Herdr');
  const notices = new EventEmitter();
  client.setNotificationHandler('notifications/resources/updated', notice => notices.emit('update', notice));
  const sub = await client.listen({ resourceSubscriptions: [PANES_URI], toolsListChanged: true });
  assert.deepEqual(sub.honoredFilter, { resourceSubscriptions: [PANES_URI] });
  t.after(() => sub.close());
  const initial = JSON.parse((await client.readResource({ uri: PANES_URI })).contents[0].text);
  assert.equal(initial.panes[0].tab_label, 'MCP bridge');
  assert.equal(initial.panes[0].name, 'reviewer');
  assert.equal(initial.panes[0].agent_status, 'working');

  const { client: second } = await connect(t, url);
  let unrequested = 0;
  second.setNotificationHandler('notifications/resources/updated', () => unrequested++);
  const empty = await second.listen({ toolsListChanged: true });
  assert.deepEqual(empty.honoredFilter, {});
  t.after(() => empty.close());

  const update = once(notices, 'update', { signal: AbortSignal.timeout(2000) });
  value = snapshot(); value.agents[0].agent_status = 'done'; value.agents[0].state_change_seq = 2;
  const [notice] = await update;
  assert.equal(notice.params.uri, PANES_URI);
  const acknowledged = frames.findIndex(frame => frame.method === 'notifications/subscriptions/acknowledged');
  const changed = frames.findIndex(frame => frame.method === 'notifications/resources/updated');
  assert.ok(acknowledged >= 0 && changed > acknowledged);
  assert.equal(notice.params._meta['io.modelcontextprotocol/subscriptionId'],
    frames[acknowledged].params._meta['io.modelcontextprotocol/subscriptionId']);
  const current = JSON.parse((await client.readResource({ uri: PANES_URI })).contents[0].text);
  assert.equal(current.panes[0].agent_status, 'done');
  assert.equal(unrequested, 0);
  await assert.rejects(client.listen({ resourceSubscriptions: ['file:///private'] }), /Only herdr:\/\/panes/);
  await assert.rejects(client.readResource({ uri: 'file:///private' }), error => error.code === -32602);
  await handler.close();
  assert.equal(await sub.closed, 'graceful');
  assert.equal(await empty.closed, 'graceful');
});

test('legacy tools and resource reads work without advertising undeliverable legacy subscriptions', async t => {
  const calls = [];
  const { url } = await host(t, { async run(args) { calls.push(args); return snapshotResult(snapshot()); } });
  const { client } = await connect(t, url, 'legacy');
  assert.equal(client.getServerCapabilities().resources.subscribe, false);
  const result = await client.callTool({ name: 'herdr', arguments: { args: ['list'] } });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(JSON.parse(result.content[0].text).stdout).panes[0].tab_label, 'MCP bridge');
  assert.equal(JSON.parse((await client.readResource({ uri: PANES_URI })).contents[0].text).code, 'ok');
  await assert.rejects(client.listen({ resourceSubscriptions: [PANES_URI] }));
  await assert.rejects(client.subscribeResource({ uri: PANES_URI }));
  assert.deepEqual(calls, [['api', 'snapshot'], ['api', 'snapshot']]);
});

test('subscription limits leave room for tool calls and disconnected streams release capacity', { timeout: 5000 }, async t => {
  const { url } = await host(t, { async run() { return snapshotResult(snapshot()); } });
  const { client } = await connect(t, url);
  const subscriptions = [];
  t.after(async () => { for (const sub of subscriptions) await sub.close(); });
  for (let i = 0; i < 8; i++) subscriptions.push(await client.listen({ resourceSubscriptions: [PANES_URI] }));
  await assert.rejects(client.listen({ resourceSubscriptions: [PANES_URI] }), /Subscription limit reached/);
  assert.equal((await client.listTools()).tools.length, 2);
  for (let i = 0; i < 18; i++) {
    const old = subscriptions.shift(); await old.close(); assert.equal(await old.closed, 'local');
    subscriptions.push(await client.listen({ resourceSubscriptions: [PANES_URI] }));
  }
});

test('observer is shared, stops its child on last unsubscribe, and does not retain an old generation', async t => {
  const calls = [];
  const updates = createPaneUpdates({ intervalMs: 10, runner: { run(args, signal) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    calls.push({ args, signal, resolve });
    return promise;
  } } });
  t.after(() => updates.close());
  const events = [];
  const first = updates.bus.subscribe(event => events.push(event));
  const second = updates.bus.subscribe(event => events.push(event));
  assert.equal(calls.length, 1);
  await delay(30); assert.equal(calls.length, 1, 'an unresolved snapshot must not overlap another');
  first(); assert.equal(calls[0].signal.aborted, false);
  second(); second(); assert.equal(calls[0].signal.aborted, true);
  const third = updates.bus.subscribe(event => events.push(event));
  assert.equal(calls.length, 2);
  calls[0].resolve(snapshotResult(snapshot()));
  calls[1].resolve(snapshotResult(snapshot()));
  await delay(15);
  assert.equal(calls.length, 3, 'only the current generation schedules the next snapshot');
  third(); assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve({ ...ok, cancelled: true });
  const stopped = calls.length;
  await delay(30); assert.equal(calls.length, stopped);
  assert.equal(events.length, 0);
});

test('upstream failure invalidates the resource explicitly, then recovery and re-listen resynchronise', { timeout: 5000 }, async t => {
  let response = snapshotResult(snapshot());
  const { url } = await host(t, { async run() { return response; } });
  const { client } = await connect(t, url);
  const notices = new EventEmitter();
  client.setNotificationHandler('notifications/resources/updated', n => notices.emit('update', n));
  let sub = await client.listen({ resourceSubscriptions: [PANES_URI] });
  t.after(() => sub.close());
  assert.equal(JSON.parse((await client.readResource({ uri: PANES_URI })).contents[0].text).code, 'ok');
  const failed = once(notices, 'update', { signal: AbortSignal.timeout(2000) });
  response = { ...ok, exit_code: 1, stderr: '{"error":{"code":"server_not_running","message":"private diagnostic"}}' };
  await failed;
  const unavailable = (await client.readResource({ uri: PANES_URI })).contents[0].text;
  assert.equal(JSON.parse(unavailable).code, 'herdr_not_running');
  assert.equal(JSON.parse(unavailable).panes, undefined);
  assert.doesNotMatch(unavailable, /private/);
  const recovered = once(notices, 'update', { signal: AbortSignal.timeout(2000) });
  response = snapshotResult(snapshot()); await recovered;
  await sub.close();
  const later = snapshot(); later.tabs[0].label = 'Renamed while disconnected'; response = snapshotResult(later);
  sub = await client.listen({ resourceSubscriptions: [PANES_URI] });
  assert.equal(JSON.parse((await client.readResource({ uri: PANES_URI })).contents[0].text).panes[0].tab_label, later.tabs[0].label);
});

test('receiving client reads after acknowledgement, follows changes and reports remote closure', { timeout: 5000 }, async t => {
  let value = snapshot();
  const { url, handler } = await host(t, { async run() { return snapshotResult(value); } });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const seen = [];
  await watchPanes({ url, token: 'push-test', signal: controller.signal, onDirectory(document) {
    seen.push(document);
    if (seen.length === 1) {
      value = snapshot(); value.tabs[0].label = 'Changed tab';
    } else controller.abort();
  } });
  assert.equal(seen[0].panes[0].tab_label, 'MCP bridge');
  assert.equal(seen[1].panes[0].tab_label, 'Changed tab');
  const remote = new AbortController();
  t.after(() => remote.abort());
  await assert.rejects(watchPanes({ url, token: 'push-test', signal: remote.signal,
    onDirectory: () => handler.close(),
  }), /Pane subscription closed/);
});

test('subscribed reads share the initial observation without letting one reader cancel everyone', async t => {
  const calls = [];
  const updates = createPaneUpdates({ runner: { run(args, signal) {
    return new Promise(resolve => calls.push({ signal, resolve }));
  } } });
  t.after(() => updates.close());
  const unsubscribe = updates.bus.subscribe(() => {});
  t.after(unsubscribe);
  const controller = new AbortController();
  const cancelled = updates.read(controller.signal);
  const reading = updates.read();
  assert.equal(calls.length, 1, 'no independent read can return an older snapshot than the baseline');
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(calls[0].signal.aborted, false, 'reader cancellation must not abort the shared observer');
  const value = snapshot(); value.tabs[0].label = 'Current label';
  calls[0].resolve(snapshotResult(value));
  assert.equal(JSON.parse(await reading).panes[0].tab_label, 'Current label');
  assert.equal(JSON.parse(await updates.read()).panes[0].tab_label, 'Current label');
});
