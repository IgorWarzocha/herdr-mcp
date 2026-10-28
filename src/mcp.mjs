import { ResourceNotFoundError, Server } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { executeCommand, normalize } from './bridge.mjs';
import { PANES_URI } from './directory.mjs';
import { failure, toolResult } from './errors.mjs';

const schemas = {
  herdr: z.object({ args: z.array(z.string()).max(256).optional(), command: z.string().max(65536).optional() }),
  herdr_skill: z.object({}),
};
const inputSchemas = Object.fromEntries(Object.entries(schemas).map(([name, schema]) =>
  [name, z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' })]));

export function createMcpServer({ runner, updates, waitMaxMs, era }) {
  const server = new Server({ name: 'herdr-mcp', version: '0.2.1' }, {
    supportedProtocolVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: era === 'modern' } },
  });
  server.setRequestHandler('tools/list', () => ({ tools: [
    { name: 'herdr_skill', description: 'Read the installed Herdr CLI guide verbatim', inputSchema: inputSchemas.herdr_skill },
    {
      name: 'herdr', inputSchema: inputSchemas.herdr,
      description: `Control the pinned Herdr server. list; send <target> <text>; read <target>; reply <target> for clean Pi text; wait <target> [--timeout ms]. Targets accept pane IDs, agent names and unique labels. Calls block; wait ceiling ${waitMaxMs} ms. Sending confirms delivery, not completion. Read herdr_skill for full CLI syntax.`,
    },
  ] }));

  // Low-level SDK registration keeps the bridge's short validation envelope.
  // SDK v2 owns protocol encoding and cancellation.
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name;
    if (!Object.hasOwn(schemas, name)) return toolResult(failure('invalid_arguments', 'Use herdr or herdr_skill.'));
    const input = schemas[name].safeParse(request.params.arguments ?? {});
    if (!input.success) return toolResult(failure('invalid_arguments', name === 'herdr'
      ? 'Use args as an array of at most 256 strings, or command as a string of at most 65536 characters.'
      : 'Supply a JSON arguments object. herdr_skill needs no arguments.'));
    let args = ['--skill'];
    if (name === 'herdr') {
      try { args = normalize(input.data); }
      catch (error) { return toolResult(failure('invalid_arguments', error.message)); }
    }
    const result = await executeCommand(runner, args, ctx.mcpReq.signal, waitMaxMs);
    if (name === 'herdr_skill') {
      if (result.code === 'ok') return { content: [{ type: 'text', text: result.stdout }] };
      if (result.code === 'truncated') {
        return toolResult({ ...result, next: 'The installed guide exceeded the output limit. Use herdr with the relevant subcommand --help instead.' });
      }
    }
    return toolResult(result);
  });

  server.setRequestHandler('resources/list', () => ({ resources: [{
    uri: PANES_URI, name: 'panes', title: 'Herdr panes', mimeType: 'application/json',
    description: 'Pane IDs, workspace and tab labels, agent names, terminal titles and reported state. Subscribe for changes, then read again. Errors are explicit code/message/next documents, not empty or stale pane lists.',
  }] }));
  server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }));
  server.setRequestHandler('resources/read', async (request, ctx) => {
    if (request.params.uri !== PANES_URI) throw new ResourceNotFoundError(request.params.uri);
    return { contents: [{ uri: PANES_URI, mimeType: 'application/json', text: await updates.read(ctx.mcpReq.signal) }] };
  });
  return server;
}
