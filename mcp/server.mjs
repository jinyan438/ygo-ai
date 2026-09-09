// YGO AI MCP server
//
// Thin MCP (Model Context Protocol) host that exposes the YGO Tools engine
// as 14 MCP tools, backed by the detached persistent engine host.
//
// It exposes the same engine that lib/index.js exposes to other hosts, over MCP:
//   - tools are the same 14 public YGO tools (queryCards, manageSessionDeck, ...)
//   - tool JSON Schemas come straight from the backend (authoritative source)
//   - each tools/call is forwarded to the persistent engine host at
//     127.0.0.1:19981 (auto-spawned on first use), keyed by a session id.
//
// The heavy engine is intentionally NOT loaded into this process: keep the
// host thin, outsource the work to the detached engine host.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createPersistentEngineClient } from '../skill/backend/persistent-engine-client.mjs';
import {
  PUBLIC_TOOL_NAMES,
  PUBLIC_TOOL_DESCRIPTIONS,
  getPublicToolInputSchema,
} from '../skill/backend/tool-schemas.mjs';

const ENGINE_HOSTNAME = process.env.YGO_ENGINE_HOST ?? '127.0.0.1';
const ENGINE_PORT = Number(process.env.YGO_ENGINE_HOST_PORT ?? 19981);
// A single default session is plenty for a single-user Goose run. The engine
// host keeps state across MCP-server restarts (the host process stays alive),
// which mirrors DSH's cross-restart persistence.
const SESSION_ID = process.env.YGO_MCP_SESSION_ID ?? 'default';

const engineClient = createPersistentEngineClient({
  hostname: ENGINE_HOSTNAME,
  port: ENGINE_PORT,
  autoStart: true,
  startupTimeoutMs: 30000,
});

const server = new Server(
  { name: 'ygo_tools', version: '1.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: PUBLIC_TOOL_NAMES.map((name) => ({
    name,
    description: PUBLIC_TOOL_DESCRIPTIONS[name] ?? `YGO backend tool ${name}.`,
    inputSchema: getPublicToolInputSchema(name),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};

  if (!PUBLIC_TOOL_NAMES.includes(name)) {
    return toolError({ ok: false, code: 'UNKNOWN_TOOL', error: `Unknown YGO tool: ${name}` });
  }

  try {
    const response = await engineClient.execute({ name, input: args }, { sessionId: SESSION_ID });
    const text = JSON.stringify(response, (key, value) =>
      key === 'sessionId' || key === 'toolCallId' ? undefined : value,
    );

    if (response?.ok === false) {
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return toolError({
      ok: false,
      code: 'ENGINE_HOST_FAILURE',
      error: error instanceof Error ? error.message : String(error),
      hint: 'The persistent engine host is unreachable or died. The next YGO tool call auto-starts a fresh host (previous sessions are lost). Call manageEngineSession with action:"status"; if it is still gone, reload the deck via manageSessionDeck action:"set" before continuing.',
    });
  }
});

function toolError(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
